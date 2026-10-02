import './styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapView } from './map/map-view';
import { GeolocationTracker } from './capture/geolocation-tracker';
import { capturePhoto } from './capture/photo';
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
import { annotateCandidate, fetchOsmInArea, type LatLon } from './osm/overpass';
import { buildOsmChange } from './osm/osmchange';
import { fetchLiveObject, type LiveOsmObject } from './osm/osm-api';
import {
  applyMappingToTags,
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
import { distanceMeters } from './analysis/position';
import { selectProvider } from './imagery/providers';
import type {
  CandidateStatus,
  FeatureCandidate,
  Photo,
  Observation,
  OsmMatch,
  PositionSolution,
  Survey
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

type Mode = 'list' | 'survey' | 'review' | 'upload';

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
  /** One-shot GPS fix started in the photo button's gesture (issue #10). */
  private pendingFix: Promise<OneShotFix | null> | null = null;
  /** Latest live fix, used by the GPS status when not recording. */
  private liveFix: OneShotFix | null = null;
  private gpsStatus: HTMLElement;
  private gpsPollTimer: number | undefined;
  private gpsTickTimer: number | undefined;
  private analyzing = false;

  constructor() {
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
      (id, lat, lon) => void this.onPinDragged(id, lat, lon)
    );

    // Issue #6: a persisted `recording=true` flag from a crashed session is
    // stale — recording is a RUNTIME state that only exists while a live
    // GeolocationTracker is active. Repair old records at startup so the
    // survey list never shows a phantom "recording" status.
    void this.repairStaleRecordingFlags();

    this.render();
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
    if (mode !== 'survey') this.stopGpsStatus();
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
      case 'review':
        this.mode = 'survey';
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
    this.tracker = null;
    this.mode = 'survey';
    this.render();
  }

  private async openSurvey(survey: Survey): Promise<void> {
    this.survey = survey;
    // The tracker is runtime state: a restored survey is never actively
    // recording. Repair any stale persisted recording flag (issue #6).
    this.tracker = null;
    if (survey.recording) {
      survey.recording = false;
      void surveyDb.saveSurveyMeta(survey);
    }
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
    this.recBadge.classList.toggle('on', s.recording);

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
        onclick: () => void this.runAnalysis()
      },
      'Map photos'
    );

    this.bottombar.replaceChildren(recBtn, camBtn, note, mapBtn, photoInput);

    // Issue #10: keep the GPS readiness indicator live on the field
    // screen, independent of Record mode.
    this.startGpsStatus();
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
    this.recBadge.classList.toggle('on', s.recording);

    const btn = this.bottombar.querySelector<HTMLButtonElement>('#rec-btn');
    if (btn) {
      btn.classList.toggle('rec-on', s.recording);
      btn.textContent = s.recording ? '⏹ Stop' : '⏺ Record';
    }
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
    this.gpsStatus.textContent = formatGpsStatus(fix, now, s.gpsSamples.length, fromTrack ? 'track' : 'live');
    this.gpsStatus.className = `gps-status gps-${state}`;
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
        heading: this.tracker?.currentHeading,
        note: noteEl?.value.trim() || undefined
      });
      s.photos.push(photo);
      this.mapView.setPhotos(s.photos);
      if (noteEl) noteEl.value = '';
      const srcNote = photo.timestampSource && photo.timestampSource !== 'exif' ? ` [${photo.timestampSource} time]` : '';
      const camNote = photo.cameraPosition
        ? ` · cam: ${describeCameraPosition(photo.cameraPosition)}`
        : ' · no GPS — needs manual positioning';
      toast(`Photo captured (${s.photos.length})${srcNote}${camNote}`);
      const mapBtn = this.bottombar.querySelector<HTMLButtonElement>('#map-btn');
      if (mapBtn) mapBtn.disabled = false;
    } catch (e) {
      toast(`Photo failed: ${(e as Error).message}`);
    }
  }

  /* ---------------- analysis ---------------- */

  private async runAnalysis(): Promise<void> {
    const s = this.survey;
    if (!s || this.analyzing) return;
    this.analyzing = true;
    toast('Analyzing photos…');

    try {
      const fresh = (await surveyDb.loadSurvey(s.id)) ?? s;

      const result = await new MockAnalyzer().analyze(fresh);

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
        ...result.candidates
          .filter((c) => c.lat != null && c.lon != null)
          .map((c) => ({ lat: c.lat!, lon: c.lon! }))
      ];
      const nearby = await fetchOsmInArea(anchorPoints);
      for (const c of result.candidates) {
        c.osmMatches = annotateCandidate(c, nearby, 120);
      }

      // Issue #8: PositionSolution provenance chain.
      // 1) raw ground-survey estimate (always kept) -> 2) bounded aerial
      // structural refinement (few meters, capped by uncertainty) ->
      // 3) conditional OSM snap (only strong + essentially unique).
      for (const c of result.candidates) {
        if (c.lat == null || c.lon == null) continue;
        const est = { lat: c.lat, lon: c.lon };
        const uncertainty = 3 + (1 - c.positionConfidence) * 30; // 3..33 m
        const solution: PositionSolution = {
          estimatedPosition: est,
          uncertaintyMeters: uncertainty,
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

      await surveyDb.saveAnalysis(fresh.id, result.observations, result.candidates);
      fresh.candidates = result.candidates;
      this.survey = fresh;
      this.stopRecordingNow();

      this.mapView.setTrack(fresh);
      this.mapView.setPhotos(fresh.photos);
      this.mapView.setCandidates(fresh.candidates);
      this.mapView.fitToSurvey(fresh);

      this.mode = 'review';
      this.render();
      toast(`${result.candidates.length} candidate(s) created`);
    } catch (e) {
      toast(`Analysis failed: ${(e as Error).message}`);
    } finally {
      this.analyzing = false;
    }
  }

  /* ---------------- review screen ---------------- */

  private async renderReviewScreen(): Promise<void> {
    const s = this.survey;
    if (!s) return;
    this.setMode('review', 'Review candidates');

    this.mapView.setTrack(s);
    this.mapView.setPhotos(s.photos);
    this.mapView.setCandidates(s.candidates);

    this.bottombar.replaceChildren(
      el('button', { class: 'btn', onclick: () => { this.mode = 'survey'; this.render(); } }, '← Field'),
      el('button', {
        class: 'btn primary',
        disabled: s.candidates.length === 0,
        onclick: () => { this.mode = 'upload'; this.render(); }
      }, 'Review upload →')
    );

    const observations = await surveyDb.listObservations(s.id);
    if (observations.length === 0) {
      this.content.replaceChildren(
        el('div', { class: 'empty-hint' }, 'No candidates yet. Capture photos, then press Map photos.')
      );
      return;
    }

    const photoByObs = this.photosForObservations(s, observations);
    const cards = s.candidates.map((c) => this.buildCandidateCard(c, photoByObs));
    this.content.replaceChildren(
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

  private buildCandidateCard(c: FeatureCandidate, photoByObs: Map<string, Photo | undefined>): HTMLElement {
    const cls = getFeatureClass(c.featureType);
    const card = el('div', { class: `candidate status-${c.status}` });

    const img = c.observationIds.map((id) => photoByObs.get(id)?.image).find((v) => v) ?? '';
    const thumb = el('img', { class: 'thumb', src: img || undefined, alt: 'source photo' });

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
      el('div', { class: 'head' }, thumb, el('div', { class: 'type' }, cls?.label ?? c.featureType), statusSel)
    );

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

    const posRow = el('div', { class: 'row' });
    if (c.lat != null && c.lon != null) {
      posRow.append(
        el('b', {}, 'Position'),
        ` ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}  `,
        confSpan('pos', c.positionConfidence),
        ' ',
        confSpan('tags', c.tagConfidence)
      );
    } else {
      posRow.append(el('b', {}, 'Position'), ' unknown — drag a pin or re-photograph with GPS.');
    }
    card.append(posRow);

    // Issue #10: the camera position and its provenance must be visible to
    // the reviewer — it is evidence for the object's location, and a
    // missing/stale fix must be an explicit, visible fact.
    const cam = c.observationIds
      .map((id) => photoByObs.get(id)?.cameraPosition)
      .find((v) => v != null);
    card.append(
      el(
        'div',
        { class: 'row cam-row' },
        el('b', {}, 'Camera'),
        cam
          ? ` ${describeCameraPosition(cam)} @ ${cam.lat.toFixed(5)}, ${cam.lon.toFixed(5)}`
          : ' no GPS — position needs manual placement.'
      )
    );

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
          'Nearby in OSM:',
          ...c.osmMatches.map((m) => this.buildOsmMatchRow(c, m))
        )
      );
    }

    return card;
  }

  private buildOsmMatchRow(c: FeatureCandidate, m: OsmMatch): HTMLElement {
    const linked = c.linkedOsmId === m.osmId && (c.linkedOsmType == null || c.linkedOsmType === m.osmType);
    const tagPreview = Object.entries(m.tags)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return el(
      'div',
      { class: 'osm-match' + (linked ? ' linked' : '') },
      el('div', { class: 'm-meta' }, `${m.osmType}/${m.osmId} · ${Math.round(m.matchScore * 100)}% · ${tagPreview}`),
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

  private async onStatusChange(c: FeatureCandidate, sel: HTMLSelectElement): Promise<void> {
    c.status = sel.value as CandidateStatus;
    if (c.status !== 'existing') {
      c.linkedOsmId = undefined;
      c.linkedOsmType = undefined;
    }
    await surveyDb.updateCandidate(c);
    if (this.mode === 'review') this.render();
  }

  private async onRemoveTag(c: FeatureCandidate, key: string): Promise<void> {
    delete c.tags[key];
    await surveyDb.updateCandidate(c);
    if (this.mode === 'review') this.render();
  }

  private async onEditTag(c: FeatureCandidate, key: string): Promise<void> {
    const v = window.prompt(`Edit value for "${key}=" (leave empty to remove):`, c.tags[key] ?? '');
    if (v == null) return;
    const val = v.trim();
    if (val) c.tags[key] = val;
    else delete c.tags[key];
    await surveyDb.updateCandidate(c);
    if (this.mode === 'review') this.render();
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
    if (this.mode === 'review') this.render();
  }

  /** Add one reviewer-confirmed suggested (optional) tag. */
  /** Reviewer picked a known-allowed value for a not-guessable tag key. */
  private async onCommonValueChanged(c: FeatureCandidate, key: string, sel: HTMLSelectElement): Promise<void> {
    const v = sel.value;
    if (v === '') delete c.tags[key];
    else c.tags[key] = v;
    await surveyDb.updateCandidate(c);
    if (this.mode === 'review') this.render();
  }

  private async onAddSuggestedTag(c: FeatureCandidate, k: string, v: string): Promise<void> {
    c.tags[k] = v;
    await surveyDb.updateCandidate(c);
    toast(`${k}=${v} added`);
    if (this.mode === 'review') this.render();
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
    await surveyDb.updateCandidate(c);
    this.mapView.setCandidates(s.candidates);
    toast('Pin moved');
  }

  /** Issue #9: apply the OSM mapping chosen for a review-only candidate. */
  private async onMappingChosen(c: FeatureCandidate, m: OsmMapping): Promise<void> {
    const all = mappingsFor(c.featureType);
    c.tags = applyMappingToTags(c.tags, m, all.length > 0 ? all : [m]);
    await surveyDb.updateCandidate(c);
    if (this.mode === 'review') this.render();
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
    if (this.mode === 'review') this.render();
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
    if (this.mode === 'review') this.render();
    toast('Aerial-refined position applied');
  }

  private async onLinkExisting(c: FeatureCandidate, m: OsmMatch): Promise<void> {
    c.linkedOsmId = m.osmId;
    c.linkedOsmType = m.osmType;
    c.status = 'existing';
    await surveyDb.updateCandidate(c);
    toast(`Linked to ${m.osmType}/${m.osmId}`);
    if (this.mode === 'review') this.render();
  }

  /* ---------------- upload review screen ---------------- */

  private renderUploadScreen(): void {
    const s = this.survey;
    if (!s) return;
    this.setMode('upload', 'Review upload');

    // Issue #9 geometry policy: area-based classes are never created from a
    // point position — the app must not fabricate polygon/way geometry from
    // a single photo.
    const isAreaClass = (c: FeatureCandidate): boolean => {
      const p = geometryPreferenceFor(c.featureType);
      return p === 'area' || p === 'existing-only';
    };
    const add = s.candidates.filter(
      (c) => c.status === 'new' && c.lat != null && c.lon != null && !isAreaClass(c)
    );
    const areaBlocked = s.candidates.filter(
      (c) => c.status === 'new' && c.lat != null && c.lon != null && isAreaClass(c)
    );
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
