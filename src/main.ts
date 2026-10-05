import './styles.css';
import { enablePhotoViewer } from './photos/viewer';
import 'maplibre-gl/dist/maplibre-gl.css';
import { appAssetUrl, language, t } from './i18n';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(appAssetUrl('sw.js'), { scope: appAssetUrl('') });
  });
}

import { MapView } from './map/map-view';
import { tagKeys, tagValues } from './map/tag-options';
import { GeolocationTracker } from './capture/geolocation-tracker';
import { OrientationTracker } from './capture/orientation';
import { POSITION_QUALITY_LABEL } from './types';
import { capturePhoto, restorePhotoGps } from './capture/photo';
import { pickPhotoFile, pickPhotoFiles, supportsPhotoFilePicker } from './capture/photo-picker';
import { InAppCamera } from './capture/inapp-camera';
import {
  requestOneShotFix,
  withTimeout,
  classifyGps,
  formatGpsStatus,
  describeCameraPosition,
  type OneShotFix
} from './capture/camera-position';
import { surveyDb } from './db/survey-db';
import { canGroupCandidates, groupEvidence, mergeCandidateGroup } from './analysis/candidate-group';
import { SurveyAnalysisPipeline } from './analysis/pipeline';
import { BrowserVision } from './analysis/browser-vision/client';
import { BROWSER_VISION_VERSION, browserVisionConfig, requiresPhotoReview } from './analysis/browser-vision/policy';
import { OpenAIVisionAnalyzer } from './analysis/openai-analyzer';
import { loadProxySettings, saveProxySettings } from './analysis/proxy-settings';
import type { ImageObservationAnalyzer } from './analysis/analyzer';
import { annotateCandidate, fetchOsmInArea, type LatLon } from './osm/overpass';
import { buildOsmChange } from './osm/osmchange';
import { validateCandidateExport } from './analysis/export-validation';
import { fetchLiveObject, type LiveOsmObject } from './osm/osm-api';
import {
  applyMappingToTags,
  FEATURE_CLASSES,
  commonValuesFor,
  findChosenMapping,
  getFeatureClass,
  geometryPreferenceFor,
  mappingsFor,
  suggestedTagsFor,
  type OsmMapping
} from './analysis/feature-classes';
import { refinePosition } from './analysis/structural-refine';
import { decideSnap } from './analysis/snap-decision';
import { distanceMeters, estimatePosition, imageBearing, rayFromPhoto } from './analysis/position';
import { mergeCandidateWithOsm } from './osm/merge-candidate';
import { pinUndoBefore, restorePinUndo, type PinUndo } from './map/pin-undo';
import { selectProvider } from './imagery/providers';
import type {
  CandidateStatus,
  FeatureCandidate,
  Photo,
  Observation,
  OsmMatch,
  PositionSolution,
  Survey,
  AnalysisResult,
  PhotoAnalysisStatus
} from './types';

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

type ElAttrs = Record<string, string | number | boolean | ((e: Event) => void) | null | undefined>;

const TAG_TYPES = {
  input: HTMLInputElement,
  select: HTMLSelectElement,
  textarea: HTMLTextAreaElement,
  button: HTMLButtonElement,
} as const;

type TagEl<K extends string> = K extends keyof typeof TAG_TYPES ? InstanceType<(typeof TAG_TYPES)[K]> : HTMLElement;

function el<K extends string>(tag: K, attrs: ElAttrs = {}, ...children: Array<Node | string>): TagEl<K> {
  const node = document.createElement(tag) as TagEl<K>;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, v === true ? '' : ['placeholder', 'title', 'aria-label', 'alt'].includes(k) ? t(String(v)) : String(v));
    }
  }
  for (const c of children) appendLocalized(node, typeof c === 'string' ? document.createTextNode(t(c)) : c);
  if (node instanceof HTMLImageElement && String(attrs.src ?? '').startsWith('data:image/')) enablePhotoViewer(node);
  return node;
}

function appendLocalized(parent: HTMLElement, ...children: Array<Node | string>): void {
  parent.append(...children.map((child) => typeof child === 'string' ? t(child) : child));
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = t(msg);
  node.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2800);
}

