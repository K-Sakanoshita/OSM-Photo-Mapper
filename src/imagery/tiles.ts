/**
 * Web-Mercator (XYZ / "slippy map") tile math (issue #8).
 *
 * Pure functions — no DOM/network access — so the coordinate conversions are
 * fully unit-testable in Node. Used to select the small set of imagery tiles
 * around a candidate, and to convert between pixel and geographic
 * coordinates within the stitched region.
 */
export const TILE_SIZE = 256;
const EARTH_RADIUS = 6371000;

/** Mercator y in [0, 1] for a latitude (degrees), clamped to the mercator range. */
export function mercatorY(latDeg: number): number {
  const c = (Math.max(-85, Math.min(85, latDeg)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + c / 2)) / Math.PI) / 2;
}

/** Inverse of mercatorY: y in [0,1] -> latitude (degrees). */
export function invMercatorY(y: number): number {
  const clamped = Math.max(0, Math.min(1, y));
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * clamped))) * 180) / Math.PI;
  return lat;
}

export interface TileXY {
  x: number;
  y: number;
}

/** XYZ tile containing the given lat/lon at zoom z. */
export function latLonToTile(latDeg: number, lonDeg: number, z: number): TileXY {
  const n = Math.pow(2, z);
  const x = Math.floor(((lonDeg + 180) / 360) * n);
  const y = Math.floor(mercatorY(latDeg) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y))
  };
}

/** Geographic bounds of a tile: NW and SE corners. */
export function tileBounds(x: number, y: number, z: number): { nw: [number, number]; se: [number, number] } {
  const n = Math.pow(2, z);
  const lonW = (x / n) * 360 - 180;
  const lonE = ((x + 1) / n) * 360 - 180;
  const latN = invMercatorY(y / n);
  const latS = invMercatorY((y + 1) / n);
  return { nw: [latN, lonW], se: [latS, lonE] };
}

/** Pixel (within one tile) of a lat/lon, in mercator-linear space. */
export function pixelOfLatLon(
  tile: TileXY,
  latDeg: number,
  lonDeg: number,
  z: number,
  tileSize: number = TILE_SIZE
): { px: number; py: number } {
  const n = Math.pow(2, z);
  const px = (((lonDeg + 180) / 360) * n - tile.x) * tileSize;
  const py = (mercatorY(latDeg) * n - tile.y) * tileSize;
  return { px, py };
}

/** Lat/lon of a pixel center within a tile. */
export function latLonOfPixel(
  tile: TileXY,
  px: number,
  py: number,
  z: number,
  tileSize: number = TILE_SIZE
): { lat: number; lon: number } {
  const n = Math.pow(2, z);
  const lon = (((tile.x + (px + 0.5) / tileSize) / n) * 360) - 180;
  const lat = invMercatorY((tile.y + (py + 0.5) / tileSize) / n);
  return { lat, lon };
}

/** Ground resolution in meters/pixel at a latitude and zoom. */
export function mPerPixelAt(z: number, latDeg: number): number {
  const lat = (Math.max(-85, Math.min(85, latDeg)) * Math.PI) / 180;
  return (EARTH_RADIUS * 2 * Math.PI) / (Math.pow(2, z) * TILE_SIZE) / Math.cos(lat);
}

/** Smallest zoom reaching `targetMetersPerPixel` at the latitude. */
export function zoomForResolution(targetMetersPerPixel: number, latDeg: number): number {
  const z = Math.log2((EARTH_RADIUS * 2 * Math.PI) / (targetMetersPerPixel * TILE_SIZE * Math.cos((Math.max(-85, Math.min(85, latDeg)) * Math.PI) / 180)));
  return Math.max(0, Math.ceil(z));
}

export interface RegionTiles {
  tiles: TileXY[];
  northLat: number;
  southLat: number;
  westLon: number;
  eastLon: number;
  zoom: number;
}

/**
 * Tiles covering a circular-ish area (radius meters) around a point at zoom z.
 * Returns null if the area spans more than `maxTiles` tiles (caller should
 * coarsen the zoom instead of fetching a huge region).
 */
export function regionTiles(
  latDeg: number,
  lonDeg: number,
  radiusM: number,
  z: number,
  maxTiles: number = 64
): RegionTiles | null {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.2, Math.cos((latDeg * Math.PI) / 180)));
  const nw = latLonToTile(latDeg + dLat, lonDeg - dLon, z);
  const se = latLonToTile(latDeg - dLat, lonDeg + dLon, z);

  const xs = new Set<number>();
  const ys = new Set<number>();
  for (let x = nw.x; x <= se.x; x++) xs.add(x);
  for (let y = nw.y; y <= se.y; y++) ys.add(y);
  if (xs.size * ys.size > maxTiles) return null;

  const tiles: TileXY[] = [];
  for (const x of xs) for (const y of ys) tiles.push({ x, y });

  // Union bounds of the selected tiles (mercator-rect, in degrees).
  let northLat = -90;
  let southLat = 90;
  let westLon = 180;
  let eastLon = -180;
  for (const t of tiles) {
    const b = tileBounds(t.x, t.y, z);
    northLat = Math.max(northLat, b.nw[0]);
    southLat = Math.min(southLat, b.se[0]);
    westLon = Math.min(westLon, b.nw[1]);
    eastLon = Math.max(eastLon, b.se[1]);
  }

  return { tiles, northLat, southLat, westLon, eastLon, zoom: z };
}
