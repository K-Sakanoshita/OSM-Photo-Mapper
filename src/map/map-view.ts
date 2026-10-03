import maplibregl from 'maplibre-gl';
import type { FeatureCandidate, GpsSample, Photo, Survey } from '../types';

/**
 * MapLibre GL view for the survey map.
 *
 * Renders: the GPS track (line), photo capture points, and feature candidate
 * pins. Candidate pins are draggable — dragging a pin updates the candidate's
 * lat/lon and notifies the host so the list + persistence stay in sync.
 */
export class MapView {
  map: maplibregl.Map;
  private candidateLayerId = 'candidates';
  private candidateHitLayerId = 'candidates-hit';
  private candidateSourceId = 'candidates-source';
  private candidateData: GeoJSON.FeatureCollection = emptyFeatureCollection();
  private trackLayerId = 'track';
  private trackSourceId = 'track-source';
  private photoLayerId = 'photos';
  private photoSourceId = 'photos-source';
  private photoData: GeoJSON.FeatureCollection = emptyFeatureCollection();

  constructor(
    container: HTMLElement,
    private readonly onPinDragged?: (candidateId: string, lat: number, lon: number) => void,
    private readonly onMapSelected?: (lat: number, lon: number) => void
  ) {
    this.map = new maplibregl.Map({
      container,
      style: new URL('./osmfj_nopoi.json', document.baseURI).href,
      center: [139.767, 35.681],
      zoom: 15
    });

    this.map.addControl(new maplibregl.NavigationControl());
    this.map.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true
    }));
    this.map.on('click', (e) => this.onMapSelected?.(e.lngLat.lat, e.lngLat.lng));

    this.map.on('load', () => {
      this.map.addSource(this.trackSourceId, { type: 'geojson', data: emptyFeatureCollection() });
      this.map.addLayer({
        id: this.trackLayerId,
        type: 'line',
        source: this.trackSourceId,
        paint: { 'line-color': '#1a5276', 'line-width': 3, 'line-opacity': 0.8 }
      });

      this.map.addSource(this.photoSourceId, { type: 'geojson', data: emptyFeatureCollection() });
      this.map.addLayer({
        id: this.photoLayerId,
        type: 'circle',
        source: this.photoSourceId,
        paint: { 'circle-radius': 8, 'circle-color': '#3498db', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' }
      });
      (this.map.getSource(this.photoSourceId) as maplibregl.GeoJSONSource).setData(this.photoData);

      this.map.addSource(this.candidateSourceId, { type: 'geojson', data: emptyFeatureCollection() });
      this.map.addLayer({
        id: this.candidateHitLayerId,
        type: 'circle',
        source: this.candidateSourceId,
        paint: { 'circle-radius': 28, 'circle-color': '#ffffff', 'circle-opacity': 0.01 }
      });
      this.map.addLayer({
        id: this.candidateLayerId,
        type: 'circle',
        source: this.candidateSourceId,
        paint: {
          'circle-radius': 15,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff'
        }
      });
      (this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource).setData(this.candidateData);

      this.enableDragging();
    });
  }

  /** Color by review status: new=green, existing=amber, excluded=grey. */
  statusColor(status: FeatureCandidate['status']): string {
    switch (status) {
      case 'new': return '#2e8b57';
      case 'existing': return '#e6a23c';
      case 'excluded': return '#9e9e9e';
    }
  }

  setTrack(survey: Survey): void {
    const coords = survey.gpsSamples.map((s) => [s.lon, s.lat]);
    const data =
      coords.length >= 2
        ? { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords } }
        : { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: coords[0] ?? [0, 0] } };
    const src = this.map.getSource(this.trackSourceId) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData({ type: 'FeatureCollection', features: coords.length ? [data] : [] });
  }

  setPhotos(photos: Photo[]): void {
    const features = photos
      .filter((p) => p.gps)
      .map((p) => ({
        type: 'Feature' as const,
        properties: { id: p.id, timestamp: p.timestamp },
        geometry: { type: 'Point' as const, coordinates: [p.gps!.lon, p.gps!.lat] }
      }));
    this.photoData = {
      type: 'FeatureCollection',
      features
    };
    (this.map.getSource(this.photoSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(this.photoData);
  }

  setCandidates(candidates: FeatureCandidate[]): void {
    const features = candidates
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => ({
        type: 'Feature' as const,
        properties: {
          id: c.id,
          status: c.status,
          color: this.statusColor(c.status),
          positionConfidence: c.positionConfidence,
          tagConfidence: c.tagConfidence
        },
        geometry: { type: 'Point' as const, coordinates: [c.lon!, c.lat!] }
      }));
    this.candidateData = {
      type: 'FeatureCollection',
      features
    };
    (this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(this.candidateData);
  }

  /**
   * Enable dragging of candidate pins (issue #4: must work with touch on
   * mobile, not just mouse). While dragging, the pin's source feature is
   * kept in sync, map panning is suspended so the map does not follow the
   * finger, and `onPinDragged` fires with the final coordinates when the
   * drag ends.
   */
  private enableDragging(): void {
    /** Active drag state. Final coordinates come from here, not from an
     *  (async) source read at drop time. */
    let drag: { id: string; lat: number; lon: number } | null = null;

    const startDrag = (id: string, lat: number, lon: number): void => {
      if (drag) return;
      drag = { id, lat, lon };
      this.map.dragPan.disable();
      this.map.boxZoom.disable();
      this.map.touchZoomRotate.disable();
      this.map.getCanvas().style.cursor = 'grabbing';
    };

    const moveDrag = (lng: number, lat: number): void => {
      if (!drag) return;
      drag.lon = lng;
      drag.lat = lat;
      const feature = this.candidateData.features.find((f) => f.properties?.id === drag?.id);
      if (!feature) return;
      (feature.geometry as GeoJSON.Point).coordinates = [lng, lat];
      (this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource | undefined)?.setData(this.candidateData);
    };

    const endDrag = (): void => {
      const d = drag;
      drag = null;
      this.map.dragPan.enable();
      this.map.boxZoom.enable();
      this.map.touchZoomRotate.enable();
      this.map.getCanvas().style.cursor = '';
      if (d) this.onPinDragged?.(d.id, d.lat, d.lon);
    };

    const featureAt = (features: maplibregl.MapGeoJSONFeature[] | undefined) => features?.[0];

    // Mouse: layer-scoped mousedown starts the drag; map-level mousemove/
    // mouseup track and end it. (MapLibre has no pointer events on layers.)
    this.map.on('mouseenter', this.candidateHitLayerId, () => {
      if (!drag) this.map.getCanvas().style.cursor = 'grab';
    });
    this.map.on('mouseleave', this.candidateHitLayerId, () => {
      if (!drag) this.map.getCanvas().style.cursor = '';
    });
    this.map.on('mousedown', this.candidateHitLayerId, (e: maplibregl.MapLayerMouseEvent) => {
      const feat = featureAt(e.features);
      const id = feat?.properties?.id as string | undefined;
      if (id) {
        const [lon, lat] = (feat!.geometry as GeoJSON.Point).coordinates;
        startDrag(id, lat, lon);
      }
    });
    this.map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      if (drag) moveDrag(e.lngLat.lng, e.lngLat.lat);
    });
    this.map.on('mouseup', () => {
      if (drag) endDrag();
    });

    // Touch: layer-scoped touchstart starts the drag (hit-testing the
    // candidate layer), map-level touchmove/touchend track and end it.
    this.map.on('touchstart', this.candidateHitLayerId, (e: maplibregl.MapLayerTouchEvent) => {
      const feat = featureAt(e.features);
      const id = feat?.properties?.id as string | undefined;
      if (id) {
        e.preventDefault(); // stop the map from treating this touch as a pan
        const [lon, lat] = (feat!.geometry as GeoJSON.Point).coordinates;
        startDrag(id, lat, lon);
      }
    });
    this.map.on('touchmove', (e: maplibregl.MapTouchEvent) => {
      if (!drag) return;
      const ll = e.lngLats?.[0] ?? e.lngLat;
      moveDrag(ll.lng, ll.lat);
    });
    this.map.on('touchend', () => {
      if (drag) endDrag();
    });
    this.map.on('touchcancel', () => {
      if (drag) endDrag();
    });
  }

  fitToSurvey(survey: Survey): void {
    const pts = [
      ...survey.gpsSamples.map((s: GpsSample) => [s.lon, s.lat] as [number, number]),
      ...survey.photos.filter((p) => p.gps).map((p) => [p.gps!.lon, p.gps!.lat] as [number, number]),
      ...survey.candidates.filter((c) => c.lat != null).map((c) => [c.lon!, c.lat!] as [number, number])
    ];
    if (pts.length === 0) return;
    if (pts.length === 1) {
      this.map.jumpTo({ center: pts[0], zoom: 18 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const p of pts) bounds.extend(p);
    this.map.fitBounds(bounds, { padding: 60, maxZoom: 19 });
  }

  remove(): void {
    this.map.remove();
  }
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
