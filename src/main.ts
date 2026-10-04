import './styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapView } from './map/map-view';
import { GeolocationTracker } from './capture/geolocation-tracker';
import { OrientationTracker } from './capture/orientation';
import { POSITION_QUALITY_LABEL } from './types';
import { capturePhoto, restorePhotoGps } from './capture/photo';
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
import { MockAnalyzer } from './analysis/mock-analyzer';
import { SurveyAnalysisPipeline } from './analysis/pipeline';
import { OpenAIVisionAnalyzer } from './analysis/openai-analyzer';
import { clearProxySettings, loadProxySettings, saveProxySettings } from './analysis/proxy-settings';
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
import { distanceMeters, estimatePosition, rayFromPhoto } from './analysis/position';
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
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
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
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2800);
}

function confSpan(kind: string, value: number): HTMLElement {
  return el(
    'span',
    { class: 'conf' + (value < 0.5 ? ' low' : ''), title: `${kind} confidence` },
    `${kind} ${Math.round(value * 100)}%`
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
  private recBadge: HTMLElement;

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
  /** Latest live fix, used by the GPS status when not recording. */
  private liveFix: OneShotFix | null = null;
  private gpsStatus: HTMLElement;
  private gpsPollTimer: number | undefined;
  private gpsTickTimer: number | undefined;
  private analyzing = false;
  private placingCandidate = false;
  private placingExistingCandidateId: string | null = null;
  private selectedFieldCandidateId: string | null = null;
  private selectedFieldPhotoId: string | null = null;

  /** Issue #2: batch analysis state.
   *  analyzerKind: which ImageObservationAnalyzer runs the batch.
   *  Issue #12: openaiMode selects the transport. 'proxy' is the
   *  RECOMMENDED production path (the OpenAI key lives on the proxy,
   *  never in the browser). 'direct' is EXPERIMENTAL / developer-only:
   *  the user's own key is held in memory for this session only and is
   *  NEVER persisted, logged, exported, or sent anywhere except the
   *  request to api.openai.com.
   *  analysisStatuses/analysisProgress: live batch progress + per-photo
   *  errors (partial failure is visible and retryable). */
  private analyzerKind: 'mock' | 'openai' = 'openai';
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
      this.openaiProxyEndpoint = savedProxy.settings.endpoint;
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
    const header = el('header', { class: 'topbar' }, this.backBtn, this.title);

    this.recBadge = el(
      'div',
      { id: 'rec-badge', class: 'rec-badge' },
      el('span', { class: 'dot' }),
      'REC'
    );
    // Issue #10: GPS readiness strip — visible on the survey screen
    // regardless of Record mode, so missing GPS is never silent.
    this.gpsStatus = el('div', { id: 'gps-status', class: 'gps-status hidden', role: 'status' });
    const mapWrap = el('div', { id: 'map-wrap' }, el('div', { id: 'map' }), this.recBadge, this.gpsStatus);

    this.content = el('div', { id: 'content' });
    this.bottombar = el('div', { id: 'bottombar' });

    app.append(header, mapWrap, this.content, this.bottombar, el('div', { id: 'toast' }));

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
    if (note) note.textContent = this.proxySettingsAvailable
      ? 'Proxy settings entered here are saved on this device. A saved token grants use of the proxy; do not use this on a shared device.'
      : 'Device storage is unavailable. Proxy settings are held in memory and will be lost on reload.';
  }

  private forgetProxySettings(endpointInput: HTMLInputElement, authInput: HTMLInputElement): void {
    this.proxySettingsAvailable = clearProxySettings(this.proxyStorage());
    this.openaiProxyEndpoint = '';
    this.openaiProxyAuth = '';
    endpointInput.value = '';
    authInput.value = '';
    this.updateProxyStorageNote();
    toast(this.proxySettingsAvailable
      ? 'Proxy endpoint and token cleared from this device'
      : 'Proxy fields cleared; device storage could not be updated');
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
    this.title.textContent = title;
    this.backBtn.classList.toggle('hidden', mode === 'list');
    if (mode !== 'survey') {
      this.content.classList.remove('field-inspector', 'open');
      this.content.style.bottom = '';
    }
    this.updateRecBadge();
    if (mode !== 'survey') this.stopGpsStatus();
    requestAnimationFrame(() => this.mapView.map.resize());
  }

  private updateRecBadge(): void {
    this.recBadge.classList.toggle('on', this.tracker != null && (this.mode === 'survey' || this.mode === 'camera'));
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
      el('button', { class: 'btn primary', onclick: () => void this.newSurvey() }, '+ New survey')
    );

    const metas = await surveyDb.listSurveys();
    if (metas.length === 0) {
      this.content.replaceChildren(
        el(
          'div',
          { class: 'empty-hint' },
          'No surveys yet.\nStart one, walk around, photograph interesting objects, then map the photos.'
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

  private async newSurvey(): Promise<void> {
    const survey: Survey = {
      id: `survey-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `Survey ${new Date().toLocaleDateString()}`,
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
    this.tracker = null;
    this.mode = 'survey';
    // Issue #3: request orientation access at survey start (this is a
    // user gesture, satisfying the iOS requirement) so the
    // OrientationTracker — the single normalized orientation path — is
    // live BEFORE the first photo, not only when the photo button is
    // pressed. Idempotent; the photo button calls it again.
    this.orientationTracker.start();
    this.render();
  }

  private async openSurvey(survey: Survey): Promise<void> {
    this.survey = survey;
    this.selectedFieldCandidateId = null;
    this.selectedFieldPhotoId = null;
    // The tracker is runtime state: a restored survey is never actively
    // recording. Repair any stale persisted recording flag (issue #6).
    this.tracker = null;
    if (survey.recording) {
      survey.recording = false;
      void surveyDb.saveSurveyMeta(survey);
    }
    // Issue #3: ensure the normalized orientation path is live when the
    // survey opens (user gesture; idempotent), so camera headings are
    // available from the very first capture.
    this.orientationTracker.start();
    this.mode = 'survey';
    this.render();
  }

  private async deleteSurvey(id: string, e: Event): Promise<void> {
    e.stopPropagation();
    if (!window.confirm('Delete this survey and all of its data?')) return;
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
    this.updateRecBadge();
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
      accept: 'image/*',
      capture: 'environment',
      style: 'display:none',
      onchange: () => void this.onPhotoTaken(photoInput)
    });
    const note = el('input', { id: 'photo-note', class: 'note-input', placeholder: 'Note (e.g. bench)' });
    const recBtn = el(
      'button',
      {
        id: 'rec-btn',
        class: 'btn' + (s.recording ? ' rec-on' : ''),
        onclick: () => void this.toggleRecording()
      },
      s.recording ? '⏹ Stop' : '⏺ Record'
    );
    const camBtn = el(
      'button',
      {
        class: 'btn accent',
        onclick: () => {
          // Issue #10: start the one-shot GPS fix and open the camera/file
          // input IN THE SAME user gesture. Awaiting the fix first would
          // lose the transient user activation and the camera would not
          // open. The fix is awaited (bounded) in onPhotoTaken instead.
          this.pendingFix = requestOneShotFix(15_000);
          // Issue #3: the orientation permission (iOS) also requires a user
          // gesture, so start the tracker in this same gesture.
          this.orientationTracker.start();
          // Issue #13 phase 1: record the picker launch moment NOW (in this
          // user gesture) — it is the earliest instant the external camera
          // could possibly have composed the shot. Orientation readings
          // taken before this are pre-camera evidence, never bearing.
          this.pickerLaunchTs = Date.now();
          photoInput.click();
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
      { class: 'btn', onclick: () => void this.openInAppCamera() },
      '📸 In-app'
    );

    this.bottombar.replaceChildren(
      recBtn,
      camBtn,
      ...(InAppCamera.available() ? [inappBtn] : []),
      note,
      mapBtn,
      photoInput
    );

    void this.renderFieldInspector();

    // Issue #10: keep the GPS readiness indicator live on the field
    // screen, independent of Record mode.
    this.startGpsStatus();
  }

  private selectFieldCandidate(id: string): void {
    if (this.mode !== 'survey' || !this.survey?.candidates.some((c) => c.id === id)) return;
    this.selectedFieldCandidateId = id;
    this.selectedFieldPhotoId = null;
    const candidate = this.survey.candidates.find((c) => c.id === id);
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
      ...s.photos.map((p, index) => el('button', {
        class: 'field-photo-button' + (photo?.id === p.id ? ' selected' : ''),
        'aria-label': `Open photo ${index + 1}`,
        onclick: () => this.selectFieldPhoto(p.id)
      }, p.image ? el('img', { src: p.image, alt: '' }) : `Photo ${index + 1}`)),
      ...s.candidates.map((c, index) => el('button', {
        class: 'btn small' + (candidate?.id === c.id ? ' selected' : ''),
        onclick: () => this.selectFieldCandidate(c.id)
      }, `${index + 1}: ${getFeatureClass(c.featureType)?.label ?? c.featureType}`)),
      ...(open ? [el('button', { class: 'btn small', 'aria-label': 'Close inspector', onclick: () => {
        this.selectedFieldCandidateId = null;
        this.selectedFieldPhotoId = null;
        void this.renderFieldInspector();
      } }, 'Close')]: [])
    );
    const details = el('div', { class: 'field-details' });
    if (candidate) {
      if (candidate.analyzer !== 'openai' && candidate.analyzer !== 'manual') {
        details.append(el('div', { class: 'demo-banner' }, 'MOCK / DEMO RESULT or unverified legacy analysis — export disabled'));
      }
      details.append(this.buildCandidateCard(candidate, photoByObs, obsById));
    } else if (photo) {
      const related = s.candidates.filter((c) => c.observationIds.some((id) => obsById.get(id)?.photoId === photo.id));
      details.append(
        el('div', { class: 'candidate' },
          el('div', { class: 'head' }, el('strong', {}, 'Photo')),
          ...(photo.image ? [el('img', { class: 'field-photo-full', src: photo.image, alt: 'Captured source photo' })] : []),
          el('div', { class: 'row' }, `Captured: ${new Date(photo.timestamp).toLocaleString()} (${photo.timestampSource ?? 'unknown time source'})`),
          el('div', { class: 'row' }, photo.cameraPosition
            ? `Camera: ${describeCameraPosition(photo.cameraPosition)} @ ${photo.cameraPosition.lat.toFixed(5)}, ${photo.cameraPosition.lon.toFixed(5)}`
            : 'Camera: no GPS'),
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

  private async toggleRecording(): Promise<void> {
    const s = this.survey;
    if (!s) return;

    if (this.tracker) {
      this.stopRecordingNow();
    } else {
      const t = new GeolocationTracker(s.id, (sample) => {
        s.gpsSamples.push(sample);
        this.mapView.setTrack(s);
      });
      try {
        await t.start();
        this.tracker = t;
        s.recording = true;
        toast('Recording GPS track');
      } catch {
        this.tracker = null;
        s.recording = false;
        toast('Location permission denied — GPS tracking unavailable');
      }
    }

    s.recording = this.tracker != null;
    await surveyDb.saveSurveyMeta(s);
    this.updateRecBadge();

    const btn = this.bottombar.querySelector<HTMLButtonElement>('#rec-btn');
    if (btn) {
      btn.classList.toggle('rec-on', s.recording);
      btn.textContent = s.recording ? '⏹ Stop' : '⏺ Record';
    }
  }

  private stopRecordingNow(): void {
    this.tracker?.stop();
    this.tracker = null;
    this.updateRecBadge();
    if (this.survey) {
      this.survey.recording = false;
      void surveyDb.saveSurveyMeta(this.survey);
    }
  }

  /* ---------------- GPS readiness status (issue #10) ---------------- */

  /** Keep the GPS readiness strip live on the survey screen, independent
   *  of Record mode. Idempotent: safe to call on every render. */
  private startGpsStatus(): void {
    this.gpsStatus.classList.remove('hidden');
    window.clearInterval(this.gpsTickTimer);
    this.gpsTickTimer = window.setInterval(() => this.refreshGpsStatus(), 1000);
    // Poll a live fix only while the track recorder is inactive (it
    // already streams samples then). Refresh every 5 s; each poll is a
    // bounded one-shot request that resolves to null on denial/timeout.
    window.clearInterval(this.gpsPollTimer);
    const poll = (): void => {
      if (this.tracker) return;
      void requestOneShotFix(8000).then((fix) => {
        if (fix && this.mode === 'survey') {
          this.liveFix = fix;
          this.refreshGpsStatus();
        }
      });
    };
    poll();
    this.gpsPollTimer = window.setInterval(poll, 5000);
    this.refreshGpsStatus();
  }

  private stopGpsStatus(): void {
    window.clearInterval(this.gpsTickTimer);
    this.gpsTickTimer = undefined;
    window.clearInterval(this.gpsPollTimer);
    this.gpsPollTimer = undefined;
    this.gpsStatus.classList.add('hidden');
  }

  private refreshGpsStatus(): void {
    const s = this.survey;
    if (!s) return;
    const now = Date.now();
    // While recording, the newest track sample IS the live fix.
    const last = s.gpsSamples[s.gpsSamples.length - 1];
    const fromTrack = this.tracker != null && last != null;
    const fix: OneShotFix | null = fromTrack
      ? { lat: last.lat, lon: last.lon, accuracy: last.accuracy, timestamp: last.timestamp }
      : this.liveFix;
    const state = classifyGps(fix, now);
    const photoPosition = [...s.photos].reverse().find((p) => p.cameraPosition)?.cameraPosition;
    const photoNote = photoPosition
      ? `Photo ${describeCameraPosition(photoPosition)}: ${photoPosition.lat.toFixed(5)}, ${photoPosition.lon.toFixed(5)}`
      : '';
    this.gpsStatus.textContent = !fix && photoNote
      ? `Live GPS unavailable · ${photoNote}`
      : formatGpsStatus(fix, now, s.gpsSamples.length, fromTrack ? 'track' : 'live') + (photoNote ? ` · ${photoNote}` : '');
    this.gpsStatus.className = `gps-status gps-${!fix && photoNote ? 'photo' : state}`;
  }

  private async onPhotoTaken(input: HTMLInputElement): Promise<void> {
    const s = this.survey;
    const file = input.files?.[0];
    if (!s || !file) return;
    input.value = '';

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
      this.mapView.setPhotos(s.photos);
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
      ? ` · cam: ${describeCameraPosition(photo.cameraPosition)} ${photo.cameraPosition.lat.toFixed(5)}, ${photo.cameraPosition.lon.toFixed(5)}`
      : ' · no GPS — needs manual positioning';
    let hdgNote = '';
    if (photo.cameraHeading) {
      const ch = photo.cameraHeading;
      hdgNote = ` · cam hdg ${ch.bearing.toFixed(0)}° (${ch.source}, ±${ch.uncertaintyDeg}°, age ${Math.round(ch.ageMs / 1000)} s)`;
    } else {
      hdgNote = ` · no camera heading${photo.headingNote ? `: ${photo.headingNote}` : ''}`;
    }
    return `Photo captured (${count})${srcNote}${camNote}${hdgNote}`;
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
    this.updateRecBadge();

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
          this.mode = 'analysis';
          this.render();
        }
      },
      'Map photos'
    );

    this.content.replaceChildren(
      video,
      el('div', { class: 'camera-status' }, el('div', {}, orientLine), el('div', {}, gpsLine)),
      shutterBtn
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
    if (this.analyzerKind === 'openai') {
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
        apiKey: key,
        ...(model ? { model } : {})
      });
    }
    return new MockAnalyzer();
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
          obs.analyzer = analyzer.name === 'openai' ? 'openai' : 'mock';
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
      this.survey = fresh;
      this.analysisResult = result;
      this.stopRecordingNow();

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
    const endpointInput = el('input', {
      type: 'url',
      id: 'openai-proxy-endpoint',
      class: 'note-input',
      placeholder: 'https://your-proxy.example/responses',
      value: this.openaiProxyEndpoint,
      oninput: () => {
        this.openaiProxyEndpoint = (endpointInput as HTMLInputElement).value;
        this.persistProxySettings();
      }
    });
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
      placeholder: 'Model (default: gpt-4o-mini)',
      value: this.openaiModel,
      oninput: () => { this.openaiModel = (modelInput as HTMLInputElement).value; }
    });
    const proxyFields = el(
      'div',
      { class: 'transport-fields', 'data-transport': 'proxy' },
      el('div', { class: 'field' }, el('label', { for: 'openai-proxy-endpoint' }, 'Proxy endpoint'), endpointInput),
      el('div', { class: 'field' }, el('label', { for: 'openai-proxy-auth' }, 'Proxy token'), authInput),
      el('div', { id: 'proxy-storage-note', class: 'hint warn' }),
      el('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => this.forgetProxySettings(endpointInput as HTMLInputElement, authInput as HTMLInputElement)
      }, 'Forget / Clear proxy settings')
    );
    const modelField = el('div', { class: 'field' }, el('label', { for: 'openai-model' }, 'Model'), modelInput);
    let openaiPanel: TagEl<'div'>;
    if (isProd) {
      // Public build: proxy-only, no key field (issue #12).
      this.openaiMode = 'proxy';
      openaiPanel = el(
        'div',
        { class: 'analyzer-panel' },
        el(
          'div',
          { class: 'hint' },
          'Transport: proxy (this public build is proxy-only — issue #12). The OpenAI key stays on the proxy server and never reaches this browser. Configure your proxy endpoint below.'
        ),
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

    const kindMock = el(
      'label',
      { class: 'radio-row' },
      el(
        'input',
        {
          type: 'radio',
          name: 'analyzer',
          value: 'mock',
          checked: this.analyzerKind === 'mock',
          onchange: () => {
            this.analyzerKind = 'mock';
            this.content.dataset.analyzer = 'mock';
            this.updateAnalysisBanner();
          }
        }
      ),
      ' Mock (offline demo)'
    );
    const kindOpenai = el(
      'label',
      { class: 'radio-row' },
      el(
        'input',
        {
          type: 'radio',
          name: 'analyzer',
          value: 'openai',
          checked: this.analyzerKind === 'openai',
          onchange: () => {
            this.analyzerKind = 'openai';
            this.content.dataset.analyzer = 'openai';
            this.updateAnalysisBanner();
          }
        }
      ),
      ' OpenAI vision (BYOK / proxy)'
    );

    const progressBox = el('div', { id: 'analysis-progress', class: 'analysis-progress' });
    const resultBox = el('div', { id: 'analysis-result', class: 'analysis-result' });

    this.content.replaceChildren(
      el(
        'div',
        { class: 'analysis-screen' },
        el('div', { id: 'analysis-demo-banner', class: 'demo-banner', hidden: this.analyzerKind !== 'mock' && this.analysisResult?.analyzerName !== 'mock' }, 'MOCK / DEMO RESULT — fabricated detections; export disabled'),
        el('div', { class: 'section-title' }, 'Analyzer'),
        kindMock,
        kindOpenai,
        openaiPanel,
        el('div', { class: 'section-title' }, `${s.photos.length} photo(s)`),
        el('div', { class: 'section-title' }, 'Batch progress'),
        progressBox,
        resultBox
      )
    );
    this.content.dataset.analyzer = this.analyzerKind;
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

  private updateAnalysisBanner(): void {
    const banner = this.content.querySelector<HTMLElement>('#analysis-demo-banner');
    if (banner) banner.hidden = this.analyzerKind !== 'mock' && this.analysisResult?.analyzerName !== 'mock';
  }

  /** Live batch progress (issue #2): in-place DOM update so input focus
   *  is preserved while photos are processed one by one. */
  private updateAnalysisProgressDom(): void {
    const box = this.content.querySelector<HTMLElement>('#analysis-progress');
    if (!box) return;
    const lines: Node[] = [];
    if (this.analyzing) {
      lines.push(el('div', { class: 'analysis-status running' }, `Analyzing ${this.analysisProgress}…`));
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
    const box = this.content.querySelector<HTMLElement>('#analysis-result');
    if (!box) return;
    const btn = this.bottombar.querySelector<HTMLButtonElement>('#analyze-btn');
    if (btn) btn.disabled = this.analyzing;

    const result = this.analysisResult;
    this.updateAnalysisBanner();
    if (this.analyzing || !result) {
      box.replaceChildren();
      return;
    }
    const failed = result.photoStatuses?.filter((st) => st.status === 'error') ?? [];
    const lines: Node[] = [
      el('div', { class: 'analysis-summary' },
        `${result.candidates.length} candidate(s) from ${result.observations.length} observation(s) — analyzer: ${result.analyzerName ?? this.analyzerKind}`)
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
        ? [el('div', { class: 'demo-banner' }, 'MOCK / DEMO RESULT or unverified legacy analysis — export disabled')]
        : []),
      ...(s.candidates.length === 0 ? [el('div', { class: 'empty-hint' }, 'No candidates yet. Add a pin on the map, or capture photos and press Map photos.')] : []),
      el('div', { class: 'section-title' }, `Candidates (${s.candidates.length})`),
      ...cards
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

  private buildCandidateCard(
    c: FeatureCandidate,
    photoByObs: Map<string, Photo | undefined>,
    obsById: Map<string, Observation>
  ): HTMLElement {
    const cls = getFeatureClass(c.featureType);
    const card = el('div', { class: `candidate status-${c.status}` });

    const evidence = c.observationIds.map((id) => obsById.get(id)).filter((o): o is Observation => !!o);
    const first = evidence.find((o) => !!photoByObs.get(o.id)?.image);
    const img = first ? photoByObs.get(first.id)?.image ?? '' : '';
    const thumb = c.analyzer === 'manual' ? el('span', { class: 'manual-thumb', 'aria-hidden': 'true' }, '📍')
      : el('img', { class: 'thumb', src: img || undefined, alt: 'source photo' });

    const statusSel = el('select', {
      class: 'status-sel',
      'aria-label': 'Candidate status',
      onchange: () => void this.onStatusChange(c, statusSel)
    },
      ...(['new', 'existing', 'excluded'] as CandidateStatus[]).map((v) =>
        el('option', { value: v }, v[0].toUpperCase() + v.slice(1))
      )
    );
    statusSel.value = c.status;

    card.append(
      el('div', { class: 'head' }, thumb, el('div', { class: 'type' }, cls?.label ?? (c.analyzer === 'manual' ? 'Custom tags' : c.featureType)), statusSel)
    );
    card.append(el('div', { class: 'row' }, `Source: ${c.analyzer === 'openai' ? `OpenAI / ${c.analyzerModel ?? 'model unknown'}` : c.analyzer === 'manual' ? 'Placed manually on map' : c.analyzer === 'mock' ? 'Mock (fabricated)' : 'Unverified or mixed source'}`));
    if (c.analyzer === 'manual') card.append(el('div', { class: 'row' }, 'No source photo — manually placed candidate'));
    if (c.analyzer === 'manual') {
      const classSelect = el('select', { 'aria-label': 'Feature type', onchange: () => void this.onManualClassChanged(c, classSelect) },
        el('option', { value: 'manual' }, 'Custom tags'),
        ...FEATURE_CLASSES.map((cls) => el('option', { value: cls.id }, cls.label))
      );
      classSelect.value = c.featureType;
      card.append(el('div', { class: 'row' }, 'Feature type: ', classSelect),
        el('button', { class: 'btn small', onclick: () => void this.onDeleteManualCandidate(c) }, 'Delete pin'));
    }
    if (c.analyzer !== 'manual') card.append(el('div', { class: 'row' }, `Contributing observations: ${evidence.length} from ${new Set(evidence.map((o) => o.photoId)).size} photo(s)`));
    for (const obs of evidence) {
      const sourceImage = photoByObs.get(obs.id)?.image;
      if (sourceImage) {
        const box = obs.bbox;
        card.append(el('div', { class: 'evidence-photo' },
          el('img', { src: sourceImage, alt: `Source photo with ${obs.featureType} detection box` }),
          el('div', { class: 'evidence-box', style: `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%` })
        ));
      }
      card.append(el('div', { class: 'row' },
        `Detection: ${obs.featureType} ${obs.detectionConfidence == null ? 'confidence unknown' : `${Math.round(obs.detectionConfidence * 100)}%`} · `,
        `Distance: ${obs.distanceEstimate == null ? 'unknown' : `${obs.distanceEstimate.toFixed(0)} m${obs.distanceUncertaintyM == null ? '' : ` ±${obs.distanceUncertaintyM.toFixed(0)} m`}`} · `,
        `OCR: ${obs.textSeen ? `${obs.textSeen}${obs.ocrConfidence == null ? '' : ` (${Math.round(obs.ocrConfidence * 100)}%)`}` : 'none'}`
      ));
      card.append(el('div', { class: 'row' }, `Suggested attributes/tags: ${Object.entries(obs.tagSuggestions).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`));
    }

    // Issue #9: review-only class — the OSM mapping is uncertain/ambiguous,
    // so nothing is applied automatically; the reviewer decides.
    if (cls && !cls.autoTag) {
      card.append(
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
      card.append(
        el(
          'div',
          { class: 'needs-tag-review', title: 'Semantic export gate (issue #11)' },
          `Needs tag review: ${exportCheck.reason}`
        )
      );
    }

    const posRow = el('div', { class: 'row' });
    if (c.lat != null && c.lon != null) {
      posRow.append(
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
          ? ` · σ ${c.positionUncertaintyMeters.toFixed(0)} m`
          : '',
        ' '
      );
    } else {
      const hasCameraGps = c.observationIds.some((id) => photoByObs.get(id)?.gps)
        || (evidence.length === 0 && this.survey?.photos.length === 1 && !!this.survey.photos[0].gps);
      posRow.append(el('b', {}, 'Position'), hasCameraGps
        ? ' unknown — camera GPS locates the photo, not the photographed object. '
        : ' unknown — no usable camera GPS was read from the photo. ');
    }
    if (this.mode === 'review') posRow.append(el('button', { class: 'btn small', onclick: () => {
      this.placingCandidate = false;
      this.placingExistingCandidateId = this.placingExistingCandidateId === c.id ? null : c.id;
      if (c.lat == null || c.lon == null) {
        const photo = c.observationIds.map((id) => photoByObs.get(id)).find((p) => p?.gps);
        if (photo?.gps) this.mapView.map.jumpTo({ center: [photo.gps.lon, photo.gps.lat], zoom: 18 });
      }
      void this.renderReviewScreen(true);
    } }, this.placingExistingCandidateId === c.id ? 'Cancel placement' : c.lat == null ? 'Place pin on map' : 'Move pin on map'));
    card.append(posRow);
    card.append(el('div', { class: 'row' }, `OSM mapping: ${Object.entries(c.tags).map(([k, v]) => `${k}=${v}`).join(', ') || 'unresolved'}`));

    // Issue #10: the camera position and its provenance must be visible to
    // the reviewer — it is evidence for the object's location, and a
    // missing/stale fix must be an explicit, visible fact.
    const cam = c.observationIds
      .map((id) => photoByObs.get(id)?.cameraPosition)
      .find((v) => v != null)
      ?? (evidence.length === 0 && this.survey?.photos.length === 1 ? this.survey.photos[0].cameraPosition : undefined);
    if (c.analyzer !== 'manual') card.append(
      el(
        'div',
        { class: 'row cam-row' },
        el('b', {}, 'Camera'),
        cam
          ? ` ${describeCameraPosition(cam)} @ ${cam.lat.toFixed(5)}, ${cam.lon.toFixed(5)}`
          : ' no GPS — position needs manual placement.'
      )
    );
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
        type: 'file', accept: 'image/jpeg,image/*', 'aria-label': 'Select original photo to restore GPS',
        onchange: async () => {
          const file = fileInput.files?.[0];
          if (file) await this.onRestorePhotoGps(photo, file);
          fileInput.value = '';
        }
      });
      fileInput.style.display = 'none';
      card.append(el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => fileInput.click() }, 'Read GPS from original photo'),
        fileInput
      ));
    }
    if (c.analyzer !== 'manual' && evidence.length === 0 && this.survey?.photos.length === 1) {
      card.append(el('div', { class: 'row' }, 'Saved detection details are unavailable. Re-run photo analysis to estimate the object position, or place its pin on the map.'));
    }

    // Issue #3: camera-bearing evidence. Show the bearing WITH its
    // provenance (source, uncertainty, age), or an explicit, visible
    // reason why no camera bearing is available (stale or post-return
    // reading, no sensor, relative-only orientation). The movement
    // heading (direction of travel) is shown separately and labeled as
    // NOT a camera bearing.
    const hdgPhoto = c.observationIds
      .map((id) => photoByObs.get(id))
      .find((p) => p != null && (p.cameraHeading != null || p.headingNote != null));
    if (hdgPhoto?.cameraHeading) {
      const ch = hdgPhoto.cameraHeading;
      card.append(
        el(
          'div',
          { class: 'row heading-row' },
          el('b', {}, 'Cam heading'),
          ` ${ch.bearing.toFixed(0)}° · ${ch.source} · ±${ch.uncertaintyDeg}° · age ${Math.round(ch.ageMs / 1000)} s${ch.detail ? ` · ${ch.detail}` : ''}`
        )
      );
    } else if (hdgPhoto?.headingNote) {
      card.append(
        el(
          'div',
          { class: 'row heading-row heading-missing' },
          el('b', {}, 'Cam heading'),
          ` none — ${hdgPhoto.headingNote}`
        )
      );
    }
    if (hdgPhoto?.movementHeading != null) {
      card.append(
        el(
          'div',
          { class: 'row heading-row movement-row' },
          el('b', {}, 'Movement'),
          ` hdg ${hdgPhoto.movementHeading.toFixed(0)}° (direction of travel — NOT a camera bearing)`
        )
      );
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
      const solRow = el('div', { class: 'row solution-row' }, el('b', {}, 'Solution'), ` ${steps.join(' → ')}`, ` · σ ${ps.uncertaintyMeters.toFixed(0)} m`);
      for (const e of ps.evidence) {
        solRow.append(el('span', { class: 'ev-chip', title: e.detail ?? e.label }, e.label));
      }
      // Issue #8: the aerial refinement is a reviewable, reversible
      // proposal — show which position is working, the imagery
      // provenance, and an explicit revert/apply control.
      const snapped = ps.snappedPosition != null && ps.linkedOsmId != null;
      // Issue #9: review-only classes are never auto-snapped — unconfirmed
      // OSM semantics must not drive object identity.
      if (!snapped && cls && !cls.autoTag) {
        solRow.append(el('span', { class: 'review-only-note' }, ' · no auto-snap (review-only class)'));
      }
      // Attribution is shown whenever imagery contributed — including as
      // the base position a snap was evaluated from.
      if (ps.refinedPosition && ps.imagerySource) {
        solRow.append(
          el('span', { class: 'imagery-attr', title: 'Imagery source used for position refinement' }, ` · Imagery: ${ps.imagerySource}`)
        );
      }
      if (ps.refinedPosition && !snapped) {
        if (ps.refinementApplied !== false) {
          solRow.append(
            el('span', { class: 'working-tag' }, ' · working: refined'),
            el('button', {
              class: 'btn small revert-btn',
              title: 'Discard the aerial correction and keep the ground-survey estimate',
              onclick: () => void this.onRevertRefinement(c)
            }, '↩ Revert to ground estimate')
          );
        } else {
          solRow.append(
            el('span', { class: 'working-tag' }, ' · working: ground estimate'),
            el('button', {
              class: 'btn small apply-btn',
              title: 'Use the aerial-refined position as the working position',
              onclick: () => void this.onApplyRefinement(c)
            }, 'Apply aerial correction')
          );
        }
      }
      card.append(solRow);
    }

    card.append(
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
      card.append(
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
        picker.append(el('label', { class: 'mapping-opt' }, radio, ` ${m.label}${m.hint ? ` — ${m.hint}` : ''}`));
      }
      card.append(picker);
    }

    // Issue #9: geometry policy — area-based classes are never created from
    // a single photo; show the reviewer the alternatives.
    const geomPref = geometryPreferenceFor(c.featureType);
    if (c.status === 'new' && (geomPref === 'area' || geomPref === 'existing-only')) {
      card.append(
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
      card.append(
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
      card.append(el('div', { class: 'suggest-row' }, 'Set value (only if visible in photo):', ...picks));
    }

    const nameInput = el('input', {
      class: 'name-input',
      placeholder: 'Name (optional)',
      value: c.name ?? '',
      onchange: () => void this.onNameChanged(c, nameInput)
    });
    card.append(el('div', { class: 'name-row' }, nameInput));

    if (c.warnings.length > 0) {
      card.append(el('div', { class: 'warnings' }, el('ul', {}, ...c.warnings.map((w) => el('li', {}, w)))));
    }

    if (c.osmMatches.length > 0) {
      card.append(
        el(
          'div',
          { class: 'osm-matches' },
          'Nearby in OSM (distance from current pin; score is not identity confidence):',
          ...c.osmMatches.map((m) => this.buildOsmMatchRow(c, m))
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
      el(
        'button',
        {
          class: 'link-btn',
          disabled: linked,
          onclick: linked ? undefined : () => void this.onLinkExisting(c, m)
        },
        linked ? 'Linked' : 'Link'
      )
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
    const v = window.prompt(`Edit value for "${key}=" (leave empty to remove):`, c.tags[key] ?? '');
    if (v == null) return;
    const val = v.trim();
    if (val) c.tags[key] = val;
    else delete c.tags[key];
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private buildAddTagRow(c: FeatureCandidate): HTMLElement {
    const kInput = el('input', { class: 'tag-key', placeholder: 'key', maxlength: 50 });
    const vInput = el('input', { class: 'tag-value', placeholder: 'value' });
    return el(
      'div',
      { class: 'add-tag-row' },
      kInput,
      vInput,
      el('button', { class: 'btn small', onclick: () => void this.onAddTag(c, kInput, vInput) }, '+ tag')
    );
  }

  private async onAddTag(c: FeatureCandidate, kInput: HTMLInputElement, vInput: HTMLInputElement): Promise<void> {
    const k = kInput.value.trim();
    const v = vInput.value.trim();
    if (!k) {
      toast('Tag key is required');
      return;
    }
    c.tags[k] = v;
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
    c.lat = lat;
    c.lon = lon;
    c.positionConfidence = Math.min(c.positionConfidence, 0.3);
    if (!c.warnings.includes('Position set manually by reviewer.')) {
      c.warnings.push('Position set manually by reviewer.');
    }
    c.warnings = c.warnings.filter((warning) => !warning.startsWith('No usable camera GPS position for this observation.'));
    await surveyDb.updateCandidate(c);
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
    this.render();
  }

  private async onManualClassChanged(c: FeatureCandidate, select: HTMLSelectElement): Promise<void> {
    const cls = getFeatureClass(select.value);
    c.featureType = select.value;
    c.tags = cls?.autoTag ? { ...cls.requiredTags } : {};
    await surveyDb.updateCandidate(c);
    this.refreshCandidateEditor();
  }

  private async onDeleteManualCandidate(c: FeatureCandidate): Promise<void> {
    if (!this.survey || c.analyzer !== 'manual') return;
    await surveyDb.deleteCandidate(c.id);
    this.survey.candidates = this.survey.candidates.filter((item) => item.id !== c.id);
    if (this.selectedFieldCandidateId === c.id) this.selectedFieldCandidateId = null;
    this.mapView.setCandidates(this.survey.candidates);
    this.refreshCandidateEditor();
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
    c.linkedOsmId = m.osmId;
    c.linkedOsmType = m.osmType;
    c.status = 'existing';
    await surveyDb.updateCandidate(c);
    toast(`Linked to ${m.osmType}/${m.osmId}`);
    this.refreshCandidateEditor();
  }

  /* ---------------- upload review screen ---------------- */

  private renderUploadScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('upload', 'Review upload');
    if (s.candidates.some((c) => c.analyzer !== 'openai' && c.analyzer !== 'manual')) {
      this.content.replaceChildren(el('div', { class: 'demo-banner' }, 'MOCK / DEMO RESULT or unverified legacy analysis — export disabled'));
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
    const excluded = s.candidates.filter((c) => c.status === 'excluded');
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
        el('h2', {}, `Excluded ${excluded.length} · Missing position ${orphan.length}`),
        el(
          'div',
          { class: 'row' },
          'Excluded candidates and candidates without a position are not uploaded.'
        )
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
    this.content.append(a);
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
