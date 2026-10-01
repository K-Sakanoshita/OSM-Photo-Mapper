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
  private candidateSourceId = 'candidates-source';
  private trackLayerId = 'track';
  private trackSourceId = 'track-source';
  private photoLayerId = 'photos';
  private photoSourceId = 'photos-source';

  constructor(
    container: HTMLElement,
    private readonly onPinDragged?: (candidateId: string, lat: number, lon: number) => void
  ) {
    this.map = new maplibregl.Map({
      container,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [139.767, 35.681],
      zoom: 15
    });

    this.map.addControl(new maplibregl.NavigationControl());
    this.map.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true
    }));

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
        paint: { 'circle-radius': 4, 'circle-color': '#7fb3d5', 'circle-opacity': 0.9 }
      });

      this.map.addSource(this.candidateSourceId, { type: 'geojson', data: emptyFeatureCollection() });
      this.map.addLayer({
        id: this.candidateLayerId,
        type: 'circle',
        source: this.candidateSourceId,
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      });

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
    (this.map.getSource(this.photoSourceId) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features
    });
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
    (this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features
    });
  }

  private enableDragging(): void {
    let draggingId: string | null = null;

    this.map.on('click', this.candidateLayerId, (e) => {
      const feat = e.features?.[0];
      if (!feat) return;
      draggingId = (feat.properties?.id as string) ?? null;
    });

    this.map.on('mousedown', this.candidateLayerId, (e) => {
      const feat = e.features?.[0];
      if (feat) draggingId = (feat.properties?.id as string) ?? null;
    });

    this.map.on('mousemove', async (e) => {
      if (!draggingId) return;
      const { lng, lat } = e.lngLat;
      const src = this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const data = (await src.getData()) as GeoJSON.FeatureCollection;
      for (const f of data.features) {
        if (f.properties?.id === draggingId) {
          (f.geometry as GeoJSON.Point).coordinates = [lng, lat];
        }
      }
      src.setData(data);
    });

    this.map.on('mouseup', () => {
      if (!draggingId) return;
      const src = this.map.getSource(this.candidateSourceId) as maplibregl.GeoJSONSource | undefined;
      const data = src?.getData() as GeoJSON.FeatureCollection | undefined;
      const feat = data?.features.find((f) => f.properties?.id === draggingId);
      const coords = (feat?.geometry as GeoJSON.Point | undefined)?.coordinates;
      if (coords) this.onPinDragged?.(draggingId, coords[1], coords[0]);
      draggingId = null;
    });
  }

  fitToSurvey(survey: Survey): void {
    const pts = [
      ...survey.gpsSamples.map((s: GpsSample) => [s.lon, s.lat] as [number, number]),
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
