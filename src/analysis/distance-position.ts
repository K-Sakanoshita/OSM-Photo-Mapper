import type { ObservationRay, PositionEstimate } from './position';

/** Distance-only least-squares proposal. Keep mirror/flat solutions inside
 * the uncertainty radius; GPS accuracy and image distance errors are not exact circles. */
export function estimateDistancePosition(rays: ObservationRay[]): PositionEstimate | null {
  const usable = rays.filter((r) => Number.isFinite(r.distanceM) && r.distanceM > 0);
  if (usable.length < 2) return null;
  const origin = usable[0];
  const meters = 6371000 * Math.PI / 180;
  const lonMeters = meters * Math.cos(origin.lat * Math.PI / 180);
  if (Math.abs(lonMeters) < 1) return null;
  const samples = usable.map((r) => ({
    x: (r.lon - origin.lon) * lonMeters, y: (r.lat - origin.lat) * meters,
    d: r.distanceM,
    sigma: Math.hypot(r.gpsAccuracy ?? 10, r.distanceUncertaintyM ?? Math.max(2, r.distanceM * .5), (r.cameraAgeMs ?? 0) / 1000 * 1.4)
  }));
  const baseline = Math.max(...samples.map((a) => Math.max(...samples.map((b) => Math.hypot(a.x - b.x, a.y - b.y)))));
  if (baseline < 2) return null; // identical camera origins do not locate the object
  const cx = samples.reduce((n, p) => n + p.x / samples.length, 0);
  const cy = samples.reduce((n, p) => n + p.y / samples.length, 0);
  const radius = Math.max(...samples.map((p) => Math.hypot(p.x - cx, p.y - cy) + p.d + 2 * p.sigma));
  const cost = (x: number, y: number) => samples.reduce((n, p) => n + ((Math.hypot(x - p.x, y - p.y) - p.d) / Math.max(1, p.sigma)) ** 2, 0);
  const grid: Array<{ x: number; y: number; cost: number }> = [];
  for (let i = 0; i <= 80; i++) for (let j = 0; j <= 80; j++) {
    const x = cx - radius + 2 * radius * i / 80, y = cy - radius + 2 * radius * j / 80;
    grid.push({ x, y, cost: cost(x, y) });
  }
  let best = grid.reduce((a, b) => a.cost <= b.cost ? a : b);
  for (let step = radius / 40; step > .02; step /= 2) {
    for (let iteration = 0; iteration < 20; iteration++) {
      const previous = best;
      for (const dx of [-step, 0, step]) for (const dy of [-step, 0, step]) {
        const x = previous.x + dx, y = previous.y + dy;
        if (Math.abs(x - cx) > radius || Math.abs(y - cy) > radius) continue;
        const score = cost(x, y);
        if (score < best.cost) best = { x, y, cost: score };
      }
      if (best === previous) break;
    }
  }
  const plausible = grid.filter((p) => p.cost <= best.cost + 1);
  const uncertaintyMeters = Math.max(radius / 40, ...samples.map((p) => p.sigma), ...plausible.map((p) => Math.hypot(p.x - best.x, p.y - best.y)));
  const contradictory = best.cost / samples.length > 4;
  return {
    lat: origin.lat + best.y / meters, lon: origin.lon + best.x / lonMeters,
    positionConfidence: Math.min(contradictory ? .1 : .3, 1 / (1 + uncertaintyMeters / 10)),
    positionQuality: contradictory ? 'contradictory' : 'distance-only', uncertaintyMeters,
    warnings: [
      'Provisional distance-only position — verify and move the pin before mapping.',
      ...(usable.length === 2 ? ['Two distances can give two mirrored positions; the uncertainty includes both.'] : []),
      ...(baseline < 10 ? ['Camera locations are close together; the position is weakly constrained.'] : []),
      ...(contradictory ? ['Estimated distances disagree; this position is unreliable.'] : [])
    ]
  };
}