function confSpan(kind: string, value: number): HTMLElement {
  return el(
    'span',
    { class: 'conf' + (value < 0.5 ? ' low' : ''), title: `${kind} confidence` },
    `${t(kind)} ${Math.round(value * 100)}%`
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

type Mode = 'list' | 'survey' | 'camera' | 'analysis' | 'review' | 'upload';

class App {
  private mapView: MapView;
  private content: HTMLElement;
  private bottombar: HTMLElement;
  private title: HTMLElement;
  private backBtn: HTMLElement;

  private mode: Mode = 'list';
  private survey: Survey | null = null;
  private tracker: GeolocationTracker | null = null;
  /** Live orientation tracker (issue #3 blocker 1). Started from the photo
   *  button (user gesture — required for the iOS permission prompt); read
   *  synchronously at capture time. */
  private orientationTracker = new OrientationTracker();
  /** Issue #13 phase 1: epoch ms when the external camera/file picker was
   *  launched (recorded in the photo button's user gesture). Orientation
   *  readings older than this are rejected as shutter-time camera-bearing
   *  evidence. Cleared after each capture. */
  private pickerLaunchTs: number | undefined = undefined;
  /** One-shot GPS fix started in the photo button's gesture (issue #10). */
  private pendingFix: Promise<OneShotFix | null> | null = null;
  /** In-app camera (issue #13 phase 2): frame + orientation are captured
   *  at the shutter moment. */
  private inappCamera = new InAppCamera();
  /** One-shot GPS fix started when the in-app camera mode was opened
   *  (user gesture). Awaited with a short bound at the shutter. */
  private inappFix: Promise<OneShotFix | null> | null = null;
  private gpsStatus: HTMLElement;
  private gpsState: 'acquiring' | 'unavailable' | 'active' = 'acquiring';
  private gpsTickTimer: number | undefined;
  private analyzing = false;
  private browserVision = new BrowserVision();
  private placingCandidate = false;
  private placingExistingCandidateId: string | null = null;
  private selectedFieldCandidateId: string | null = null;
  private selectedFieldPhotoId: string | null = null;
  private pinHistory = new Map<string, PinUndo[]>();
  private undoBusy = false;
  private undoButton: HTMLButtonElement;

  /** Issue #2: batch analysis state.
   *  Issue #12: openaiMode selects the transport. 'proxy' is the
   *  RECOMMENDED production path (the OpenAI key lives on the proxy,
   *  never in the browser). 'direct' is EXPERIMENTAL / developer-only:
   *  the user's own key is held in memory for this session only and is
   *  NEVER persisted, logged, exported, or sent anywhere except the
   *  request to api.openai.com.
   *  analysisStatuses/analysisProgress: live batch progress + per-photo
   *  errors (partial failure is visible and retryable). */
  private openaiMode: 'proxy' | 'direct' = 'proxy';
  private openaiKey = '';
  private openaiProxyEndpoint = 'https://osm-photo-mapper-proxy.openacrossbase.workers.dev/v1/responses';
  private openaiProxyAuth = '';
  private proxySettingsAvailable = true;
  private openaiModel = '';
  private analysisStatuses: PhotoAnalysisStatus[] = [];
  private analysisProgress = '';
  private analysisResult: AnalysisResult | null = null;

  constructor() {
    const savedProxy = loadProxySettings(this.proxyStorage());
    this.proxySettingsAvailable = savedProxy.available;
    if (savedProxy.settings) {
      this.openaiProxyEndpoint = savedProxy.settings.endpoint.trim() || this.openaiProxyEndpoint;
      this.openaiProxyAuth = savedProxy.settings.token;
    }
    const app = document.getElementById('app');
    if (!app) throw new Error('#app missing');

    this.backBtn = el('button', {
      id: 'back-btn',
      class: 'icon-btn hidden',
      'aria-label': 'Back',
      onclick: () => void this.goBack()
    }, '←');
    this.title = el('h1', { id: 'title' }, 'OSM Photo Mapper');
    const header = el('header', { class: 'topbar' }, this.backBtn, this.title,
      el('a', { class: 'language-link', href: appAssetUrl(language === 'ja' ? 'en/' : ''), lang: language === 'ja' ? 'en' : 'ja' }, language === 'ja' ? 'English' : '日本語'));

    this.gpsStatus = el('div', { id: 'gps-status', class: 'gps-status hidden', role: 'status' });
    this.undoButton = el('button', { class: 'btn pin-undo', disabled: true, onclick: () => void this.undoPinEdit() }, 'Undo');
    const mapWrap = el('div', { id: 'map-wrap' }, el('div', { id: 'map' }), this.gpsStatus, this.undoButton);

    this.content = el('div', { id: 'content' });
    this.bottombar = el('div', { id: 'bottombar' });

    appendLocalized(app, header, mapWrap, this.content, this.bottombar, el('div', { id: 'toast' }));

    this.mapView = new MapView(
      document.getElementById('map') as HTMLElement,
      (id, lat, lon) => void this.onPinDragged(id, lat, lon),
      (lat, lon) => void this.onMapSelected(lat, lon),
      (id) => void this.selectFieldCandidate(id),
      (id) => void this.selectFieldPhoto(id)
    );

    // Issue #6: a persisted `recording=true` flag from a crashed session is
    // stale — recording is a RUNTIME state that only exists while a live
    // GeolocationTracker is active. Repair old records at startup so the
    // survey list never shows a phantom "recording" status.
    void this.repairStaleRecordingFlags();

    this.render();
  }

  private proxyStorage(): Storage | null {
    try { return window.localStorage; } catch { return null; }
  }

  private persistProxySettings(): void {
    this.proxySettingsAvailable = saveProxySettings(this.proxyStorage(), {
      endpoint: this.openaiProxyEndpoint,
      token: this.openaiProxyAuth
    });
    this.updateProxyStorageNote();
  }

  private updateProxyStorageNote(): void {
    const note = this.content.querySelector<HTMLElement>('#proxy-storage-note');
    if (note) note.textContent = t(this.proxySettingsAvailable
      ? 'Proxy settings entered here are saved on this device. A saved token grants use of the proxy; do not use this on a shared device.'
      : 'Device storage is unavailable. Proxy settings are held in memory and will be lost on reload.');
  }

  /** Reset any persisted `recording` flags left behind by crashed sessions. */
  private async repairStaleRecordingFlags(): Promise<void> {
    try {
      const metas = await surveyDb.listSurveys();
      for (const meta of metas) {
        if (meta.recording) {
          meta.recording = false;
          await surveyDb.saveSurveyMeta({
            ...meta,
            gpsSamples: [],
            photos: [],
            candidates: []
          });
        }
      }
    } catch {
      // DB unavailable (e.g. private browsing): nothing to repair.
    }
  }

  /* ---------------- navigation ---------------- */

  private setMode(mode: Mode, title: string): void {
    this.mode = mode;
    document.body.dataset.mode = mode;
    this.title.textContent = t(title);
    this.backBtn.classList.toggle('hidden', mode === 'list');
    if (mode !== 'survey') {
      this.content.classList.remove('field-inspector', 'open');
      this.content.style.bottom = '';
    }
    this.updateUndoButton();
    this.mapView.setSelectedCandidate(this.selectedFieldCandidateId);
    if (mode === 'list') this.stopGpsStatus();
    else this.startGpsStatus();
    requestAnimationFrame(() => this.mapView.map.resize());
  }

  private render(): void {
    switch (this.mode) {
      case 'list':
        void this.renderSurveyList();
        break;
      case 'survey':
        this.renderSurveyScreen();
        break;
      case 'camera':
        this.renderCameraScreen();
        break;
      case 'analysis':
        this.renderAnalysisScreen();
        break;
      case 'review':
        void this.renderReviewScreen();
        break;
      case 'upload':
        this.renderUploadScreen();
        break;
    }
  }

  private goBack(): void {
    if (this.analyzing) return;
    switch (this.mode) {
      case 'survey':
        this.stopRecordingNow();
        this.mode = 'list';
        this.render();
        break;
      case 'camera':
        this.stopInAppCamera();
        this.mode = 'survey';
        this.render();
        break;
      case 'analysis':
        this.mode = 'survey';
        this.render();
        break;
      case 'review':
        this.mode = 'analysis';
        this.render();
        break;
      case 'upload':
        this.mode = 'review';
        this.render();
        break;
      case 'list':
        break;
    }
  }

  /* ---------------- survey list ---------------- */

  private async renderSurveyList(): Promise<void> {
    this.setMode('list', 'OSM Photo Mapper');
    this.bottombar.replaceChildren(
      el('button', { class: 'btn primary', onclick: () => void this.newSurvey('live') }, 'Field survey (live mode)'),
      el('button', { class: 'btn primary', onclick: () => void this.newSurvey('static') }, 'Photo analysis (static mode)')
    );

    const metas = await surveyDb.listSurveys();
    if (metas.length === 0) {
      this.content.replaceChildren(
        el(
          'div',
          { class: 'empty-hint' },
          'Choose live mode to take photos with the camera, or static mode to select existing photos.'
        )
      );
      return;
    }

    const items = await Promise.all(
      metas.map(async (meta) => {
        // Assemble the full survey from the normalized child stores.
        // Fallback for an orphaned meta row: empty child arrays.
        const full =
          (await surveyDb.loadSurvey(meta.id)) ?? {
            ...meta,
            gpsSamples: [],
            photos: [],
            candidates: []
          };
        return el(
          'div',
          { class: 'survey-item', onclick: () => void this.openSurvey(full) },
          el(
            'div',
            { class: 'meta' },
            el('div', { class: 'name' }, full.name),
            el('div', { class: 'sub' }, full.captureMode === 'static' ? 'Photo analysis (static mode)' : 'Field survey (live mode)'),
            el(
              'div',
              { class: 'sub' },
              `${new Date(full.createdAt).toLocaleString()} · ${full.photos.length} photo(s) · ${full.candidates.length} candidate(s)`
            )
          ),
          el(
            'button',
            {
              class: 'del',
              'aria-label': 'Delete survey',
              onclick: (e) => void this.deleteSurvey(meta.id, e)
            },
            '🗑'
          )
        );
      })
    );
    this.content.replaceChildren(el('div', { class: 'section-title' }, 'Surveys'), ...items);
  }

  private async newSurvey(captureMode: 'live' | 'static'): Promise<void> {
    const survey: Survey = {
      id: `survey-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      captureMode,
      name: `${t(captureMode === 'live' ? 'Field survey (live mode)' : 'Photo analysis (static mode)')} ${new Date().toLocaleDateString()}`,
      createdAt: Date.now(),
      gpsSamples: [],
      photos: [],
      candidates: [],
      recording: false
    };
    await surveyDb.createSurvey(survey);
    this.survey = survey;
    this.selectedFieldCandidateId = null;
    this.selectedFieldPhotoId = null;
    this.mode = 'survey';
    void this.startSurveyGps();
    // Issue #3: request orientation access at survey start (this is a
    // user gesture, satisfying the iOS requirement) so the
    // OrientationTracker — the single normalized orientation path — is
    // live BEFORE the first photo, not only when the photo button is
    // pressed. Idempotent; the photo button calls it again.
    if (this.survey?.captureMode !== 'static') this.orientationTracker.start();
    this.render();
  }

  private async openSurvey(survey: Survey): Promise<void> {
    this.survey = survey;
    this.selectedFieldCandidateId = null;
    this.selectedFieldPhotoId = null;
    void this.startSurveyGps();
    // Issue #3: ensure the normalized orientation path is live when the
    // survey opens (user gesture; idempotent), so camera headings are
    // available from the very first capture.
    if (survey.captureMode !== 'static') this.orientationTracker.start();
    this.mode = 'survey';
    this.render();
  }

  private async deleteSurvey(id: string, e: Event): Promise<void> {
    e.stopPropagation();
    if (!window.confirm(t('Delete this survey and all of its data?'))) return;
    await surveyDb.deleteSurvey(id);
    this.renderSurveyList();
  }

  /* ---------------- survey (field) screen ---------------- */

  private renderSurveyScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('survey', s.name);

    this.mapView.setTrack(s);
    this.mapView.setPhotos(s.photos);
    this.mapView.setCandidates(s.candidates);
    requestAnimationFrame(() => {
      if (this.mode !== 'survey' || this.survey?.id !== s.id) return;
      this.mapView.map.resize();
      this.mapView.fitToSurvey(s);
    });

    const last = s.gpsSamples[s.gpsSamples.length - 1];
    if (s.gpsSamples.length === 1 && last) {
      this.mapView.map.jumpTo({ center: [last.lon, last.lat], zoom: 17 });
    }

    const photoInput = el('input', {
      type: 'file',
      multiple: true,
      // Read selected files directly; mobile providers may redact EXIF GPS.
      accept: '*/*',
      style: 'display:none',
      onchange: () => void this.onPhotoTaken(photoInput)
    });
    const note = el('input', { id: 'photo-note', class: 'note-input', placeholder: 'Note (e.g. bench)' });
    const camBtn = el(
      'button',
      {
        class: 'btn accent',
        title: 'Photo file selection is recommended for PC. On phones, GPS metadata may be hidden; place the photo on the map if needed.',
        onclick: () => {
          const selection = pickPhotoFiles(() => photoInput.click());
          this.pendingFix = null;
          this.pickerLaunchTs = undefined;
          void selection.then((files) => {
            if (files && this.survey?.id === s.id && this.mode !== 'list') return this.onPhotoFiles(files, 'file-system-access');
            if (files === null) {
              this.pendingFix = null;
              this.pickerLaunchTs = undefined;
            }
          }).catch((error) => {
            this.pendingFix = null;
            this.pickerLaunchTs = undefined;
            toast(`Photo failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
      '📷 Photo'
    );
    const mapBtn = el(
      'button',
      {
        id: 'map-btn',
        class: 'btn primary',
        disabled: s.photos.length === 0,
        // Issue #2: go to the analysis screen (analyzer selection, BYOK
        // config, batch progress/retry) BEFORE any analysis runs.
        onclick: () => {
          this.stopInAppCamera();
          this.mode = 'analysis';
          this.render();
        }
      },
      'Map photos'
    );

    // Issue #13 phase 2: in-app camera — frame + orientation are captured
    // at the shutter moment (only offered where getUserMedia exists).
    const inappBtn = el(
      'button',
      { class: 'btn', disabled: !InAppCamera.available(), onclick: () => void this.openInAppCamera() },
      '📸 In-app'
    );

    this.bottombar.replaceChildren(
      ...(s.captureMode === 'static' ? [camBtn] : [inappBtn]),
      note,
      mapBtn,
      photoInput
    );

    void this.renderFieldInspector();

    // Issue #10: keep the GPS readiness indicator live on the field
    // screen, independent of Record mode.
  }

  private selectFieldCandidate(id: string, scrollToCard = true): void {
    if ((this.mode !== 'survey' && this.mode !== 'review') || !this.survey?.candidates.some((c) => c.id === id)) return;
    const changed = this.selectedFieldCandidateId !== id;
    this.selectedFieldCandidateId = id;
    this.selectedFieldPhotoId = null;
    this.mapView.setSelectedCandidate(id);
    const candidate = this.survey.candidates.find((c) => c.id === id);
    if (this.mode === 'survey' && !changed) return;
    if (this.mode === 'review') {
      for (const card of this.content.querySelectorAll<HTMLElement>('.candidate[data-candidate-id]')) {
        const selected = card.dataset.candidateId === id;
        card.classList.toggle('selected', selected);
        if (selected && scrollToCard) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if (changed && !scrollToCard && candidate?.lat != null && candidate.lon != null) {
        this.mapView.map.easeTo({ center: [candidate.lon, candidate.lat], duration: 250 });
      }
      return;
    }
    void this.renderFieldInspector().then(() => {
      if (this.mode === 'survey' && candidate?.lat != null && candidate.lon != null) {
        this.mapView.map.easeTo({ center: [candidate.lon, candidate.lat], offset: [0, -Math.round(window.innerHeight * 0.22)], duration: 250 });
      }
    });
  }

  private selectFieldPhoto(id: string): void {
    if (this.mode !== 'survey' || !this.survey?.photos.some((p) => p.id === id)) return;
    this.selectedFieldPhotoId = id;
    this.selectedFieldCandidateId = null;
    this.mapView.setSelectedCandidate(null);
    const photo = this.survey.photos.find((p) => p.id === id);
    void this.renderFieldInspector().then(() => {
      if (this.mode === 'survey' && photo?.gps) {
        this.mapView.map.easeTo({ center: [photo.gps.lon, photo.gps.lat], offset: [0, -Math.round(window.innerHeight * 0.22)], duration: 250 });
      }
    });
  }

  private async renderFieldInspector(): Promise<void> {
    const s = this.survey;
    if (this.mode !== 'survey' || !s) return;
    const previousScroll = this.content.querySelector<HTMLElement>('.field-details')?.scrollTop ?? 0;
    const observations = await surveyDb.listObservations(s.id);
    if (this.mode !== 'survey' || this.survey?.id !== s.id) return;
    const photoByObs = this.photosForObservations(s, observations);
    const obsById = new Map(observations.map((obs) => [obs.id, obs]));
    const candidate = s.candidates.find((c) => c.id === this.selectedFieldCandidateId);
    const photo = s.photos.find((p) => p.id === this.selectedFieldPhotoId);
    const open = !!candidate || !!photo;
    const strip = el('div', { class: 'field-strip' },
      el('span', { class: 'field-strip-title' }, `Photos (${s.photos.length})`),
      ...(s.captureMode === 'static' ? [el('span', { class: 'hint photo-picker-status', title: 'Photo file selection is recommended for PC. On phones, GPS metadata may be hidden; place the photo on the map if needed.' }, 'Photo file selection: recommended for PC')] : []),
      ...s.photos.map((p, index) => el('div', { class: 'photo-frame photo-thumbnail' },
        el('button', {
          class: 'field-photo-button' + (photo?.id === p.id ? ' selected' : ''),
          'aria-label': `Open photo ${index + 1}`,
          onclick: () => this.selectFieldPhoto(p.id)
        }, p.image ? el('img', { src: p.image, alt: '' }) : `Photo ${index + 1}`),
        this.photoDetailsButton(p, true)
      )),
      ...s.candidates.map((c, index) => el('button', {
        class: 'btn small' + (candidate?.id === c.id ? ' selected' : ''),
        onclick: () => this.selectFieldCandidate(c.id)
      }, `${index + 1}: ${getFeatureClass(c.featureType)?.label ?? c.featureType}`)),
      ...(open ? [el('button', { class: 'btn small', 'aria-label': 'Close inspector', onclick: () => {
        this.selectedFieldCandidateId = null;
        this.selectedFieldPhotoId = null;
        this.mapView.setSelectedCandidate(null);
        void this.renderFieldInspector();
      } }, 'Close')]: [])
    );
    const details = el('div', { class: 'field-details' });
    if (candidate) {
      if (candidate.analyzer !== 'openai' && candidate.analyzer !== 'manual') {
        appendLocalized(details, el('div', { class: 'demo-banner' }, 'Saved analysis is unverified — re-analyze photos with OpenAI before exporting'));
      }
      appendLocalized(details, this.buildCandidateCard(candidate, photoByObs, obsById));
    } else if (photo) {
      const related = s.candidates.filter((c) => c.observationIds.some((id) => obsById.get(id)?.photoId === photo.id));
      appendLocalized(details,
        el('div', { class: 'candidate' },
          el('div', { class: 'head' }, el('strong', {}, 'Photo')),
          ...(photo.image ? [el('div', { class: 'photo-frame' }, el('img', { class: 'field-photo-full', src: photo.image, alt: 'Captured source photo' }), this.photoDetailsButton(photo))] : [this.photoDetailsButton(photo)]),
          el('div', { class: 'row' }, `Note: ${photo.note || 'none'}`),
          el('div', { class: 'row' }, `Associated candidates: ${related.length}`),
          ...related.map((c) => el('button', { class: 'btn small', onclick: () => this.selectFieldCandidate(c.id) },
            getFeatureClass(c.featureType)?.label ?? c.featureType))
        )
      );
    }
    this.content.classList.add('field-inspector');
    this.content.classList.toggle('open', open);
    this.content.style.bottom = `${this.bottombar.getBoundingClientRect().height}px`;
    this.content.replaceChildren(strip, details);
    details.scrollTop = previousScroll;
  }

  private async startSurveyGps(): Promise<void> {
    const survey = this.survey;
    if (!survey || survey.captureMode === 'static' || this.tracker) return;
    this.gpsState = 'acquiring';
    survey.recording = false;
    const tracker = new GeolocationTracker(survey.id, (sample) => {
      if (this.tracker !== tracker || this.survey?.id !== survey.id) return;
      this.survey.gpsSamples.push(sample);
      if (!this.survey.recording) {
        this.survey.recording = true;
        void surveyDb.saveSurveyMeta(this.survey);
      }
      this.gpsState = 'active';
      this.mapView.setTrack(this.survey);
      this.refreshGpsStatus();
    }, () => {
      if (this.tracker !== tracker) return;
      this.gpsState = 'unavailable';
      if (this.survey) {
        this.survey.recording = false;
        void surveyDb.saveSurveyMeta(this.survey);
      }
      this.refreshGpsStatus();
    });
    this.tracker = tracker;
    try {
      await tracker.start();
      if (this.tracker !== tracker || this.survey?.id !== survey.id) return;
      this.survey.recording = true;
      await surveyDb.saveSurveyMeta(this.survey);
    } catch {
      if (this.tracker !== tracker) return;
      this.gpsState = 'unavailable';
      if (this.survey) {
        this.survey.recording = false;
        void surveyDb.saveSurveyMeta(this.survey);
      }
    }
    this.refreshGpsStatus();
  }

  private stopRecordingNow(): void {
    this.tracker?.stop();
    this.tracker = null;
    if (this.survey) {
      this.survey.recording = false;
      void surveyDb.saveSurveyMeta(this.survey);
    }
  }

  /* ---------------- GPS readiness status (issue #10) ---------------- */

  /** Refresh the automatic survey GPS indicator without starting another watch. */
  private startGpsStatus(): void {
    this.gpsStatus.classList.remove('hidden');
    window.clearInterval(this.gpsTickTimer);
    this.gpsTickTimer = window.setInterval(() => this.refreshGpsStatus(), 1000);
    this.refreshGpsStatus();
  }

  private stopGpsStatus(): void {
    window.clearInterval(this.gpsTickTimer);
    this.gpsTickTimer = undefined;
    this.gpsStatus.classList.add('hidden');
  }

  private refreshGpsStatus(): void {
    const s = this.survey;
    if (!s) return;
    if (s.captureMode === 'static') {
      this.gpsStatus.classList.add('hidden');
      return;
    }
    const now = Date.now();
    // While recording, the newest track sample IS the live fix.
    const last = s.gpsSamples[s.gpsSamples.length - 1];
    const fromTrack = this.tracker != null && last != null;
    const fix: OneShotFix | null = fromTrack
      ? { lat: last.lat, lon: last.lon, accuracy: last.accuracy, timestamp: last.timestamp }
      : null;
    const state = classifyGps(fix, now);
    const label = this.gpsState === 'acquiring' ? 'GPS acquiring…'
      : this.gpsState === 'unavailable' ? 'GPS unavailable'
      : state === 'ready' ? 'GPS on' : state === 'coarse' ? 'GPS coarse' : 'GPS stale';
    this.gpsStatus.textContent = t(label) + (fix && this.gpsState === 'active' && fix.accuracy != null
      ? ` · ±${Math.round(fix.accuracy)} m` : '');
    this.gpsStatus.title = this.gpsState === 'active'
      ? t(formatGpsStatus(fix, now, s.gpsSamples.length, 'track'))
      : `${t(label)} · ${t(`GPS track: ${s.gpsSamples.length} samples`)}`;
    this.gpsStatus.className = `gps-status gps-${this.gpsState === 'active' ? state : this.gpsState}`;
  }

  private async onPhotoTaken(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.onPhotoFiles(files);
  }

  private async onPhotoFiles(files: File[], selectionMethod: 'file-system-access' | 'file-input' = 'file-input'): Promise<void> {
    const survey = this.survey;
    for (const file of files) {
      if (!survey || this.survey !== survey || this.mode === 'list') break;
      await this.onPhotoFile(file, selectionMethod);
    }
  }

  private async onPhotoFile(file: File, selectionMethod: 'file-system-access' | 'file-input' = 'file-input'): Promise<void> {
    const s = this.survey;
    if (!s) return;
    if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif|avif|gif|bmp|tiff?)$/i.test(file.name)) {
      toast('Select an image file');
      return;
    }

    const noteEl = this.bottombar.querySelector<HTMLInputElement>('#photo-note');
    try {
      // Issue #10: the one-shot fix was started in the SAME user gesture as
      // the file input (see the photo button handler). Give it a bounded
      // wait — the capture must not be held hostage by a slow or denied
      // geolocation request — then fall through to EXIF/none.
      const captureFix = this.pendingFix ? await withTimeout(this.pendingFix, 8000, null) : null;
      this.pendingFix = null;

      // Issue #6: the photo's timestamp comes from EXIF / file metadata (the
      // true capture time, not "now"). Issue #10: its camera position at
      // THAT moment is resolved with explicit provenance (track >
      // capture-time fix > EXIF); a stale track endpoint is never attached.
      const photo = await capturePhoto({
        surveyId: s.id,
        file,
        selectionMethod,
        track: s.gpsSamples,
        captureFix,
        // Issue #3 blocker 1: a normalized reading WITH QUALITY replaces the
        // raw number — the estimator weights the heading by its quality.
        orientation: this.orientationTracker.read(),
        // Issue #13 phase 1: readings older than the picker launch are
        // pre-camera evidence and are rejected (see associateCameraHeading).
        pickerLaunchTs: this.pickerLaunchTs,
        note: noteEl?.value.trim() || undefined
      });
      this.pickerLaunchTs = undefined;
      s.photos.push(photo);
      this.selectedFieldPhotoId = photo.id;
      this.selectedFieldCandidateId = null;
      this.mapView.setPhotos(s.photos);
      if (this.mode === 'survey' && this.survey?.id === s.id) await this.renderFieldInspector();
      if (photo.gps) this.mapView.map.jumpTo({ center: [photo.gps.lon, photo.gps.lat], zoom: 18 });
      this.refreshGpsStatus();
      if (noteEl) noteEl.value = '';
      // Issue #3/#13: the toast states the timestamp source, position
      // provenance, and the bearing outcome (or why it is missing) — a
      // silent evidence gap would hide the loss.
      toast(this.describePhotoCaptured(photo, s.photos.length));
      const mapBtn = this.bottombar.querySelector<HTMLButtonElement>('#map-btn');
      if (mapBtn) mapBtn.disabled = false;
    } catch (e) {
      toast(`Photo failed: ${(e as Error).message}`);
    }
  }

  /** Shared post-capture toast (issue #3): states the timestamp source,
   *  camera-position provenance, and the camera-bearing outcome (or the
   *  explicit reason it is missing) — a silent evidence gap is a bug. */
  private describePhotoCaptured(photo: Photo, count: number): string {
    const srcNote =
      photo.timestampSource && photo.timestampSource !== 'exif' ? ` [${photo.timestampSource} time]` : '';
    const camNote = photo.cameraPosition
      ? ` · cam: ${t(describeCameraPosition(photo.cameraPosition))} ${photo.cameraPosition.lat.toFixed(5)}, ${photo.cameraPosition.lon.toFixed(5)}`
      : ` · ${t('Photo has no GPS. Select the original file from Files, or place its pin manually.')}`;
    let hdgNote = '';
    if (photo.cameraHeading) {
      const ch = photo.cameraHeading;
      hdgNote = ` · ${t('Cam heading')} ${ch.bearing.toFixed(0)}° (${t(ch.source)}, ±${ch.uncertaintyDeg}°, ${t(`age ${Math.round(ch.ageMs / 1000)} s`)})`;
    } else {
      hdgNote = ` · ${t('No camera heading')}${photo.headingNote ? `: ${t(photo.headingNote)}` : ''}`;
    }
    return `${t(`Photo captured (${count})`)}${srcNote}${camNote}${hdgNote}`;
  }

  /* ---------------- in-app camera (issue #13, phase 2) ---------------- */

  /** Open the in-app camera. Everything that needs user activation starts
   *  in this ONE gesture: the orientation tracker (iOS permission), the
   *  one-shot GPS fix, and the camera permission. */
  private async openInAppCamera(): Promise<void> {
    const s = this.survey;
    if (!s || this.inappCamera.active) return;
    this.orientationTracker.start();
    this.inappFix = requestOneShotFix(15_000);
    this.mode = 'camera';
    this.render();
    const video = this.content.querySelector<HTMLVideoElement>('#inapp-video');
    if (!video) return;
    try {
      await this.inappCamera.start(video);
    } catch (e) {
      toast(`In-app camera unavailable: ${(e as Error).message}`);
      this.stopInAppCamera();
      this.mode = 'survey';
      this.render();
    }
  }

  private renderCameraScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('camera', s.name);

    // The map is hidden in camera mode (CSS) — the viewfinder takes the
    // screen. Photos taken here still land on the map via setPhotos.
    this.mapView.setTrack(s);
    this.mapView.setPhotos(s.photos);

    const video = el('video', {
      id: 'inapp-video',
      class: 'inapp-video',
      playsinline: true,
      autoplay: true,
      muted: true
    });

    // Evidence status BEFORE capture: what bearing/position will the
    // shutter actually record? (Issue #13: make missing evidence explicit
    // before it is lost, not after.)
    const orReading = this.orientationTracker.read();
    const orientLine = orReading
      ? `Orientation: ${orReading.quality} — ${orReading.detail}`
      : 'Orientation: no reading yet — in-app photos will lack a camera bearing';
    const gpsLine =
      s.gpsSamples.length > 0
        ? `GPS: ${s.gpsSamples.length} track sample(s)` + (this.tracker ? ' (recording)' : '')
        : 'GPS: no track — position evidence limited to the one-shot fix';

    const shutterBtn = el(
      'button',
      {
        id: 'shutter-btn',
        class: 'shutter-btn',
        'aria-label': 'Capture photo',
        onclick: () => void this.onInAppShutter()
      },
      '⬤'
    );

    // Fallback to the external OS camera (file input), reusing the issue
    // #13 phase 1 picker-launch gating of the survey screen's photo flow.
    const photoInput = el('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      style: 'display:none',
      onchange: () => void this.onPhotoTaken(photoInput)
    });
    const osCamBtn = el(
      'button',
      {
        class: 'btn',
        onclick: () => {
          this.pendingFix = requestOneShotFix(15_000);
          this.orientationTracker.start();
          this.pickerLaunchTs = Date.now();
          photoInput.click();
        }
      },
      '📷 OS camera'
    );
    const mapBtn = el(
      'button',
      {
        id: 'map-btn',
        class: 'btn primary',
        disabled: s.photos.length === 0,
        onclick: () => {
          this.stopInAppCamera();
          this.mode = 'analysis';
          this.render();
        }
      },
      'Map photos'
    );

    this.content.replaceChildren(
      video,
      el('div', { class: 'camera-status' }, el('div', {}, orientLine), el('div', {}, gpsLine)),
      shutterBtn,
      el('div', { id: 'camera-photos' }, this.buildPhotoGallery(s.photos))
    );
    this.bottombar.replaceChildren(osCamBtn, mapBtn, photoInput);
  }

  /** Shutter gesture (issue #13 phase 2): timestamp, orientation reading
   *  and the frame are all captured IN THIS moment. The orientation
   *  reading is read synchronously first, so its freshness relative to
   *  the shutter instant is ~0 ms and the gate trivially passes. The
   *  one-shot fix started at mode entry is awaited with a SHORT bound —
   *  the shutter is never held hostage by a slow GPS lock. */
  private async onInAppShutter(): Promise<void> {
    const s = this.survey;
    if (!s) return;
    const btn = this.content.querySelector<HTMLButtonElement>('#shutter-btn');
    if (btn) btn.disabled = true;
    try {
      const ts = Date.now();
      const orientation = this.orientationTracker.read();
      const image = this.inappCamera.captureFrame(1024, 0.72);

      const captureFix = this.inappFix ? await withTimeout(this.inappFix, 1500, null) : null;

      const photo = await capturePhoto({
        surveyId: s.id,
        image,
        timestamp: ts,
        timestampSource: 'shutter',
        track: s.gpsSamples,
        captureFix,
        orientation,
        // In-app capture has no picker launch — the freshness gate runs
        // against the shutter instant itself (pickerLaunchTs undefined).
        note: undefined
      });
      s.photos.push(photo);
      this.selectedFieldPhotoId = photo.id;
      this.selectedFieldCandidateId = null;
      this.content.querySelector('#camera-photos')?.replaceChildren(this.buildPhotoGallery(s.photos));
      this.mapView.setPhotos(s.photos);
      toast(this.describePhotoCaptured(photo, s.photos.length));
      const mapBtn = this.bottombar.querySelector<HTMLButtonElement>('#map-btn');
      if (mapBtn) mapBtn.disabled = false;
    } catch (e) {
      toast(`Photo failed: ${(e as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** Release the camera hardware and the pending fix. */
  private stopInAppCamera(): void {
    this.inappCamera.stop();
    this.inappFix = null;
  }

  /* ---------------- analysis (issue #2) ---------------- */

  /** Build the configured analyzer (issue #2). Returns null (with a
   *  toast) when misconfigured — the batch does not start. */
  private createAnalyzer(): ImageObservationAnalyzer | null {
    const model = this.openaiModel.trim() || undefined;
    // Issue #12 (remaining blocker): production builds are
    // proxy-only. Direct (browser-key) mode is developer-only and
    // must not be reachable from the public app — the analyzer
    // constructor also hard-fails on it (defense in depth).
    if (import.meta.env.PROD && this.openaiMode === 'direct') {
      this.openaiMode = 'proxy';
      toast('Direct (browser-key) mode is disabled in this build (issue #12) — use the proxy endpoint');
      return null;
    }
    if (this.openaiMode === 'proxy') {
      // Recommended production path (issue #12): the browser talks to
      // the user's proxy; the OpenAI key never touches the browser.
      const endpoint = this.openaiProxyEndpoint.trim();
      if (!endpoint) {
        toast('Set the proxy endpoint to use the OpenAI analyzer (recommended mode)');
        return null;
      }
      return new OpenAIVisionAnalyzer({
        mode: 'proxy',
        beforeSend: (photo) => this.checkPhotoBeforeSending(photo),
        endpoint,
        ...(this.openaiProxyAuth.trim() ? { proxyAuth: this.openaiProxyAuth.trim() } : {}),
        ...(model ? { model } : {})
      });
    }
    // Experimental / developer-only: the user's own key is sent from
    // the browser to api.openai.com. In-memory for the session only —
    // this app never stores it (issue #12).
    const key = this.openaiKey.trim();
    if (!key) {
      toast('Enter your OpenAI API key for direct mode — or switch to the recommended proxy mode');
      return null;
    }
    return new OpenAIVisionAnalyzer({
      mode: 'direct',
      beforeSend: (photo) => this.checkPhotoBeforeSending(photo),
      apiKey: key,
      ...(model ? { model } : {})
    });
  }

  /** Run the shared pipeline over the batch (issue #2). Per-photo
   *  failures are recorded, never fatal; `photoIds` re-runs ONLY the
   *  failed photos and merges with the previously saved observations. */
  private async runAnalysis(photoIds?: string[]): Promise<void> {
    const s = this.survey;
    if (!s || this.analyzing) return;
    const analyzer = this.createAnalyzer();
    if (!analyzer) return;

    this.analyzing = true;
    this.analysisStatuses = photoIds
      ? this.analysisStatuses.filter((st) => !photoIds.includes(st.photoId))
      : [];
    this.analysisProgress = `0/${photoIds?.length ?? s.photos.length}`;
    this.analysisResult = null;
    this.updateAnalysisProgressDom();
    this.updateAnalysisResultDom();

    const pipeline = new SurveyAnalysisPipeline(analyzer);
    try {
      const fresh = (await surveyDb.loadSurvey(s.id)) ?? s;

      const result = await pipeline.analyze(fresh, {
        ...(photoIds ? { photoIds } : {}),
        onProgress: (p) => {
          this.analysisStatuses = [...this.analysisStatuses, p.status];
          this.analysisProgress = `${p.index}/${p.total}`;
          this.updateAnalysisProgressDom();
        }
      });

      if (photoIds) {
        // Retry path: merge the new observations with the previously
        // saved ones (dropping the retried photos' stale observations),
        // then rebuild candidates from the merged set — grouping and
        // estimation are pure and provider-agnostic (issue #2).
        const saved = await surveyDb.listObservations(fresh.id);
        const keep = saved.filter((o) => !photoIds.includes(o.photoId));
        result.observations = [...keep, ...result.observations];
        result.candidates = pipeline.buildCandidates(fresh, result.observations);
      }

      const model = analyzer instanceof OpenAIVisionAnalyzer ? analyzer.modelName : undefined;
      for (const obs of result.observations) {
        if (!photoIds || photoIds.includes(obs.photoId)) {
          obs.analyzer = 'openai';
          obs.analyzerModel = model;
        }
      }
      const byId = new Map(result.observations.map((obs) => [obs.id, obs]));
      for (const candidate of result.candidates) {
        const sources = candidate.observationIds.map((id) => byId.get(id)?.analyzer);
        candidate.analyzer = sources.every((source) => source === 'openai') ? 'openai'
          : sources.every((source) => source === 'mock') ? 'mock' : 'mixed';
        const models = [...new Set(candidate.observationIds.map((id) => byId.get(id)?.analyzerModel).filter((value): value is string => !!value))];
        candidate.analyzerModel = models.join(', ') || undefined;
      }

      await this.enrichCandidates(fresh, result.candidates);
      result.candidates.push(...fresh.candidates.filter((c) => c.analyzer === 'manual'));
      await surveyDb.saveAnalysis(fresh.id, result.observations, result.candidates);
      fresh.candidates = result.candidates;
      // Analysis may take minutes while new GPS samples keep arriving.
      fresh.gpsSamples = s.gpsSamples;
      this.pinHistory.delete(fresh.id);
      this.survey = fresh;
      this.analysisResult = result;
      fresh.recording = this.tracker?.isRecording ?? false;

      const failed = result.photoStatuses?.filter((st) => st.status === 'error') ?? [];
      if (failed.length > 0) {
        // Partial success: result saved, failed photos stay visible on
        // this screen with a retry affordance (issue #2).
        this.updateAnalysisProgressDom();
        this.updateAnalysisResultDom();
        toast(`Analysis finished with ${failed.length} failed photo(s)`);
      } else {
        this.mapView.setTrack(fresh);
        this.mapView.setPhotos(fresh.photos);
        this.mapView.setCandidates(fresh.candidates);
        this.mode = 'review';
        this.render();
        toast(`${result.candidates.length} candidate(s) created`);
      }
    } catch (e) {
      toast(`Analysis failed: ${(e as Error).message}`);
    } finally {
      this.analyzing = false;
      this.updateAnalysisProgressDom();
      this.updateAnalysisResultDom();
    }
  }

  /** Post-analysis enrichment (kept OUT of the provider/pipeline by
   *  design — issue #2): nearby OSM lookup (duplicate detection +
   *  position evidence), bounded aerial structural refinement
   *  (issue #8) and conditional OSM snap. Operates on the candidates
   *  and the survey; failures degrade gracefully (the OSM lookup
   *  returns an empty list, imagery refinement is skipped on gap).
   */
  private async enrichCandidates(fresh: Survey, candidates: FeatureCandidate[]): Promise<void> {
    // Nearby OSM lookup (duplicate detection + position evidence).
    // Issue #5: cover the WHOLE surveyed area — track samples, photo
    // positions and candidate positions — in a single bbox query, then
    // score each candidate against nearby objects using ITS OWN feature
    // class. Anchoring to the last GPS point missed objects photographed
    // elsewhere along long walks.
    const anchorPoints: LatLon[] = [
      ...fresh.gpsSamples.map((g) => ({ lat: g.lat, lon: g.lon })),
      ...fresh.photos
        .filter((p) => p.gps)
        .map((p) => ({ lat: p.gps!.lat, lon: p.gps!.lon })),
      ...candidates
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => ({ lat: c.lat!, lon: c.lon! }))
    ];
    const nearby = await fetchOsmInArea(anchorPoints);
    for (const c of candidates) {
      c.osmMatches = annotateCandidate(c, nearby, 120);
    }

      // Issue #8: PositionSolution provenance chain.
      // 1) raw ground-survey estimate (always kept) -> 2) bounded aerial
      // structural refinement (few meters, capped by uncertainty) ->
      // 3) conditional OSM snap (only strong + essentially unique).
    for (const c of candidates) {
      if (c.lat == null || c.lon == null) continue;
        const est = { lat: c.lat, lon: c.lon };
        // Issue #3: the uncertainty is EVIDENCE-DERIVED (GPS accuracy,
        // heading quality, distance uncertainty, staleness, fit error) —
        // not a function of confidence alone.
        const uncertainty = c.positionUncertaintyMeters ?? 3 + (1 - c.positionConfidence) * 30;
        const solution: PositionSolution = {
          estimatedPosition: est,
          uncertaintyMeters: uncertainty,
          positionQuality: c.positionQuality,
          evidence: [
            { source: 'ray-projection', label: `Ray projection (${c.observationIds.length} observation(s))` }
          ]
        };

        // Imagery provider: high-res first, GSI as the nationwide
        // fallback (issue #8). Correction is bounded by the uncertainty
        // and degrades to the raw estimate on any gap/error.
        const provider = selectProvider(est.lat, est.lon);
        const refined = await refinePosition(provider, c.featureType, est.lat, est.lon, uncertainty);
        if (refined) {
          solution.refinedPosition = { lat: refined.lat, lon: refined.lon };
          // A reviewable proposal: applied by default but explicit and
          // reversible in review (issue #8). Provenance carried along.
          solution.refinementApplied = true;
          solution.imagerySource = refined.attribution;
          solution.evidence.push(refined.evidence);
        }

        const base = refined ? { lat: refined.lat, lon: refined.lon } : est;
        const snap = decideSnap({
          lat: base.lat,
          lon: base.lon,
          featureType: c.featureType,
          uncertaintyM: uncertainty,
          matches: c.osmMatches,
          candidateTags: c.tags
        });

        c.positionSolution = solution;

        if (snap) {
          solution.snappedPosition = snap.snappedPosition;
          solution.linkedOsmId = snap.osm.osmId;
          solution.linkedOsmType = snap.osm.osmType;
          solution.snapConfidence = snap.confidence;
          solution.evidence.push(snap.evidence);
          c.lat = snap.snappedPosition.lat;
          c.lon = snap.snappedPosition.lon;
          c.linkedOsmId = snap.osm.osmId;
          c.linkedOsmType = snap.osm.osmType;
          c.status = 'existing';
          c.warnings.push(
            `Snapped to ${snap.osm.osmType}/${snap.osm.osmId} (${Math.round(snap.confidence * 100)}% confidence) — verify the match.`
          );
        } else if (refined) {
          c.lat = base.lat;
          c.lon = base.lon;
          c.warnings.push(
            `Position refined ${refined.deltaM.toFixed(1)} m by aerial structure (${refined.sourceId ?? 'imagery'}) — verify against the photos; reversible in review.`
          );
        }
      }

  }

  /* ---------------- analysis screen ---------------- */

  private renderAnalysisScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('analysis', 'Map photos');

    // Issue #12: transport mode. The proxy is the recommended
    // production path (the OpenAI key lives on the proxy, never in
    // this browser); direct mode is experimental / developer-only and
    // keeps the user's key in memory for the session only — it is
    // never persisted, logged, or exported.
    //
    // Issue #12 (remaining blocker): the PUBLIC (production) build is
    // proxy-only — it never renders the direct-mode radio or the key
    // field, so a browser-side OpenAI secret cannot be accepted.
    // (import.meta.env.PROD is statically true in `vite build`; the
    // dev server and tests keep the developer-only direct option.)
    const isProd = import.meta.env.PROD;
    const authInput = el('input', {
      type: 'password',
      id: 'openai-proxy-auth',
      class: 'note-input',
      placeholder: 'Proxy token (optional)',
      value: this.openaiProxyAuth,
      oninput: () => {
        this.openaiProxyAuth = (authInput as HTMLInputElement).value;
        this.persistProxySettings();
      }
    });
    const modelInput = el('input', {
      type: 'text',
      id: 'openai-model',
      class: 'note-input',
      placeholder: 'Model (default: gpt-6-luna)',
      value: this.openaiModel,
      oninput: () => { this.openaiModel = (modelInput as HTMLInputElement).value; }
    });
    const proxyFields = el(
      'div',
      { class: 'transport-fields', 'data-transport': 'proxy' },
      el('div', { class: 'field' }, el('label', { for: 'openai-proxy-auth' }, 'Proxy token'), authInput),
      el('div', { id: 'proxy-storage-note', class: 'hint warn' })
    );
    const modelField = el('div', { class: 'field' }, el('label', { for: 'openai-model' }, 'Model'), modelInput);
    let openaiPanel: TagEl<'div'>;
    if (isProd) {
      // Public build: proxy-only, no key field (issue #12).
      this.openaiMode = 'proxy';
      openaiPanel = el(
        'div',
        { class: 'analyzer-panel' },
        proxyFields,
        modelField
      );
    } else {
      const modeProxy = el(
        'input',
        {
          type: 'radio',
          name: 'openai-mode',
          value: 'proxy',
          checked: this.openaiMode === 'proxy',
          onchange: () => {
            this.openaiMode = 'proxy';
            openaiPanel.dataset.transport = 'proxy';
          }
        }
      );
      const modeDirect = el(
        'input',
        {
          type: 'radio',
          name: 'openai-mode',
          value: 'direct',
          checked: this.openaiMode === 'direct',
          onchange: () => {
            this.openaiMode = 'direct';
            openaiPanel.dataset.transport = 'direct';
          }
        }
      );
      const keyInput = el('input', {
        type: 'password',
        id: 'openai-key',
        class: 'note-input',
        placeholder: 'OpenAI API key (sk-…)',
        value: this.openaiKey,
        oninput: () => { this.openaiKey = (keyInput as HTMLInputElement).value; }
      });
      openaiPanel = el(
        'div',
        { class: 'analyzer-panel' },
        el(
          'div',
          { class: 'field' },
          el('label', { class: 'radio-row' }, modeProxy, ' Proxy (recommended — key stays on the server)'),
          el('label', { class: 'radio-row' }, modeDirect, ' Direct to OpenAI (experimental, developer-only)')
        ),
        proxyFields,
        el(
          'div',
          { class: 'transport-fields', 'data-transport': 'direct' },
          el('div', { class: 'field' }, el('label', { for: 'openai-key' }, 'API key'), keyInput),
          el(
            'div',
            { class: 'hint warn' },
            'Experimental / developer-only: this sends YOUR key from this browser to api.openai.com. It is kept in memory for this session only — never stored, logged, or exported. For production use, prefer proxy mode.'
          )
        ),
        modelField
      );
      openaiPanel.dataset.transport = this.openaiMode;
    }

    const progressBox = el('div', { id: 'analysis-progress', class: 'analysis-progress' });
    const resultBox = el('div', { id: 'analysis-result', class: 'analysis-result' });

    this.content.replaceChildren(
      el(
        'div',
        { class: 'analysis-screen' },
        openaiPanel,
        this.buildPhotoGallery(s.photos),
        el('div', { class: 'section-title' }, 'Batch progress'),
        progressBox,
        resultBox
      )
    );
    this.content.dataset.analyzer = 'openai';
    this.updateProxyStorageNote();

    this.bottombar.replaceChildren(
      el('button', { class: 'btn', onclick: () => { this.placingCandidate = false; this.mode = 'survey'; this.render(); } }, '← Field'),
      el('button', {
        id: 'analyze-btn',
        class: 'btn primary',
        disabled: this.analyzing || s.photos.length === 0,
        onclick: () => void this.runAnalysis()
      }, 'Analyze photos')
    );

    this.updateAnalysisProgressDom();
    this.updateAnalysisResultDom();
  }

  private updateAnalysisControls(): void {
    const controls = [this.backBtn as HTMLButtonElement, ...this.content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select'),
      ...this.bottombar.querySelectorAll<HTMLButtonElement>('button')];
    for (const control of controls) {
      if (this.analyzing) {
        if (control.dataset.analysisDisabled == null) control.dataset.analysisDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.analysisDisabled != null) {
        control.disabled = control.dataset.analysisDisabled === 'true';
        delete control.dataset.analysisDisabled;
      }
    }
    const button = this.bottombar.querySelector<HTMLButtonElement>('#analyze-btn');
    if (button) button.disabled = this.analyzing || !this.survey?.photos.length;
    this.content.setAttribute('aria-busy', String(this.analyzing));
  }

  /** Live batch progress (issue #2): in-place DOM update so input focus
   *  is preserved while photos are processed one by one. */
  private updateAnalysisProgressDom(): void {
    this.updateAnalysisControls();
    const box = this.content.querySelector<HTMLElement>('#analysis-progress');
    if (!box) return;
    const lines: Node[] = [];
    if (this.analyzing) {
      lines.push(el('div', { class: 'analysis-status running', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'analysis-spinner', 'aria-hidden': 'true' }), `Analyzing ${this.analysisProgress}…`));
    }
    for (const st of this.analysisStatuses) {
      if (st.status === 'ok') {
        lines.push(
          el('div', { class: 'analysis-status ok' },
            `✓ ${st.photoId.slice(0, 8)} — ${st.observationCount ?? 0} object(s)`)
        );
      } else {
        lines.push(
          el('div', { class: 'analysis-status error' },
            `✗ ${st.photoId.slice(0, 8)} — ${st.error ?? 'provider error'}`)
        );
      }
    }
    box.replaceChildren(...lines);
  }

  /** Result summary + retry affordance for failed photos (issue #2). */
  private updateAnalysisResultDom(): void {
    this.updateAnalysisControls();
    const box = this.content.querySelector<HTMLElement>('#analysis-result');
    if (!box) return;

    const result = this.analysisResult;
    if (this.analyzing || !result) {
      box.replaceChildren();
      return;
    }
    const failed = result.photoStatuses?.filter((st) => st.status === 'error') ?? [];
    const lines: Node[] = [
      el('div', { class: 'analysis-summary' },
        `${result.candidates.length} candidate(s) from ${result.observations.length} observation(s) — analyzer: ${result.analyzerName ?? 'openai'}`)
    ];
    if (failed.length > 0) {
      lines.push(
        el('button', {
          class: 'btn retry-btn',
          onclick: () => void this.runAnalysis(failed.map((f) => f.photoId))
        }, `Retry ${failed.length} failed photo(s)`)
      );
    } else {
      lines.push(
        el('button', {
          class: 'btn primary',
          onclick: () => { this.mode = 'review'; this.render(); }
        }, 'Review candidates →')
      );
    }
    box.replaceChildren(...lines);
  }

  /* ---------------- review screen ---------------- */

  private async renderReviewScreen(preserveMapView = false): Promise<void> {
    const s = this.survey;
    if (!s) return;
    this.setMode('review', 'Review candidates');

    this.mapView.setTrack(s);
    this.mapView.setPhotos(s.photos);
    this.mapView.setCandidates(s.candidates);
    requestAnimationFrame(() => {
      if (this.mode !== 'review' || this.survey?.id !== s.id) return;
      this.mapView.map.resize();
      if (!preserveMapView) this.mapView.fitToSurvey(s);
    });

    this.bottombar.replaceChildren(
      el('button', { class: 'btn', onclick: () => { this.placingCandidate = false; this.mode = 'survey'; this.render(); } }, '← Field'),
      el('button', {
        class: 'btn primary',
        disabled: s.candidates.length === 0 || s.candidates.some((c) => c.analyzer !== 'openai' && c.analyzer !== 'manual'),
        onclick: () => { this.mode = 'upload'; this.render(); }
      }, 'Review upload →')
    );

    const observations = await surveyDb.listObservations(s.id);
    const photoByObs = this.photosForObservations(s, observations);
    const obsById = new Map<string, Observation>(observations.map((o) => [o.id, o]));
    const cards = s.candidates.map((c) => this.buildCandidateCard(c, photoByObs, obsById));
    this.content.replaceChildren(
      el('div', { class: 'manual-placement' },
        el('button', { class: 'btn', onclick: () => {
          this.placingCandidate = !this.placingCandidate;
          this.placingExistingCandidateId = null;
          this.render();
        } }, this.placingCandidate ? 'Cancel pin placement' : '+ Add pin on map'),
        el('span', {}, this.placingExistingCandidateId ? 'Tap the map to place the selected candidate.' : this.placingCandidate ? 'Tap the map where the object is located.' : 'Add an object manually if analysis found no candidate.')
      ),
      ...(s.candidates.some((c) => c.analyzer !== 'openai' && c.analyzer !== 'manual')
        ? [el('div', { class: 'demo-banner' }, 'Saved analysis is unverified — re-analyze photos with OpenAI before exporting')]
        : []),
      ...(s.candidates.length === 0 ? [el('div', { class: 'empty-hint' }, s.photos.length > 0
        ? 'No candidates. Your photos are shown below. Analyze again or add a pin manually.'
        : 'No candidates yet. Add a pin on the map, or capture photos and press Map photos.')] : []),
      ...(s.photos.length > 0 ? [this.buildPhotoGallery(s.photos), el('button', { class: 'btn', onclick: () => { this.mode = 'analysis'; this.render(); } }, 'Analyze photos again')] : []),
      el('div', { class: 'section-title' }, `Candidates (${s.candidates.length})`),
      el('div', { class: 'candidate-grid' }, ...cards)
    );
  }

  private photosForObservations(
    s: Survey,
    observations: Observation[]
  ): Map<string, Photo | undefined> {
    // Issue #10: the review screen needs the FULL photo (image + camera
    // position provenance), not just the image data URL.
    const map = new Map<string, Photo | undefined>();
    for (const obs of observations) {
      map.set(obs.id, s.photos.find((p) => p.id === obs.photoId));
    }
    return map;
  }

  private buildPhotoGallery(photos: Photo[]): HTMLElement {
    return el('div', { class: 'photo-gallery' },
      el('div', { class: 'section-title' }, `Photos (${photos.length})`),
      el('div', { class: 'photo-gallery-items' }, ...photos.map((photo) =>
        el('div', { class: 'photo-frame photo-thumbnail' },
          el('button', { class: 'field-photo-button', 'aria-label': 'Photo details', onclick: () => this.showPhotoDetails(photo) },
            photo.image ? el('img', { src: photo.image, alt: 'Captured source photo' }) : 'Photo'),
          this.photoDetailsButton(photo, true)
        )
      ))
    );
  }

  private buildCandidateGeometryDetails(c: FeatureCandidate, evidence: Observation[], photoByObs: Map<string, Photo | undefined>): HTMLElement {
    const details = el('section', { class: 'candidate-geometry-details' }, el('h3', {}, getFeatureClass(c.featureType)?.label ?? c.featureType));
    for (const obs of evidence) {
      const photo = photoByObs.get(obs.id);
      const heading = photo?.cameraHeading;
      const ray = photo ? rayFromPhoto(photo, obs) : null;
      const offset = imageBearing(0, obs.bbox);
      const signedOffset = offset > 180 ? offset - 360 : offset;
      appendLocalized(details, el('div', { class: 'row' },
        el('b', {}, 'Estimated distance'),
        ` ${obs.distanceEstimate == null ? t('unknown') : `${obs.distanceEstimate.toFixed(1)} m${obs.distanceUncertaintyM == null ? '' : ` ±${obs.distanceUncertaintyM.toFixed(1)} m`}`}`,
        el('span', { class: 'hint' }, ' (AI estimate from photo)')
      ));
      appendLocalized(details, el('div', { class: 'row' },
        el('b', {}, 'Estimated object bearing'),
        heading
          ? ` ${imageBearing(heading.bearing, obs.bbox).toFixed(0)}°${ray?.bearingUncDeg == null ? '' : ` ±${ray.bearingUncDeg.toFixed(0)}°`} · ${t(heading.source)}`
          : ' unavailable — no camera heading',
        el('span', { class: 'hint' }, ' (north 0°, east 90°)')
      ));
      appendLocalized(details, el('div', { class: 'row hint' },
        `Image direction: ${signedOffset >= 0 ? '+' : ''}${signedOffset.toFixed(0)}° from center (right + / left −; assumed field of view)`
      ));
    }
    const posRow = el('div', { class: 'row' });
    if (c.lat != null && c.lon != null) {
      appendLocalized(posRow,
        el('b', {}, 'Position'),
        ` ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}  `,
        confSpan('pos', c.positionConfidence),
        // Issue #3: the quality classification must be visible to the
        // reviewer — it distinguishes a strong triangulation from a
        // single-ray projection, weak geometry, or contradictory rays.
        c.positionQuality
          ? el(
              'span',
              { class: `quality-chip q-${c.positionQuality}`, title: 'Position quality (issue #3)' },
              ` ${POSITION_QUALITY_LABEL[c.positionQuality]}`
            )
          : '',
        c.positionUncertaintyMeters != null
          ? ` · ${c.positionQuality === 'distance-only' ? t('Estimated range') : 'σ'} ${c.positionUncertaintyMeters.toFixed(0)} m`
          : '',
        ' '
      );
    } else {
      const hasCameraGps = c.observationIds.some((id) => photoByObs.get(id)?.gps)
        || (evidence.length === 0 && this.survey?.photos.length === 1 && !!this.survey.photos[0].gps);
      appendLocalized(posRow, el('b', {}, 'Position'), hasCameraGps
        ? ' unknown — camera GPS locates the photo, not the photographed object. '
        : ' unknown — no usable camera GPS was read from the photo. ');
    }
    appendLocalized(details, posRow);
    return details;
  }

  private photoDetailsButton(photo: Photo, compact = false): HTMLButtonElement {
    return el('button', {
      class: 'photo-details-button',
      'aria-label': 'Photo details',
      title: 'Photo details',
      onclick: (event) => { event.stopPropagation(); this.showPhotoDetails(photo); }
    }, compact ? 'ⓘ' : 'Details');
  }

  private async showPhotoDetails(photo: Photo): Promise<void> {
    const dialog = el('dialog', { class: 'photo-details-dialog', 'aria-label': 'Photo details' }) as HTMLDialogElement;
    const close = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Close');
    const heading = photo.cameraHeading;
    appendLocalized(dialog,
      el('div', { class: 'photo-details-header' }, el('h2', {}, 'Photo details'), close),
      ...(photo.image ? [el('img', { class: 'field-photo-full', src: photo.image, alt: 'Captured source photo' })] : []),
      el('div', { class: 'row' }, `${t('Captured')}: ${new Date(photo.timestamp).toLocaleString()} (${photo.timestampSource ?? t('unknown')})`),
      el('div', { class: 'row' }, photo.cameraPosition
        ? `${t('Camera')}: ${t(describeCameraPosition(photo.cameraPosition))} @ ${photo.cameraPosition.lat.toFixed(6)}, ${photo.cameraPosition.lon.toFixed(6)}`
        : 'Camera: no GPS'),
      el('div', { class: 'row' }, `${t('Cam heading')}: ${heading
        ? `${heading.bearing.toFixed(0)}° · ${t(heading.source)} · ±${heading.uncertaintyDeg}° · ${t(`age ${Math.round(heading.ageMs / 1000)} s`)}${heading.detail ? ` · ${t(heading.detail)}` : ''}`
        : t(photo.headingNote ?? 'No orientation reading')}`),
      ...(photo.movementHeading != null ? [el('div', { class: 'row' }, `${t('Movement')}: ${t(`hdg ${photo.movementHeading.toFixed(0)}° (direction of travel — NOT a camera bearing)`)}`)] : []),
      el('div', { class: 'row' }, `${t('Note')}: ${photo.note || t('none')}`),
      this.buildPhotoImportInfo(photo),
      this.buildBrowserVisionDetails(photo)
    );
    const survey = this.survey;
    if (survey) {
      const observations = await surveyDb.listObservations(survey.id);
      const photoByObs = this.photosForObservations(survey, observations);
      for (const candidate of survey.candidates.filter((c) => c.observationIds.some((id) => photoByObs.get(id)?.id === photo.id))) {
        appendLocalized(dialog, this.buildCandidateGeometryDetails(candidate, observations.filter((obs) => candidate.observationIds.includes(obs.id) && obs.photoId === photo.id), photoByObs));
      }
    }
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }

  private async checkPhotoBeforeSending(photo: Photo): Promise<void> {
    const result = await this.checkPhotoLocally(photo, false, (stage, percent) => {
      if (!this.analyzing) return;
      this.analysisProgress = `${t('Local photo check')}: ${t(stage)}${percent == null ? '' : ` ${Math.round(percent)}%`}`;
      this.updateAnalysisProgressDom();
    });
    if (requiresPhotoReview(result)) throw new Error(t('Photo needs NSFW review before sending. Open photo details to review or retry the local check.'));
  }

  private async checkPhotoLocally(photo: Photo, force = false, progress?: (stage: string, percent?: number) => void) {
    if (!force && photo.browserVision?.version === BROWSER_VISION_VERSION) return photo.browserVision;
    if (!photo.image) throw new Error(t('Photo has no image data to analyze'));
    const result = await this.browserVision.check(photo.image, progress);
    // Read the latest row to avoid overwriting GPS restored while models loaded.
    const survey = await surveyDb.loadSurvey(photo.surveyId);
    const saved = survey?.photos.find((p) => p.id === photo.id);
    if (!saved) throw new Error(t('Photo is no longer available'));
    saved.browserVision = result;
    await surveyDb.addPhoto(photo.surveyId, saved);
    photo.browserVision = result;
    const current = this.survey?.photos.find((p) => p.id === photo.id);
    if (current) current.browserVision = result;
    return result;
  }

  private buildBrowserVisionDetails(photo: Photo): HTMLElement {
    const section = el('section', { class: 'local-vision-details' });
    const redraw = () => {
      section.replaceChildren();
      const result = photo.browserVision;
      appendLocalized(section, el('h3', {}, 'Browser-local photo analysis'),
        el('p', { class: 'hint' }, 'Images stay on this device for these checks. The initial CLIP model download can be large; subsequent runs use the browser cache. Scores are model similarities, not guarantees.'));
      if (result) {
        appendLocalized(section, el('p', {}, `NSFW: ${t(result.nsfw.status === 'error' ? 'Check failed' : result.nsfw.verdict === 'review' ? 'Needs human review' : 'No NSFW flag')}`));
        if (result.nsfw.error) section.append(el('p', { class: 'hint' }, t(result.nsfw.error)));
        if (result.nsfw.scores) section.append(el('p', { class: 'hint' }, result.nsfw.scores.map((s) => `${s.label}: ${(s.score * 100).toFixed(1)}%`).join(' · ')));
        appendLocalized(section, el('p', {}, `CLIP: ${t(result.clip.status === 'error' ? 'Check failed' : result.clip.purpose === 'poi' ? 'Suitable for OSM POI analysis' : result.clip.purpose === 'other' ? 'Possibly unsuitable for OSM POI analysis' : 'Purpose uncertain')}`));
        if (result.clip.error) section.append(el('p', { class: 'hint' }, t(result.clip.error)));
        for (const score of result.clip.categories ?? []) {
          const category = browserVisionConfig.clip.categories.find((c) => c.id === score.label);
          section.append(el('p', { class: 'hint' }, `${t(category?.label ?? score.label)}: ${(score.score * 100).toFixed(1)}%`));
        }
        section.append(el('p', { class: 'hint' }, `NSFWJS / ${result.nsfw.model} · CLIP / ${result.clip.model}`));
      } else appendLocalized(section, el('p', {}, 'Not checked — runs before OpenAI analysis'));
      const status = el('p', { role: 'status', 'aria-live': 'polite' });
      const button = el('button', { class: 'btn', disabled: this.analyzing, onclick: async () => {
        button.disabled = true;
        section.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = true; });
        status.textContent = t('Checking photo locally…');
        try {
          await this.checkPhotoLocally(photo, true, (stage, percent) => { status.textContent = `${t(stage)}${percent == null ? '' : ` ${Math.round(percent)}%`}`; });
          redraw();
        } catch (error) { status.textContent = (error as Error).message; button.disabled = false; }
      } }, result ? 'Run local check again' : 'Check in browser');
      appendLocalized(section, button, status);
      if (result && requiresPhotoReview(result)) appendLocalized(section, el('button', { class: 'btn', disabled: this.analyzing, onclick: async () => {
        const survey = await surveyDb.loadSurvey(photo.surveyId);
        const saved = survey?.photos.find((p) => p.id === photo.id);
        if (!saved?.browserVision) return;
        saved.browserVision.reviewedForSending = true;
        await surveyDb.addPhoto(photo.surveyId, saved);
        photo.browserVision = saved.browserVision;
        const current = this.survey?.photos.find((p) => p.id === photo.id);
        if (current) current.browserVision = saved.browserVision;
        redraw();
      } }, 'I reviewed this photo — allow sending'));
      else if (result?.reviewedForSending) appendLocalized(section, el('p', {}, 'Sending allowed by reviewer'));
    };
    redraw();
    return section;
  }

  private buildPhotoImportInfo(photo: Photo): HTMLElement {
    const info = photo.importInfo;
    return el('div', { class: 'photo-import-info' },
      el('b', {}, 'Photo import details'),
      el('div', { class: 'row hint' }, 'Photo file selection is recommended for PC. On phones, GPS metadata may be hidden; place the photo on the map if needed.'),
      el('div', { class: 'row' }, supportsPhotoFilePicker()
        ? 'Photo picker: File System Access API'
        : 'Photo picker: standard file input (File System Access API unavailable)'),
      ...(info ? [
        el('div', { class: 'row' }, `${t('Selected file')}: ${info.fileName}`),
        el('div', { class: 'row' }, `${t('File size')}: ${info.fileSize.toLocaleString()} ${t('bytes')}`),
        el('div', { class: 'row' }, `${t('Selection method')}: ${info.selectionMethod === 'file-system-access' ? 'File System Access API' : t('Standard file input')}`),
        el('div', { class: 'row' }, info.exifGpsRead ? 'EXIF GPS: read successfully' : 'EXIF GPS: not found in selected file'),
        ...(info.exifReadError ? [el('div', { class: 'row' }, `${t('EXIF parse error')}: ${info.exifReadError}`)] : []),
        ...(info.exifTagCount != null ? [el('div', { class: 'row' }, `${t('EXIF tag count')}: ${info.exifTagCount}`)] : []),
        ...(info.sha256 ? [el('div', { class: 'row file-fingerprint' }, `SHA-256: ${info.sha256}`)] : []),
        ...(info.gpsTags ? [el('div', { class: 'row file-fingerprint' }, `GPS tags: ${info.gpsTags}`)] : [])
      ] : [el('div', { class: 'row' }, 'Import details unavailable for this saved photo. Re-import the original photo to check the selection method.')])
    );
  }

  private buildCandidateCard(
    c: FeatureCandidate,
    photoByObs: Map<string, Photo | undefined>,
    obsById: Map<string, Observation>
  ): HTMLElement {
    const cls = getFeatureClass(c.featureType);
    const card = el('div', {
      class: `candidate status-${c.status}${this.selectedFieldCandidateId === c.id ? ' selected' : ''}`,
      'data-candidate-id': c.id,
      onclick: () => this.selectFieldCandidate(c.id, false),
      onfocusin: () => this.selectFieldCandidate(c.id, false)
    });

    const evidence = c.observationIds.map((id) => obsById.get(id)).filter((o): o is Observation => !!o);
    const first = evidence.find((o) => !!photoByObs.get(o.id)?.image);
    const img = first ? photoByObs.get(first.id)?.image ?? '' : '';
    const thumbImage = c.analyzer === 'manual' ? el('span', { class: 'manual-thumb', 'aria-hidden': 'true' }, '📍')
      : el('img', { class: 'thumb', src: img || undefined, alt: 'source photo' });

    const thumbPhoto = first ? photoByObs.get(first.id) : undefined;
    const thumb = thumbPhoto ? el('div', { class: 'photo-frame photo-thumbnail' }, thumbImage, this.photoDetailsButton(thumbPhoto, true)) : thumbImage;

    const statusSel = el('select', {
      class: 'status-sel',
      'aria-label': 'Candidate status',
      onchange: () => void this.onStatusChange(c, statusSel)
    },
      ...(c.status === 'excluded' ? [el('option', { value: 'excluded', disabled: true }, 'Not uploaded (saved)')] : []),
      ...(['new', 'existing'] as CandidateStatus[]).map((v) =>
        el('option', { value: v }, v[0].toUpperCase() + v.slice(1))
      )
    );
    statusSel.value = c.status;

    appendLocalized(card,
      el('div', { class: 'head' }, thumb, el('div', { class: 'type' }, cls?.label ?? (c.analyzer === 'manual' ? 'Custom tags' : c.featureType)), statusSel)
    );
    appendLocalized(card, el('button', { class: 'btn small', onclick: () => void this.onDeleteCandidate(c) }, 'Delete pin'));
    if (evidence.length) appendLocalized(card, el('button', { class: 'btn small', onclick: () => void this.showGroupDialog(c) }, 'Group same object'));
    if (c.mergeSources?.length) appendLocalized(card, el('p', { class: 'hint' }, 'Provisional position: the dashed area shows estimated uncertainty. Move the pin to confirm its location.'));
    if (c.mergeSources?.length) appendLocalized(card, el('button', { class: 'btn small', onclick: () => void this.separateCandidateGroup(c) }, 'Separate grouped photos'));

    appendLocalized(card, el('button', { class: 'btn small', onclick: () => {
      const photo = evidence.map((obs) => photoByObs.get(obs.id)).find((p) => p != null);
      if (photo) { void this.showPhotoDetails(photo); return; }
      const dialog = el('dialog', { class: 'photo-details-dialog', 'aria-label': 'Details' }) as HTMLDialogElement;
      appendLocalized(dialog, el('div', { class: 'photo-details-header' }, el('h2', {}, 'Details'),
        el('button', { class: 'btn', onclick: () => dialog.close() }, 'Close')),
        this.buildCandidateGeometryDetails(c, evidence, photoByObs));
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      document.body.append(dialog);
      dialog.showModal();
    } }, 'Details'));

    appendLocalized(card, el('div', { class: 'row' }, `Source: ${c.analyzer === 'openai' ? `OpenAI / ${c.analyzerModel ?? 'model unknown'}` : c.analyzer === 'manual' ? 'Placed manually on map' : c.analyzer === 'mock' ? 'Mock (fabricated)' : 'Unverified or mixed source'}`));
    if (c.analyzer === 'manual') appendLocalized(card, el('div', { class: 'row' }, 'No source photo — manually placed candidate'));
    if (c.analyzer === 'manual') {
      const classSelect = el('select', { 'aria-label': 'Feature type', onchange: () => void this.onManualClassChanged(c, classSelect) },
        el('option', { value: 'manual' }, 'Custom tags'),
        ...FEATURE_CLASSES.map((cls) => el('option', { value: cls.id }, cls.label))
      );
      classSelect.value = c.featureType;
      appendLocalized(card, el('div', { class: 'row' }, 'Feature type: ', classSelect));
    }
    if (c.analyzer !== 'manual') appendLocalized(card, el('div', { class: 'row' }, `Contributing observations: ${evidence.length} from ${new Set(evidence.map((o) => o.photoId)).size} photo(s)`));
    const sourcePhotos = [...new Map(evidence.map((obs) => {
      const photo = photoByObs.get(obs.id);
      return [photo?.id, photo] as const;
    }).filter((entry): entry is readonly [string, Photo] => !!entry[0] && !!entry[1])).values()];
    if (c.analyzer !== 'manual' && !sourcePhotos.length && this.survey?.photos.length === 1) sourcePhotos.push(this.survey.photos[0]);
    for (const photo of sourcePhotos) {
      if (!evidence.some((obs) => photoByObs.get(obs.id)?.id === photo.id)) appendLocalized(card, this.photoDetailsButton(photo));
    }

    for (const obs of evidence) {
      const sourceImage = photoByObs.get(obs.id)?.image;
      if (sourceImage) {
        const box = obs.bbox;
        appendLocalized(card, el('div', { class: 'evidence-photo' },
          el('img', { src: sourceImage, alt: `Source photo with ${obs.featureType} detection box` }),
          this.photoDetailsButton(photoByObs.get(obs.id)!),
          el('div', { class: 'evidence-box', style: `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%` })
        ));
      }
      appendLocalized(card, el('div', { class: 'row' },
        `Detection: ${obs.featureType} ${obs.detectionConfidence == null ? 'confidence unknown' : `${Math.round(obs.detectionConfidence * 100)}%`} · `,
        `OCR: ${obs.textSeen ? `${obs.textSeen}${obs.ocrConfidence == null ? '' : ` (${Math.round(obs.ocrConfidence * 100)}%)`}` : t('none')}`
      ));
      appendLocalized(card, el('div', { class: 'row' }, `Suggested attributes/tags: ${Object.entries(obs.tagSuggestions).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`));
    }

    // Issue #9: review-only class — the OSM mapping is uncertain/ambiguous,
    // so nothing is applied automatically; the reviewer decides.
    if (cls && !cls.autoTag) {
      appendLocalized(card,
        el(
          'div',
          { class: 'review-only-note' },
          cls.mappings && cls.mappings.length > 0
            ? 'Review-only class — choose the OSM mapping below (or edit the tags manually). Nothing is applied automatically.'
            : 'Review-only class — no established OSM mapping. Set the tags manually below.'
        )
      );
    }

    // Issue #11: semantic gate — make the missing requirement explicit
    // HERE, before the reviewer reaches the upload screen. (Geometry
    // blocks are shown further down as the geometry note.)
    const exportCheck = validateCandidateExport(c);
    if (c.status === 'new' && !exportCheck.exportable && exportCheck.gate === 'semantics') {
      appendLocalized(card,
        el(
          'div',
          { class: 'needs-tag-review', title: 'Semantic export gate (issue #11)' },
          `Needs tag review: ${exportCheck.reason}`
        )
      );
    }

    const posRow = el('div', { class: 'row' });
    if (this.mode === 'review') appendLocalized(posRow, el('button', { class: 'btn small', onclick: () => {
      this.placingCandidate = false;
      this.placingExistingCandidateId = this.placingExistingCandidateId === c.id ? null : c.id;
      if (c.lat == null || c.lon == null) {
        const photo = c.observationIds.map((id) => photoByObs.get(id)).find((p) => p?.gps);
        if (photo?.gps) this.mapView.map.jumpTo({ center: [photo.gps.lon, photo.gps.lat], zoom: 18 });
      }
      void this.renderReviewScreen(true);
    } }, this.placingExistingCandidateId === c.id ? 'Cancel placement' : c.lat == null ? 'Place pin on map' : 'Move pin on map'));
    appendLocalized(card, posRow);
    appendLocalized(card, el('div', { class: 'row' }, `OSM mapping: ${Object.entries(c.tags).map(([k, v]) => `${k}=${v}`).join(', ') || 'unresolved'}`));

    const missingGpsPhotos = [...new Map(evidence.map((obs) => {
      const photo = photoByObs.get(obs.id);
      return [photo?.id, photo] as const;
    }).filter((entry): entry is readonly [string, Photo] => !!entry[0] && !!entry[1])).values()]
      .filter((photo) => !photo.cameraPosition && !photo.gps);
    // Analyses saved by older builds may have lost their observation rows.
    // A one-photo survey still has an unambiguous source for GPS recovery.
    if (c.analyzer !== 'manual' && missingGpsPhotos.length === 0 && evidence.length === 0 && this.survey?.photos.length === 1) {
      const onlyPhoto = this.survey.photos[0];
      if (!onlyPhoto.cameraPosition && !onlyPhoto.gps) missingGpsPhotos.push(onlyPhoto);
    }
    for (const photo of missingGpsPhotos) {
      const fileInput = el('input', {
        type: 'file', accept: '*/*', 'aria-label': 'Select original photo to restore GPS',
        onchange: async () => {
          const file = fileInput.files?.[0];
          if (file) await this.onRestorePhotoGps(photo, file);
          fileInput.value = '';
        }
      });
      fileInput.style.display = 'none';
      appendLocalized(card, el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => {
          void pickPhotoFile(() => fileInput.click()).then((file) => {
            if (file) return this.onRestorePhotoGps(photo, file);
          }).catch((error) => toast(error instanceof Error ? error.message : String(error)));
        } }, 'Read GPS from original photo'),
        fileInput
      ));
    }
    if (c.analyzer !== 'manual' && evidence.length === 0 && this.survey?.photos.length === 1) {
      appendLocalized(card, el('div', { class: 'row' }, 'Saved detection details are unavailable. Re-run photo analysis to estimate the object position, or place its pin on the map.'));
    }

    // Issue #8: position solution provenance (estimate → refined → snapped).
    const ps = c.positionSolution;
    if (ps && c.lat != null && c.lon != null) {
      const steps: string[] = [];
      steps.push(`estimate ${ps.estimatedPosition.lat.toFixed(5)}, ${ps.estimatedPosition.lon.toFixed(5)}`);
      if (ps.refinedPosition) {
        const d = distanceMeters(ps.estimatedPosition.lat, ps.estimatedPosition.lon, ps.refinedPosition.lat, ps.refinedPosition.lon);
        steps.push(`refined +${d.toFixed(1)} m`);
      }
      if (ps.snappedPosition && ps.linkedOsmId != null) {
        steps.push(`snapped → osm/${ps.linkedOsmType ?? 'node'}/${ps.linkedOsmId} (${Math.round((ps.snapConfidence ?? 0) * 100)}%)`);
      }
      const solRow = el('div', { class: 'row solution-row' }, el('b', {}, 'Solution'), ` ${steps.map((step) => t(step)).join(' → ')}`, ` · ${ps.positionQuality === 'distance-only' ? t('Estimated range') : 'σ'} ${ps.uncertaintyMeters.toFixed(0)} m`);
      for (const e of ps.evidence) {
        appendLocalized(solRow, el('span', { class: 'ev-chip', title: e.detail ?? e.label }, e.label));
      }
      // Issue #8: the aerial refinement is a reviewable, reversible
      // proposal — show which position is working, the imagery
      // provenance, and an explicit revert/apply control.
      const snapped = ps.snappedPosition != null && ps.linkedOsmId != null;
      // Issue #9: review-only classes are never auto-snapped — unconfirmed
      // OSM semantics must not drive object identity.
      if (!snapped && cls && !cls.autoTag) {
        appendLocalized(solRow, el('span', { class: 'review-only-note' }, ' · no auto-snap (review-only class)'));
      }
      // Attribution is shown whenever imagery contributed — including as
      // the base position a snap was evaluated from.
      if (ps.refinedPosition && ps.imagerySource) {
        appendLocalized(solRow,
          el('span', { class: 'imagery-attr', title: 'Imagery source used for position refinement' }, ` · Imagery: ${ps.imagerySource}`)
        );
      }
      if (ps.refinedPosition && !snapped) {
        if (ps.refinementApplied !== false) {
          appendLocalized(solRow,
            el('span', { class: 'working-tag' }, ' · working: refined'),
            el('button', {
              class: 'btn small revert-btn',
              title: 'Discard the aerial correction and keep the ground-survey estimate',
              onclick: () => void this.onRevertRefinement(c)
            }, '↩ Revert to ground estimate')
          );
        } else {
          appendLocalized(solRow,
            el('span', { class: 'working-tag' }, ' · working: ground estimate'),
            el('button', {
              class: 'btn small apply-btn',
              title: 'Use the aerial-refined position as the working position',
              onclick: () => void this.onApplyRefinement(c)
            }, 'Apply aerial correction')
          );
        }
      }
      appendLocalized(card, solRow);
    }

    appendLocalized(card,
      el(
        'div',
        { class: 'tags' },
        ...Object.entries(c.tags).map(
          ([k, v]) =>
            el(
              'span',
              { class: 'tag-chip' },
              el('code', { class: 'tag-val', title: 'Click to edit value', onclick: () => void this.onEditTag(c, k) }, `${esc(k)}=${esc(v)}`),
              el('button', { class: 'rm', 'aria-label': `Remove ${k}`, onclick: () => void this.onRemoveTag(c, k) }, '×')
            )
        ),
        this.buildAddTagRow(c)
      )
    );

    // Issue #2: attributes the analyzer detected but that did NOT reach
    // the auto-tag threshold (or came from review-only/unknown classes)
    // are shown as unconfirmed evidence — they never silently become
    // OSM tags.
    const detected = c.observationIds
      .map((id) => obsById.get(id)?.detectedAttributes)
      .filter((v): v is Record<string, string> => v != null && Object.keys(v).length > 0);
    if (detected.length > 0) {
      const merged: Record<string, string[]> = {};
      for (const attrs of detected) {
        for (const [k, v] of Object.entries(attrs)) (merged[k] ??= []).push(v);
      }
      appendLocalized(card,
        el(
          'div',
          { class: 'detected-attrs', title: 'Detected but unconfirmed — NOT applied as OSM tags (issue #2)' },
          el('b', {}, 'Detected (unconfirmed)'),
          ...Object.entries(merged).map(([k, vs]) =>
            el('span', { class: 'tag-chip detected' }, ` ${k}=${vs.join(' | ')}`)
          )
        )
      );
    }

    // Issue #9: OSM mapping picker for review-only classes (ambiguous or
    // unconfirmed semantics). Choosing a mapping applies its tags; the
    // reviewer can still edit them afterwards.
    if (cls && !cls.autoTag && cls.mappings && cls.mappings.length > 0) {
      const chosen = findChosenMapping(c.featureType, c.tags);
      const picker = el('div', { class: 'mapping-picker' }, el('b', {}, 'OSM mapping:'));
      for (const m of cls.mappings) {
        const radio = el('input', { type: 'radio', name: `mapping-${c.id}` });
        radio.checked = chosen === m;
        radio.onchange = () => {
          if (radio.checked) void this.onMappingChosen(c, m);
        };
        appendLocalized(picker, el('label', { class: 'mapping-opt' }, radio, ` ${m.label}${m.hint ? ` — ${m.hint}` : ''}`));
      }
      appendLocalized(card, picker);
    }

    // Issue #9: geometry policy — area-based classes are never created from
    // a single photo; show the reviewer the alternatives.
    const geomPref = geometryPreferenceFor(c.featureType);
    if (c.status === 'new' && (geomPref === 'area' || geomPref === 'existing-only')) {
      appendLocalized(card,
        el(
          'div',
          { class: 'geometry-note' },
          'Area-based class: the app will not create geometry from a single photo. Link to an existing object (status: Existing) or draw the boundary in an editor.'
        )
      );
    }

    // Optional subtype suggestions (issue #5): never applied by default;
    // surfaced here for the reviewer to confirm from the photo.
    const pending = Object.entries(suggestedTagsFor(c.featureType)).filter(
      ([k, v]) => c.tags[k] !== v
    );
    if (pending.length > 0) {
      appendLocalized(card,
        el(
          'div',
          { class: 'suggest-row' },
          'Suggested (add if visible in photo):',
          ...pending.map(([k, v]) =>
            el('button', { class: 'btn small suggest-btn', onclick: () => void this.onAddSuggestedTag(c, k, v) }, `+ ${k}=${v}`)
          )
        )
      );
    }

    // Known-allowed values that must NOT be guessed (issue #5): offer a
    // value picker for defining keys the candidate has not set yet.
    const common = Object.entries(commonValuesFor(c.featureType)).filter(
      ([k]) => c.tags[k] == null
    );
    if (common.length > 0) {
      const picks = common.map(([k, values]) => {
        const sel = el(
          'select',
          { class: 'common-sel', 'aria-label': `Value for ${k}` },
          el('option', { value: '' }, `${k}=? (only if visible)`),
          ...values.map((v) => el('option', { value: v }, v))
        );
        sel.onchange = () => void this.onCommonValueChanged(c, k, sel);
        return sel;
      });
      appendLocalized(card, el('div', { class: 'suggest-row' }, 'Set value (only if visible in photo):', ...picks));
    }

    const nameInput = el('input', {
      class: 'name-input',
      placeholder: 'Name (optional)',
      value: c.name ?? '',
      onchange: () => void this.onNameChanged(c, nameInput)
    });
    appendLocalized(card, el('div', { class: 'name-row' }, nameInput));

    if (c.warnings.length > 0) {
      appendLocalized(card, el('div', { class: 'warnings' }, el('ul', {}, ...c.warnings.map((w) => el('li', {}, w)))));
    }

    if (c.osmMatches.length > 0) {
      appendLocalized(card,
        el(
          'div',
          { class: 'osm-matches' },
          c.status === 'existing' ? 'Merged with OSM (green pin):' : 'Drag the analyzed pin onto a purple OSM pin to merge (distance from current pin; score is not identity confidence):',
          ...c.osmMatches.filter((m) => c.status !== 'existing' || (m.osmId === c.linkedOsmId && m.osmType === (c.linkedOsmType ?? 'node'))).map((m) => this.buildOsmMatchRow(c, m))
        )
      );
    }

    return card;
  }

  private async onRestorePhotoGps(photo: Photo, file: File): Promise<void> {
    const s = this.survey;
    if (!s || !s.photos.some((p) => p.id === photo.id)) return;
    try {
      const restored = await restorePhotoGps(photo, file);
      await surveyDb.addPhoto(s.id, restored);
      s.photos = s.photos.map((p) => p.id === photo.id ? restored : p);
      const observations = await surveyDb.listObservations(s.id);
      const byId = new Map(observations.map((obs) => [obs.id, obs]));
      for (const candidate of s.candidates) {
        if (candidate.lat != null || candidate.lon != null || candidate.analyzer === 'manual') continue;
        if (!candidate.observationIds.some((id) => byId.get(id)?.photoId === photo.id)) continue;
        const rays = candidate.observationIds.flatMap((id) => {
          const obs = byId.get(id);
          const source = s.photos.find((p) => p.id === obs?.photoId);
          const ray = obs && source ? rayFromPhoto(source, obs) : null;
          return ray ? [ray] : [];
        });
        if (rays.length === 0) continue;
        const estimate = estimatePosition(rays);
        candidate.lat = estimate.lat;
        candidate.lon = estimate.lon;
        candidate.positionConfidence = estimate.positionConfidence;
        candidate.positionQuality = estimate.positionQuality;
        candidate.positionUncertaintyMeters = estimate.uncertaintyMeters;
        candidate.warnings = candidate.warnings.filter((warning) => !warning.startsWith('No usable camera GPS position'));
        candidate.warnings.push(...estimate.warnings);
        await surveyDb.updateCandidate(candidate);
      }
      this.mapView.map.jumpTo({ center: [restored.cameraPosition!.lon, restored.cameraPosition!.lat], zoom: 18 });
      this.mapView.setPhotos(s.photos);
      this.mapView.setCandidates(s.candidates);
      if (this.mode === 'review') await this.renderReviewScreen(true);
      else if (this.mode === 'survey') await this.renderFieldInspector();
      toast(observations.some((obs) => obs.photoId === photo.id)
        ? 'Photo GPS restored. Check the candidate pin before uploading.'
        : 'Photo GPS restored. Re-run analysis or place the object pin manually.');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }

  private buildOsmMatchRow(c: FeatureCandidate, m: OsmMatch): HTMLElement {
    const linked = c.linkedOsmId === m.osmId && (c.linkedOsmType == null || c.linkedOsmType === m.osmType);
    const distance = c.lat != null && c.lon != null
      ? `${Math.round(distanceMeters(c.lat, c.lon, m.lat, m.lon))} m from pin`
      : 'Distance unavailable';
    const tagPreview = Object.entries(m.tags)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return el(
      'div',
      { class: 'osm-match' + (linked ? ' linked' : '') },
      el('div', { class: 'm-meta' }, `${m.osmType}/${m.osmId} · ${distance} · Score ${Math.round(m.matchScore * 100)}% · ${tagPreview}`),
      el('button', {
        class: 'link-btn',
        onclick: (event: Event) => {
          // The card's selection handler would otherwise recenter on the
          // analyzed pin immediately after focusing this OSM object.
          event.stopPropagation();
          this.mapView.showOsmMatch(m);
        }
      }, 'Show on map'),
      ...(linked ? [el('span', {}, 'Merged')] : [])
    );
  }

  /* ---------------- review actions ---------------- */

  private refreshCandidateEditor(): void {
    if (this.mode === 'review') void this.renderReviewScreen(true);
    else if (this.mode === 'survey') {
      if (this.survey) this.mapView.setCandidates(this.survey.candidates);
      void this.renderFieldInspector();
    }
  }

  private async onStatusChange(c: FeatureCandidate, sel: HTMLSelectElement): Promise<void> {
    c.status = sel.value as CandidateStatus;
    if (c.status !== 'existing') {
      c.linkedOsmId = undefined;
      c.linkedOsmType = undefined;
    }
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private async onRemoveTag(c: FeatureCandidate, key: string): Promise<void> {
    delete c.tags[key];
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private async onEditTag(c: FeatureCandidate, key: string): Promise<void> {
    const card = [...this.content.querySelectorAll<HTMLElement>('[data-candidate-id]')]
      .find((node) => node.dataset.candidateId === c.id);
    const keyInput = card?.querySelector<HTMLInputElement>('.tag-key');
    const valueInput = card?.querySelector<HTMLInputElement>('.tag-value');
    if (!keyInput || !valueInput) return;
    keyInput.value = key;
    valueInput.value = c.tags[key] ?? '';
    keyInput.dispatchEvent(new Event('input'));
    valueInput.focus();
  }

  private buildAddTagRow(c: FeatureCandidate): HTMLElement {
    const kInput = el('input', { class: 'tag-key', placeholder: 'key', maxlength: 50 });
    const vInput = el('input', { class: 'tag-value', placeholder: 'value' });
    const keySelect = el('select', { 'aria-label': 'Choose tag key' },
      el('option', { value: '' }, 'Choose key / enter manually'),
      ...tagKeys().map((key) => el('option', { value: key }, key)));
    const valueSelect = el('select', { 'aria-label': 'Choose tag value' });
    const saveButton = el('button', { class: 'btn small', onclick: () => void this.onAddTag(c, kInput, vInput) }, '+ tag');
    const refreshOptions = (): void => {
      const key = kInput.value.trim();
      const values = [...new Set([...tagValues(key), ...(commonValuesFor(c.featureType)[key] ?? [])])].sort();
      keySelect.value = tagKeys().includes(key) ? key : '';
      valueSelect.replaceChildren(el('option', { value: '' }, 'Choose value / enter manually'),
        ...values.map((value) => el('option', { value }, value)));
      valueSelect.value = values.includes(vInput.value) ? vInput.value : '';
      valueSelect.disabled = values.length === 0;
      saveButton.textContent = t(key in c.tags ? 'Save tag' : '+ tag');
    };
    kInput.oninput = refreshOptions;
    vInput.oninput = () => {
      valueSelect.value = [...valueSelect.options].some((option) => option.value === vInput.value)
        ? vInput.value : '';
    };
    keySelect.onchange = () => {
      if (!keySelect.value) return;
      kInput.value = keySelect.value;
      vInput.value = '';
      refreshOptions();
    };
    valueSelect.onchange = () => { if (valueSelect.value) vInput.value = valueSelect.value; };
    refreshOptions();
    return el(
      'div',
      { class: 'add-tag-row' },
      el('div', { class: 'tag-input-group' }, keySelect, kInput),
      el('div', { class: 'tag-input-group' }, valueSelect, vInput),
      saveButton
    );
  }

  private async onAddTag(c: FeatureCandidate, kInput: HTMLInputElement, vInput: HTMLInputElement): Promise<void> {
    const k = kInput.value.trim();
    const v = vInput.value.trim();
    if (!k) {
      toast('Tag key is required');
      return;
    }
    if (!v && k in c.tags) delete c.tags[k];
    else c.tags[k] = v;
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  /** Add one reviewer-confirmed suggested (optional) tag. */
  /** Reviewer picked a known-allowed value for a not-guessable tag key. */
  private async onCommonValueChanged(c: FeatureCandidate, key: string, sel: HTMLSelectElement): Promise<void> {
    const v = sel.value;
    if (v === '') delete c.tags[key];
    else c.tags[key] = v;
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private async onAddSuggestedTag(c: FeatureCandidate, k: string, v: string): Promise<void> {
    c.tags[k] = v;
    await surveyDb.updateCandidate(c);
    toast(`${k}=${v} added`);
    this.refreshCandidateEditor();
  }

  /** Full tag set that will be written: existing object tags + candidate tags + name.
   * OSMChange <modify> replaces the whole tag set, so existing tags must be carried over. */
  private finalTags(c: FeatureCandidate): Record<string, string> {
    const tags: Record<string, string> = {};
    if (c.status === 'existing' && c.linkedOsmId != null) {
      const match = c.osmMatches.find(
        (m) => m.osmId === c.linkedOsmId && (c.linkedOsmType == null || m.osmType === c.linkedOsmType)
      );
      if (match) Object.assign(tags, match.tags);
    }
    Object.assign(tags, c.tags);
    if (c.name && !('name' in tags)) tags.name = c.name;
    return tags;
  }

  private async onNameChanged(c: FeatureCandidate, input: HTMLInputElement): Promise<void> {
    c.name = input.value.trim() || undefined;
    await surveyDb.updateCandidate(c);
  }

  private async onPinDragged(id: string, lat: number, lon: number): Promise<void> {
    const s = this.survey;
    const c = s?.candidates.find((x) => x.id === id);
    if (!s || !c) return;
    const dropped = this.mapView.map.project([lon, lat]);
    const target = c.osmMatches
      .map((match) => ({ match, point: this.mapView.map.project([match.lon, match.lat]) }))
      .map(({ match, point }) => ({ match, distance: Math.hypot(point.x - dropped.x, point.y - dropped.y) }))
      .filter(({ distance }) => distance <= 24)
      .sort((a, b) => a.distance - b.distance)[0]?.match;
    if (target) {
      await this.onLinkExisting(c, target);
      return;
    }
    const undo = pinUndoBefore(c);
    c.lat = lat;
    c.lon = lon;
    c.positionConfidence = Math.min(c.positionConfidence, 0.3);
    if (!c.warnings.includes('Position set manually by reviewer.')) {
      c.warnings.push('Position set manually by reviewer.');
    }
    c.warnings = c.warnings.filter((warning) => !warning.startsWith('No usable camera GPS position for this observation.'));
    await surveyDb.updateCandidate(c);
    this.recordPinUndo(s.id, undo);
    this.mapView.setCandidates(s.candidates);
    this.refreshCandidateEditor();
    toast('Pin moved');
  }

  private async onMapSelected(lat: number, lon: number): Promise<void> {
    const s = this.survey;
    if (this.mode !== 'review' || !s) return;
    if (this.placingExistingCandidateId) {
      const id = this.placingExistingCandidateId;
      this.placingExistingCandidateId = null;
      await this.onPinDragged(id, lat, lon);
      return;
    }
    if (!this.placingCandidate) return;
    this.placingCandidate = false;
    const c: FeatureCandidate = {
      id: crypto.randomUUID(), surveyId: s.id, analyzer: 'manual', featureType: 'manual',
      lat, lon, positionConfidence: 0, tagConfidence: 0, tags: {}, observationIds: [],
      osmMatches: [], warnings: ['Position placed manually on the map. Check the location and tags before upload.'], status: 'new'
    };
    await surveyDb.updateCandidate(c);
    s.candidates.push(c);
    this.recordPinUndo(s.id, { candidateId: c.id, label: 'Undo add pin' });
    this.render();
  }

  private async onManualClassChanged(c: FeatureCandidate, select: HTMLSelectElement): Promise<void> {
    const cls = getFeatureClass(select.value);
    c.featureType = select.value;
    c.tags = cls?.autoTag ? { ...cls.requiredTags } : {};
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private async showGroupDialog(target: FeatureCandidate): Promise<void> {
    const s = this.survey;
    if (!s) return;
    const observations = await surveyDb.listObservations(s.id);
    if (this.survey !== s) return;
    const candidates = s.candidates.filter((c) => c.id !== target.id && canGroupCandidates([target, c], observations));
    const dialog = el('dialog', { class: 'photo-details-dialog', 'aria-label': 'Group same object' }) as HTMLDialogElement;
    const close = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Close');
    const selection = el('select', { 'aria-label': 'Object to group' },
      ...candidates.map((c) => el('option', { value: c.id }, `${s.candidates.indexOf(c) + 1}: ${getFeatureClass(c.featureType)?.label ?? c.featureType}`)));
    const preview = el('div', { class: 'group-preview' });
    const verdict = el('p', { role: 'status', 'aria-live': 'polite' });
    const selected = () => candidates.find((c) => c.id === selection.value);
    const redraw = () => {
      preview.replaceChildren(); verdict.textContent = '';
      const source = selected();
      if (!source) return;
      for (const candidate of [target, source]) {
        const column = el('section', {}, el('h3', {}, `${s.candidates.indexOf(candidate) + 1}: ${getFeatureClass(candidate.featureType)?.label ?? candidate.featureType}`));
        for (const obs of groupEvidence([candidate], observations)) {
          const photo = s.photos.find((p) => p.id === obs.photoId);
          if (!photo?.image) continue;
          const b = obs.bbox;
          column.append(el('div', { class: 'evidence-photo' }, el('img', { src: photo.image, alt: 'Object to compare' }),
            el('div', { class: 'evidence-box', style: `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%` })));
        }
        preview.append(column);
      }
    };
    const compare = el('button', { class: 'btn', disabled: !candidates.length, onclick: async () => {
      const source = selected();
      if (!source) return;
      const analyzer = this.createAnalyzer();
      if (!(analyzer instanceof OpenAIVisionAnalyzer)) return;
      selection.disabled = compare.disabled = merge.disabled = true;
      verdict.textContent = t('Comparing photos…');
      try {
        const items = groupEvidence([target, source], observations).map((observation) => ({ observation, photo: s.photos.find((p) => p.id === observation.photoId)! }));
        if (items.length > 8) throw new Error(t('Compare up to 8 photos at a time'));
        const result = await analyzer.compareObjects(items);
        verdict.textContent = `${t(result.verdict === 'same' ? 'Possibly the same object' : result.verdict === 'different' ? 'Different objects' : 'Identity uncertain')}: ${result.reason}`;
      } catch (error) { verdict.textContent = (error as Error).message; }
      finally { selection.disabled = compare.disabled = merge.disabled = false; }
    } }, 'Compare with AI');
    const merge = el('button', { class: 'btn primary', disabled: !candidates.length, onclick: async () => {
      const source = selected();
      if (!source || this.survey !== s || !s.candidates.includes(target) || !s.candidates.includes(source)) return;
      selection.disabled = compare.disabled = merge.disabled = true;
      try {
        const grouped = mergeCandidateGroup(s, target, source, observations);
        await surveyDb.replaceCandidateGroup([target.id, source.id], [grouped]);
        s.candidates = s.candidates.filter((c) => c.id !== source.id).map((c) => c.id === target.id ? grouped : c);
        this.recordPinUndo(s.id, { candidateId: target.id, label: 'Undo grouping', group: { before: structuredClone([target, source]), afterIds: [target.id] } });
        this.selectedFieldCandidateId = target.id;
        this.mapView.setCandidates(s.candidates); this.mapView.setSelectedCandidate(target.id);
        dialog.close(); this.refreshCandidateEditor();
      } catch (error) { verdict.textContent = (error as Error).message; selection.disabled = compare.disabled = merge.disabled = false; }
    } }, 'Confirm same object and group');
    selection.onchange = redraw;
    appendLocalized(dialog, el('div', { class: 'photo-details-header' }, el('h2', {}, 'Group same object'), close),
      el('p', {}, 'Select another detection of the same physical object. Objects seen separately in one photo cannot be grouped.'),
      el('p', {}, 'AI comparison sends these saved photos to the configured service and incurs API usage. It never merges automatically.'),
      el('p', {}, 'Conflicting tags retain the values of the current card. Separation restores the original cards.'),
      candidates.length ? selection : el('p', {}, 'No compatible candidates from different photos'), preview, verdict, compare, merge);
    redraw();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  }

  private async separateCandidateGroup(candidate: FeatureCandidate): Promise<void> {
    const s = this.survey, originals = candidate.mergeSources;
    if (!s || !originals?.length || !s.candidates.includes(candidate)) return;
    try {
      await surveyDb.replaceCandidateGroup([candidate.id], originals);
      s.candidates = s.candidates.filter((c) => c.id !== candidate.id);
      s.candidates.push(...structuredClone(originals));
      this.recordPinUndo(s.id, { candidateId: candidate.id, label: 'Undo separation', group: { before: [structuredClone(candidate)], afterIds: originals.map((c) => c.id) } });
      this.selectedFieldCandidateId = null;
      this.mapView.setCandidates(s.candidates); this.mapView.setSelectedCandidate(null);
      this.refreshCandidateEditor();
    } catch (error) { toast((error as Error).message); }
  }

  private async onDeleteCandidate(c: FeatureCandidate): Promise<void> {
    if (!this.survey) return;
    const undo: PinUndo = { candidateId: c.id, label: 'Undo delete pin', deleted: structuredClone(c),
      index: this.survey.candidates.findIndex((item) => item.id === c.id) };
    await surveyDb.deleteCandidate(c.id);
    this.survey.candidates = this.survey.candidates.filter((item) => item.id !== c.id);
    this.recordPinUndo(this.survey.id, undo);
    if (this.selectedFieldCandidateId === c.id) this.selectedFieldCandidateId = null;
    this.mapView.setSelectedCandidate(this.selectedFieldCandidateId);
    this.mapView.setCandidates(this.survey.candidates);
    this.refreshCandidateEditor();
    toast('Pin deleted — use Undo to restore');
  }

  /** Issue #9: apply the OSM mapping chosen for a review-only candidate. */
  private async onMappingChosen(c: FeatureCandidate, m: OsmMapping): Promise<void> {
    const all = mappingsFor(c.featureType);
    c.tags = applyMappingToTags(c.tags, m, all.length > 0 ? all : [m]);
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  /** Issue #8: discard the aerial refinement — the ground-survey
   *  estimate becomes the working position again (the refinement stays
   *  in the provenance chain as unapplied). */
  private async onRevertRefinement(c: FeatureCandidate): Promise<void> {
    const s = this.survey;
    const ps = c.positionSolution;
    if (!s || !ps?.refinedPosition || ps.snappedPosition != null || ps.refinementApplied === false) return;
    c.lat = ps.estimatedPosition.lat;
    c.lon = ps.estimatedPosition.lon;
    ps.refinementApplied = false;
    await surveyDb.updateCandidate(c);
    this.mapView.setCandidates(s.candidates);
    this.refreshCandidateEditor();
    toast('Reverted to ground-survey estimate');
  }

  /** Issue #8: (re-)apply the aerial refinement as the working position. */
  private async onApplyRefinement(c: FeatureCandidate): Promise<void> {
    const s = this.survey;
    const ps = c.positionSolution;
    if (!s || !ps?.refinedPosition || ps.snappedPosition != null || ps.refinementApplied !== false) return;
    c.lat = ps.refinedPosition.lat;
    c.lon = ps.refinedPosition.lon;
    ps.refinementApplied = true;
    await surveyDb.updateCandidate(c);
    this.mapView.setCandidates(s.candidates);
    this.refreshCandidateEditor();
    toast('Aerial-refined position applied');
  }

  private async onLinkExisting(c: FeatureCandidate, m: OsmMatch): Promise<void> {
    const undo = pinUndoBefore(c, true);
    mergeCandidateWithOsm(c, m);
    await surveyDb.updateCandidate(c);
    this.recordPinUndo(c.surveyId, undo);
    if (this.survey) this.mapView.setCandidates(this.survey.candidates);
    toast(`Merged with ${m.osmType}/${m.osmId}`);
    this.refreshCandidateEditor();
  }

  private recordPinUndo(surveyId: string, entry: PinUndo): void {
    const history = this.pinHistory.get(surveyId) ?? [];
    history.push(entry);
    if (history.length > 50) history.shift();
    this.pinHistory.set(surveyId, history);
    this.updateUndoButton();
  }

  private updateUndoButton(): void {
    const history = this.survey ? this.pinHistory.get(this.survey.id) : undefined;
    this.undoButton.hidden = this.mode !== 'review' && this.mode !== 'survey';
    this.undoButton.disabled = this.undoBusy || !history?.length;
    this.undoButton.textContent = t(history?.[history.length - 1]?.label ?? 'Undo');
  }

  private async undoPinEdit(): Promise<void> {
    const s = this.survey;
    const history = s && this.pinHistory.get(s.id);
    const entry = history?.[history.length - 1];
    if (!s || !entry || this.undoBusy) return;
    this.undoBusy = true;
    this.updateUndoButton();
    try {
      if (entry.group) {
        await surveyDb.replaceCandidateGroup(entry.group.afterIds, entry.group.before);
        s.candidates = s.candidates.filter((c) => !entry.group!.afterIds.includes(c.id));
        s.candidates.push(...structuredClone(entry.group.before));
        history!.pop();
        this.mapView.setCandidates(s.candidates);
        this.refreshCandidateEditor();
        toast(entry.label);
        return;
      }
      const current = s.candidates.find((c) => c.id === entry.candidateId);
      const restored = restorePinUndo(entry, current);
      if (restored) {
        await surveyDb.updateCandidate(restored);
        if (current) {
          s.candidates = s.candidates.map((c) => c.id === restored.id ? restored : c);
        } else {
          s.candidates.splice(entry.index ?? s.candidates.length, 0, restored);
        }
      } else if (current) {
          await surveyDb.deleteCandidate(current.id);
          s.candidates = s.candidates.filter((c) => c.id !== current.id);
          if (this.selectedFieldCandidateId === current.id) this.selectedFieldCandidateId = null;
      }
      history!.pop();
      this.placingCandidate = false;
      this.placingExistingCandidateId = null;
      if (this.survey?.id === s.id) {
        this.mapView.setCandidates(s.candidates);
        this.refreshCandidateEditor();
      }
      toast(entry.label);
    } catch (error) {
      toast(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.undoBusy = false;
      this.updateUndoButton();
    }
  }

  /* ---------------- upload review screen ---------------- */

  private renderUploadScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('upload', 'Review upload');
    if (s.candidates.some((c) => c.analyzer !== 'openai' && c.analyzer !== 'manual')) {
      this.content.replaceChildren(el('div', { class: 'demo-banner' }, 'Saved analysis is unverified — re-analyze photos with OpenAI before exporting'));
      this.bottombar.replaceChildren(el('button', { class: 'btn', onclick: () => { this.mode = 'review'; this.render(); } }, '← Review'));
      return;
    }

    // Export gates (issues #9/#11): geometry policy AND semantic
    // completeness are separate, explicit gates. A candidate may be
    // detected and positioned without being ready to export; unresolved
    // candidates are shown in their own sections and excluded from the
    // osmChange until resolved in review.
    const validations = new Map(
      s.candidates.map((c) => [c.id, validateCandidateExport(c)] as const)
    );
    const positionedNew = (c: FeatureCandidate): boolean =>
      c.status === 'new' && c.lat != null && c.lon != null;
    const add = s.candidates.filter((c) => positionedNew(c) && validations.get(c.id)!.exportable);
    const areaBlocked = s.candidates.filter((c) => positionedNew(c) && validations.get(c.id)!.gate === 'geometry');
    const needsTagReview = s.candidates.filter((c) => positionedNew(c) && validations.get(c.id)!.gate === 'semantics');
    const linked = s.candidates.filter((c) => c.status === 'existing' && c.linkedOsmId != null);
    // Issue #4: only node modifications can be exported (a way modify would
    // require the full node list, which the MVP does not fetch). Linked
    // ways/relations are kept as duplicate references but their modify is
    // blocked and reported explicitly.
    const modify = linked.filter((c) => (c.linkedOsmType ?? 'node') === 'node');
    const blocked = linked.filter((c) => (c.linkedOsmType ?? 'node') !== 'node');
    const legacyOmitted = s.candidates.filter((c) => c.status === 'excluded');
    const orphan = s.candidates.filter((c) => c.status === 'new' && (c.lat == null || c.lon == null));

    const commentInput = el('input', {
      id: 'cs-comment',
      class: 'note-input',
      placeholder: 'Changeset comment',
      value: `${s.name} (photo survey)`
    });

    const xmlArea = el('div', { id: 'xml-area' });

    this.content.replaceChildren(
      el(
        'div',
        { class: 'upload-section' },
        el('h2', {}, `Add ${add.length} node(s)`),
        ...add.map((c) => this.buildEditRow(c, 'add')),
        ...(add.length === 0 ? [el('div', { class: 'row' }, '—')] : [])
      ),
      ...(areaBlocked.length === 0
        ? []
        : [
            el(
              'div',
              { class: 'upload-section' },
              el('h2', {}, `Area-based (not created) ${areaBlocked.length}`),
              el(
                'div',
                { class: 'row warn' },
                'Area-based feature classes are never created from a single photo — the app does not fabricate polygon/way geometry. Link these candidates to an existing object or draw the boundary in an editor.'
              ),
              ...areaBlocked.map((c) => this.buildEditRow(c, 'add'))
            )
          ]),
      ...(needsTagReview.length === 0
        ? []
        : [
            el(
              'div',
              { class: 'upload-section' },
              el('h2', {}, `Needs tag review ${needsTagReview.length}`),
              el(
                'div',
                { class: 'row warn' },
                'Issue #11: these candidates have no reviewed, meaningful OSM tag mapping yet. Resolve them in review (choose a mapping or set tags) before they can be uploaded — a coordinate alone never becomes a new OSM node.'
              ),
              ...needsTagReview.map((c) => {
                const cls = getFeatureClass(c.featureType);
                return el(
                  'div',
                  { class: 'edit-item' },
                  `${cls?.label ?? c.featureType} — ${validations.get(c.id)!.reason}`
                );
              })
            )
          ]),
      el(
        'div',
        { class: 'upload-section' },
        el('h2', {}, `Modify ${modify.length} node(s)`),
        ...modify.map((c) => this.buildEditRow(c, 'modify')),
        ...(modify.length === 0 ? [el('div', { class: 'row' }, '—')] : [])
      ),
      ...(blocked.length === 0
        ? []
        : [
            el(
              'div',
              { class: 'upload-section' },
              el('h2', {}, `Blocked modify ${blocked.length} (way/relation)`),
              el(
                'div',
                { class: 'row warn' },
                'Way/relation modifications are not exported: a way modify requires the full node list and current structure, which the MVP does not fetch. These links are kept as duplicate references only.'
              ),
              ...blocked.map((c) => this.buildEditRow(c, 'modify'))
            )
          ]),
      el(
        'div',
        { class: 'upload-section' },
        el('h2', {}, `Missing position ${orphan.length}`),
        el(
          'div',
          { class: 'row' },
          'Candidates without a position are not uploaded.'
        ),
        ...(legacyOmitted.length ? [el('div', { class: 'row' },
          `${legacyOmitted.length} previously omitted pin(s) remain unselected for upload. Select New or delete them in review.`)] : [])
      ),
      el(
        'div',
        { class: 'upload-section' },
        el('h2', {}, 'Changeset'),
        el('div', { class: 'changeset-row' }, commentInput),
        xmlArea
      )
    );

    const total = add.length + modify.length;
    const approveBtn = el('button', {
      class: 'btn primary',
      disabled: total === 0,
      onclick: () => void this.showXml(commentInput, xmlArea)
    }, total === 0 ? 'Nothing to upload' : 'Approve & show XML');

    this.bottombar.replaceChildren(
      el('button', { class: 'btn', onclick: () => { this.mode = 'review'; this.render(); } }, '← Review'),
      approveBtn
    );
  }

  private buildEditRow(c: FeatureCandidate, kind: 'add' | 'modify'): HTMLElement {
    const cls = getFeatureClass(c.featureType);
    const tags = this.finalTags(c);
    const tagText = Object.entries(tags)
      .map(([k, v]) => `<code>${esc(`${k}=${v}`)}</code>`)
      .join(' ');
    const idPart =
      kind === 'modify' && c.linkedOsmId != null
        ? ` <code>${c.linkedOsmType ?? 'node'}/${c.linkedOsmId}</code>`
        : c.lat != null && c.lon != null
          ? ` @ ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`
          : '';
    return el('div', { class: 'edit-item' }, `${cls?.label ?? c.featureType}${idPart} — ${tagText}`);
  }

  private async showXml(commentInput: HTMLInputElement, xmlArea: HTMLElement): Promise<void> {
    const s = this.survey;
    if (!s) return;

    // Issue #4: fetch each object's CURRENT state from the OSM API immediately
    // before export. A failed fetch is an explicit conflict — the modification
    // is excluded from the file and reported, never silently dropped.
    const modifiable = s.candidates.filter(
      (c) => c.status === 'existing' && c.linkedOsmId != null && (c.linkedOsmType ?? 'node') === 'node'
    );
    const live = new Map<string, LiveOsmObject>();
    const fetchErrors = new Map<string, string>();
    const settled = await Promise.allSettled(
      modifiable.map((c) => fetchLiveObject('node', c.linkedOsmId!))
    );
    settled.forEach((r, i) => {
      const c = modifiable[i];
      if (r.status === 'fulfilled') live.set(`node/${c.linkedOsmId}`, r.value);
      else fetchErrors.set(c.id, (r.reason as Error).message);
    });

    const result = buildOsmChange(s, live);
    const comment = commentInput.value.trim() || `${s.name} (photo survey)`;

    const warn: HTMLElement[] = [];
    for (const [id, reason] of fetchErrors) {
      const c = s.candidates.find((x) => x.id === id);
      const label = c ? (getFeatureClass(c.featureType)?.label ?? c.featureType) : id;
      warn.push(
        el('div', { class: 'row warn' }, `Conflict: ${label} → node/${c?.linkedOsmId ?? '?'} modify excluded — ${reason}`)
      );
    }
    for (const b of result.blocked) {
      warn.push(
        el('div', { class: 'row warn' }, `Blocked: ${b.osmType}/${b.osmId} — way/relation modify is not supported yet (kept as a duplicate reference only)`)
      );
    }
    for (const gb of result.geometryBlocked) {
      const c = s.candidates.find((x) => x.id === gb.candidateId);
      const label = c ? (getFeatureClass(c.featureType)?.label ?? c.featureType) : gb.candidateId;
      warn.push(
        el('div', { class: 'row warn' }, `Geometry policy: ${label} (${gb.featureType}) not created — ${gb.reason}`)
      );
    }

    if (!result.xml) {
      xmlArea.replaceChildren(
        el('div', { class: 'row warn' }, 'Nothing to export: every modification conflicted or is blocked.'),
        ...warn
      );
      return;
    }

    const copyBtn = el('button', { class: 'btn accent', onclick: () => void this.copyXml(result.xml) }, 'Copy XML');
    const dlBtn = el('button', { class: 'btn', onclick: () => this.downloadXml(s, result.xml) }, 'Download .osmchange');
    xmlArea.replaceChildren(
      el(
        'div',
        { class: 'row' },
        `MVP contract: editor-import only (experimental). The file uses only the standard osmChange constructs (create/modify). Import it into an OSM editor (iD/Josm), review every change, and let the editor create the changeset. Suggested changeset comment: ${comment}`
      ),
      el('div', { class: 'xml-block' }, result.xml),
      el('div', { class: 'changeset-row' }, copyBtn, dlBtn),
      ...warn
    );
    toast('Approved — review the XML before importing it into an editor');
  }

  private async copyXml(xml: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(xml);
      toast('OSMChange XML copied to clipboard');
    } catch {
      toast('Copy failed — use Download instead');
    }
  }

  private downloadXml(s: Survey, xml: string): void {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${slug || 'survey'}.osmchange`, style: 'display:none' });
    appendLocalized(this.content, a);
    a.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    toast('Download started');
  }
}

/* ------------------------------------------------------------------ */

new App();
