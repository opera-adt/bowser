/**
 * 3D terrain from a DEM overlay ("Use for 3D terrain"), MapLibre only.
 *
 * MapLibre takes one terrain source, so the DEM can't simply be laid over the global
 * terrain. Each terrain tile is put together in the browser instead, through the
 * ``bowserdem://`` protocol: the DEM's own elevations (TiTiler's ``terrarium`` algorithm
 * on its COG) wherever it has data, and the global AWS Terrarium tiles (terrain.ts)
 * everywhere else, outside the DEM and in its nodata. So the ground does not drop to
 * 0 m at the DEM's edge, and with no network the DEM still stands on flat ground at
 * its own lowest height. Pinned by demTerrain.test.ts.
 */
import type { Overlay } from '../types';
import { TERRAIN_SOURCE } from './terrain';

export const DEM_TERRAIN_PROTOCOL = 'bowserdem';
/** The DEM's tiles go to zoom 17 (about 1 m pixels); the global tiles stop at 15. */
export const DEM_TERRAIN_MAXZOOM = 17;
const GLOBAL_MAXZOOM = TERRAIN_SOURCE.maxzoom;
const GLOBAL_TEMPLATE = TERRAIN_SOURCE.tiles[0];

/** The DEM overlay used for 3D terrain: visible, ready, and switched to it. */
export function terrainDem(overlays: Overlay[]): Overlay | null {
  return overlays.find(o => o.visible && o.dem?.terrain && o.path && (!o.conversion || o.conversion.status === 'ready')) ?? null;
}

/** Terrarium tiles of a DEM's COG from the /overlay tiler (nodata stays transparent). */
export function demTerrariumUrl(o: Overlay, origin: string): string {
  const q = new URLSearchParams({
    url: o.path ?? '', bidx: '1', algorithm: 'terrarium', resampling: 'bilinear', reproject: 'bilinear',
  });
  return `${origin}/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${q.toString()}`;
}

/** The raster-dem source for MapLibre: the global terrain, or the DEM merged into it. */
export function terrainSourceFor(overlays: Overlay[], origin: string): typeof TERRAIN_SOURCE {
  const o = terrainDem(overlays);
  if (!o) return TERRAIN_SOURCE;
  const params = new URLSearchParams({
    dem: demTerrariumUrl(o, origin), base: String(Math.round(o.dem?.base ?? 0)),
    bounds: (o.bounds ?? [-180, -85, 180, 85]).join(','),
  });
  return {
    ...TERRAIN_SOURCE,
    tiles: [`${DEM_TERRAIN_PROTOCOL}://{z}/{x}/{y}?${params.toString()}`],
    maxzoom: DEM_TERRAIN_MAXZOOM,
    attribution: `${TERRAIN_SOURCE.attribution}; ${o.name}`,
  };
}

export interface TileRequest {
  z: number; x: number; y: number;
  dem: string; base: number; bounds: [number, number, number, number];
}

/** Read a ``bowserdem://z/x/y?dem=…&base=…&bounds=…`` URL. */
export function parseTerrainUrl(url: string): TileRequest {
  const m = /^\w+:\/\/(\d+)\/(\d+)\/(\d+)\?(.*)$/.exec(url);
  if (!m) throw new Error(`not a DEM terrain tile: ${url}`);
  const q = new URLSearchParams(m[4]);
  const bounds = (q.get('bounds') ?? '-180,-85,180,85').split(',').map(Number) as TileRequest['bounds'];
  return { z: +m[1], x: +m[2], y: +m[3], dem: q.get('dem') ?? '', base: Number(q.get('base') ?? 0), bounds };
}

const fill = (template: string, z: number, x: number, y: number) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** WGS84 [west, south, east, north] of a Web Mercator tile. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

const overlaps = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Where a tile's global terrain comes from: the tile itself up to zoom 15, past it the
 * square of its zoom-15 ancestor that covers it (``sx``, ``sy``, ``size`` in pixels of 256).
 */
export function globalTile(z: number, x: number, y: number): { z: number; x: number; y: number; sx: number; sy: number; size: number } {
  if (z <= GLOBAL_MAXZOOM) return { z, x, y, sx: 0, sy: 0, size: 256 };
  const k = 2 ** (z - GLOBAL_MAXZOOM);
  const size = 256 / k;
  return { z: GLOBAL_MAXZOOM, x: Math.floor(x / k), y: Math.floor(y / k), sx: (x % k) * size, sy: (y % k) * size, size };
}

/** Terrarium RGB of a height in metres. */
export function terrarium(h: number): [number, number, number] {
  const v = Math.min(65535, Math.max(0, h + 32768));
  return [Math.floor(v / 256), Math.floor(v % 256), Math.floor((v * 256) % 256)];
}

/**
 * The merged tile's pixels (RGBA): the DEM's where it has data (opaque), else the global
 * terrain's, else ``base`` metres (no global tile: offline).
 */
export function mergeTerrarium(dem: Uint8ClampedArray | null, global: Uint8ClampedArray | null, base: number, n = 256 * 256): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  const [br, bg, bb] = terrarium(base);
  for (let i = 0; i < n * 4; i += 4) {
    const src = dem && dem[i + 3] === 255 ? dem : global;
    if (src) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; } else { out[i] = br; out[i + 1] = bg; out[i + 2] = bb; }
    out[i + 3] = 255;
  }
  return out;
}

type Bitmap = ImageBitmap;

async function image(url: string, signal: AbortSignal): Promise<Bitmap | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;  // 404 outside the DEM
    // Exact bytes: no colour management or premultiplying, which would change the heights.
    return await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return null;
  }
}

/** Pixels of (part of) a bitmap scaled to 256×256, nearest neighbour (heights must not be blended). */
function pixels(img: Bitmap, sx = 0, sy = 0, size = 256): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);
  return ctx.getImageData(0, 0, 256, 256).data;
}

/** The ``bowserdem://`` tile loader for ``maplibregl.addProtocol``. */
export async function loadTerrainTile(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer }> {
  const t = parseTerrainUrl(params.url);
  const g = globalTile(t.z, t.x, t.y);
  const withDem = overlaps(tileBounds(t.z, t.x, t.y), t.bounds);
  const [dem, global] = await Promise.all([
    withDem ? image(fill(t.dem, t.z, t.x, t.y), abort.signal) : Promise.resolve(null),
    image(fill(GLOBAL_TEMPLATE, g.z, g.x, g.y), abort.signal),
  ]);
  const merged = mergeTerrarium(dem && pixels(dem), global && pixels(global, g.sx, g.sy, g.size), t.base);
  const canvas = new OffscreenCanvas(256, 256);
  canvas.getContext('2d')!.putImageData(new ImageData(merged as unknown as Uint8ClampedArray<ArrayBuffer>, 256, 256), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { data: await blob.arrayBuffer() };
}

let registered = false;

/** Register the ``bowserdem://`` protocol on MapLibre once. */
export function registerDemTerrain(addProtocol: ((name: string, load: never) => void) | undefined): void {
  if (registered || typeof addProtocol !== 'function') return;
  registered = true;
  addProtocol(DEM_TERRAIN_PROTOCOL, loadTerrainTile as never);
}
