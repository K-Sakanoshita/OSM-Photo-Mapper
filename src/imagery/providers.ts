/**
 * Aerial imagery provider abstraction (issue #8).
 *
 * The PWA refines candidate positions using structural cues from aerial
 * imagery. Coverage and resolution vary by provider:
 *  - GSI nationwide seamless imagery (全国最新写真・シームレス) is the
 *    always-available fallback, coarse for small objects.
 *  - Higher-resolution OSMFJ/municipal ortho layers can be registered to
 *    override it where they have coverage (register a TileSource and pass
 *    it before the GSI source in `defaultProviders`).
 *
 * Providers must degrade gracefully: any fetch/decode failure yields null
 * and the caller falls back to the raw ground-survey estimate. Pixel-level
 * processing stays in-browser; imagery is never forwarded to third parties
 * (respecting imagery source usage terms and CORS).
 */

export interface TileSource {
  id: string;
  /** Highest zoom this source serves at usable quality. */
  maxZoom: number;
  /** Expected coverage test (cheap, no network). */
  covers(latDeg: number, lonDeg: number): boolean;
  /** XYZ tile URL template. */
  tileUrl(x: number, y: number, z: number): string;
  /** Attribution / terms note shown to the user. */
  attribution: string;
}

export interface TileProvider {
  readonly source: TileSource;
  /**
   * Fetch one 256px tile as an ImageBitmap.
   * Returns null when the tile is unavailable (404 outside coverage, network
   * error, decode failure) — callers treat that as "no imagery".
   */
  fetchTile(x: number, y: number, z: number): Promise<ImageBitmap | null>;
}

/** GSI nationwide seamless latest-photo tiles (coarse fallback). */
export const gsiSeamlessSource: TileSource = {
  id: 'gsi-seamless',
  maxZoom: 18,
  covers: () => true, // nominally nationwide; absent tiles return 404 at runtime
  tileUrl: (x, y, z) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
  attribution: '© 国土地理院（全国最新写真・シームレス）'
};

export class HttpTileProvider implements TileProvider {
  constructor(readonly source: TileSource) {}

  async fetchTile(x: number, y: number, z: number): Promise<ImageBitmap | null> {
    try {
      const res = await fetch(this.source.tileUrl(x, y, z), {
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  }
}

export const gsiProvider = new HttpTileProvider(gsiSeamlessSource);

/** Default provider stack: high-res first (none registered yet), GSI fallback. */
export const defaultProviders: TileProvider[] = [gsiProvider];

/** First provider expected to cover the point (high-res wins over fallback). */
export function selectProvider(
  latDeg: number,
  lonDeg: number,
  providers: TileProvider[] = defaultProviders
): TileProvider | null {
  for (const p of providers) {
    if (p.source.covers(latDeg, lonDeg)) return p;
  }
  return null;
}
