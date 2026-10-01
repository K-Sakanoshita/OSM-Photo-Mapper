import './styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapView } from './map/map-view';
import { GeolocationTracker } from './capture/geolocation-tracker';
import { capturePhoto } from './capture/photo';
import { surveyDb } from './db/survey-db';
import { MockAnalyzer } from './analysis/mock-analyzer';
import { annotateCandidate, fetchOsmInArea, type LatLon } from './osm/overpass';
import { commonValuesFor, getFeatureClass, suggestedTagsFor } from './analysis/feature-classes';
import { refinePosition } from './analysis/structural-refine';
import { decideSnap } from './analysis/snap-decision';
import { distanceMeters } from './analysis/position';
import { gsiProvider } from './imagery/providers';
import type {
  CandidateStatus,
  FeatureCandidate,
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
    const mapWrap = el('div', { id: 'map-wrap' }, el('div', { id: 'map' }), this.recBadge);

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
    const camBtn = el('button', { class: 'btn accent', onclick: () => photoInput.click() }, '📷 Photo');
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

  private async onPhotoTaken(input: HTMLInputElement): Promise<void> {
    const s = this.survey;
    const file = input.files?.[0];
    if (!s || !file) return;
    input.value = '';

    const noteEl = this.bottombar.querySelector<HTMLInputElement>('#photo-note');
    try {
      // Issue #6: the photo's timestamp comes from EXIF / file metadata (the
      // true capture time, not "now"), and its GPS context is the track
      // position at THAT moment (interpolated when between samples) — not
      // the newest sample at selection time. EXIF GPS is never used as the
      // object position.
      const photo = await capturePhoto({
        surveyId: s.id,
        file,
        track: s.gpsSamples,
        heading: this.tracker?.currentHeading,
        note: noteEl?.value.trim() || undefined
      });
      s.photos.push(photo);
      this.mapView.setPhotos(s.photos);
      if (noteEl) noteEl.value = '';
      const srcNote = photo.timestampSource && photo.timestampSource !== 'exif' ? ` [${photo.timestampSource} time]` : '';
      toast(`Photo captured (${s.photos.length})${srcNote}`);
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

        const refined = await refinePosition(gsiProvider, c.featureType, est.lat, est.lon, uncertainty);
        if (refined) {
          solution.refinedPosition = { lat: refined.lat, lon: refined.lon };
          solution.evidence.push(refined.evidence);
        }

        const base = refined ? { lat: refined.lat, lon: refined.lon } : est;
        const snap = decideSnap({
          lat: base.lat,
          lon: base.lon,
          featureType: c.featureType,
          uncertaintyM: uncertainty,
          matches: c.osmMatches
        });

        c.positionSolution = solution;

        if (snap) {
          solution.snappedPosition = snap.snappedPosition;
          solution.linkedOsmId = snap.osm.osmId;
          solution.snapConfidence = snap.confidence;
          solution.evidence.push(snap.evidence);
          c.lat = snap.snappedPosition.lat;
          c.lon = snap.snappedPosition.lon;
          c.linkedOsmId = snap.osm.osmId;
          c.status = 'existing';
          c.warnings.push(
            `Snapped to ${snap.osm.osmType}/${snap.osm.osmId} (${Math.round(snap.confidence * 100)}% confidence) — verify the match.`
          );
        } else if (refined) {
          c.lat = base.lat;
          c.lon = base.lon;
          c.warnings.push(`Position refined ${refined.deltaM.toFixed(1)} m by aerial structure — verify against the photos.`);
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
  ): Map<string, string | undefined> {
    const map = new Map<string, string | undefined>();
    for (const obs of observations) {
      const photo = s.photos.find((p) => p.id === obs.photoId);
      map.set(obs.id, photo?.image);
    }
    return map;
  }

  private buildCandidateCard(c: FeatureCandidate, photoByObs: Map<string, string | undefined>): HTMLElement {
    const cls = getFeatureClass(c.featureType);
    const card = el('div', { class: `candidate status-${c.status}` });

    const img = c.observationIds.map((id) => photoByObs.get(id)).find((v) => v) ?? '';
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
        steps.push(`snapped → osm/${ps.linkedOsmId} (${Math.round((ps.snapConfidence ?? 0) * 100)}%)`);
      }
      const solRow = el('div', { class: 'row solution-row' }, el('b', {}, 'Solution'), ` ${steps.join(' → ')}`, ` · σ ${ps.uncertaintyMeters.toFixed(0)} m`);
      for (const e of ps.evidence) {
        solRow.append(el('span', { class: 'ev-chip', title: e.detail ?? e.label }, e.label));
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
    const linked = c.linkedOsmId === m.osmId;
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
    if (c.status !== 'existing') c.linkedOsmId = undefined;
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
      const match = c.osmMatches.find((m) => m.osmId === c.linkedOsmId);
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

  private async onLinkExisting(c: FeatureCandidate, m: OsmMatch): Promise<void> {
    c.linkedOsmId = m.osmId;
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

    const add = s.candidates.filter((c) => c.status === 'new' && c.lat != null && c.lon != null);
    const modify = s.candidates.filter((c) => c.status === 'existing' && c.linkedOsmId != null);
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
      el(
        'div',
        { class: 'upload-section' },
        el('h2', {}, `Modify ${modify.length} existing`),
        ...modify.map((c) => this.buildEditRow(c, 'modify')),
        ...(modify.length === 0 ? [el('div', { class: 'row' }, '—')] : [])
      ),
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
      onclick: () => this.showXml(commentInput, xmlArea)
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
        ? ` <code>${c.linkedOsmId}</code>`
        : c.lat != null && c.lon != null
          ? ` @ ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`
          : '';
    return el('div', { class: 'edit-item' }, `${cls?.label ?? c.featureType}${idPart} — ${tagText}`);
  }

  private showXml(commentInput: HTMLInputElement, xmlArea: HTMLElement): void {
    const s = this.survey;
    if (!s) return;
    const xml = buildOsmChange(s, commentInput.value.trim() || 'photo survey');
    const copyBtn = el('button', { class: 'btn accent', onclick: () => void this.copyXml(xml) }, 'Copy XML');
    const dlBtn = el('button', { class: 'btn', onclick: () => this.downloadXml(s, xml) }, 'Download .osmchange');
    xmlArea.replaceChildren(
      el('div', { class: 'xml-block' }, xml),
      el('div', { class: 'changeset-row' }, copyBtn, dlBtn),
      el('div', { class: 'row' }, 'Nothing is uploaded automatically. Paste the OSMChange into an OSM editor or apply it via an API client after a final check.')
    );
    toast('Changeset approved — review the XML before applying it');
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
/* OSMChange XML                                                       */
/* ------------------------------------------------------------------ */

const CREATED_BY = 'OSM Photo Mapper (MVP)';

function tagXml(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `      <tag k="${esc(k)}" v="${esc(v)}"/>`)
    .join('\n');
}

function buildOsmChange(survey: Survey, comment: string): string {
  const add = survey.candidates.filter((c) => c.status === 'new' && c.lat != null && c.lon != null);
  const modify = survey.candidates.filter((c) => c.status === 'existing' && c.linkedOsmId != null);

  const addBlocks = add
    .map((c, i) => {
      const tags: Record<string, string> = { ...c.tags };
      if (c.name && !('name' in tags)) tags.name = c.name;
      return `    <node id="${-(i + 1)}" lat="${c.lat!.toFixed(7)}" lon="${c.lon!.toFixed(7)}">\n${tagXml(tags)}\n    </node>`;
    })
    .join('\n');

  const modifyBlocks = modify
    .map((c) => {
      const match = c.osmMatches.find((m) => m.osmId === c.linkedOsmId);
      const type = match?.osmType ?? 'node';
      // <modify> replaces the whole tag set: keep the object's existing tags,
      // overlay the reviewed candidate tags, so unrelated tags are not wiped.
      const tags: Record<string, string> = { ...(match?.tags ?? {}) };
      Object.assign(tags, c.tags);
      if (c.name && !('name' in tags)) tags.name = c.name;
      const coords =
        type === 'node' && c.lat != null && c.lon != null
          ? ` lat="${c.lat.toFixed(7)}" lon="${c.lon.toFixed(7)}"`
          : '';
      return `    <${type} id="${c.linkedOsmId}"${coords}>\n${tagXml(tags)}\n    </${type}>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<osmChange>',
    '  <add>',
    addBlocks || '  ',
    '  </add>',
    '  <modify>',
    modifyBlocks || '  ',
    '  </modify>',
    '  <create>',
    `    <creadetag k="created_by" v="${esc(CREATED_BY)}"/>`,
    `    <creadetag k="comment" v="${esc(comment)}"/>`,
    '  </create>',
    '</osmChange>',
    ''
  ]
    .join('\n')
    .replace(/\n\s*\n\s*\n/g, '\n');
}

/* ------------------------------------------------------------------ */

new App();
