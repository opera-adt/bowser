/**
 * Files added through the server (POST /data): an upload, a path on the server, or one
 * given to `bowser run --overlay`. The server makes each ready to draw once, in the
 * background: a raster becomes a Cloud-Optimized GeoTIFF tiled by /overlay, a large
 * vector a PMTiles archive of vector tiles, a small one a GeoJSON the page holds whole.
 * The layer's row says "Converting to COG… 12 s" until then; the layer is drawn after.
 * Small vector files dropped on the page never come here: the browser reads them
 * (useAddFiles). Pinned by addData.test.ts.
 */
import type { Dispatch } from 'react';
import type { Overlay, OverlayBand, OverlayConversion } from '../types';
import { featureBounds, parseGeoJson } from './fileParsers';
import { asDem } from './dem';
import { inspectPmtiles } from './pmtiles';

type Bounds = [number, number, number, number];

/** What POST /data and GET /data/{id} answer (api_models.DataStatus). */
export interface DataJob {
  id: string;
  name: string;
  kind: 'raster' | 'vector';
  format: OverlayConversion['format'];
  status: OverlayConversion['status'];
  converted?: boolean | null;
  elapsed_s?: number | null;
  error?: string | null;
  bounds?: Bounds | null;
  // a raster, once ready
  cog?: string | null;
  band_count?: number | null;
  bands?: OverlayBand[] | null;
  dem?: boolean | null;
  // a vector
  url?: string | null;
  layers?: string[] | null;
  feature_count?: number | null;
}

/** How often a conversion is polled. */
export const POLL_MS = 1500;

/** Formats the server reads and the browser does not: always sent to the server. */
export const SERVER_ONLY = /\.(gpkg|fgb)$/i;

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
  return body as T;
}

/** Upload one file, or a Shapefile's parts, for POST /data; returns the main file's server path. */
export async function uploadData(files: File[]): Promise<{ path: string; name: string }> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return json(await fetch('/upload_data', { method: 'POST', body: form }));
}

/** Ask the server to make a file ready to draw (converting it if needed). */
export async function startData(path: string, name?: string): Promise<DataJob> {
  return json(await fetch('/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, ...(name ? { name } : {}) }),
  }));
}

/** "Converting to COG… 1 min 5 s" from the format and the seconds a conversion has run. */
export function convertingText(format: OverlayConversion['format'], elapsed?: number): string {
  const what = format === 'cog' ? 'Converting to COG…' : format === 'pmtiles' ? 'Converting to PMTiles…' : 'Reading the features…';
  if (elapsed === undefined || !Number.isFinite(elapsed)) return what;
  const s = Math.round(elapsed);
  return `${what} ${s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`}`;
}

/**
 * Why a vector converted to PMTiles has no zonal stats or chart areas: the page holds only
 * the tiles in view, clipped and simplified per zoom, not the features themselves.
 */
export function tiledNote(featureCount?: number): string {
  const n = featureCount !== undefined ? `${featureCount.toLocaleString('en-US')} features, ` : '';
  return `${n}drawn from vector tiles: Identify shows their attributes, but zonal stats and chart areas need the features in the browser (a smaller file).`;
}

const conversionOf = (job: DataJob): OverlayConversion => ({
  status: job.status, format: job.format, id: job.id,
  ...(job.elapsed_s != null ? { elapsedS: job.elapsed_s } : {}), ...(job.error ? { error: job.error } : {}),
});

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * The layer for a file the server is making ready: a GeoTIFF, a PMTiles vector layer or a
 * vector layer, not drawn until its conversion is ready. ``base`` gives its id and colours.
 */
export function overlayFromJob(job: DataJob, base: Pick<Overlay, 'id'> & Partial<Overlay>): Overlay {
  const common = { visible: true, opacity: 1, bounds: job.bounds ?? null, conversion: conversionOf(job) };
  if (job.kind === 'raster') {
    return {
      name: job.name, type: 'geotiff', bands: [], aboveData: false, mode: 'cmap', cmap: 'viridis',
      discrete: false, nbins: 5, ...common, ...base,
    };
  }
  const vector = {
    name: baseName(job.name), aboveData: true, lineWidth: 2, pointRadius: 5,
    ...(job.feature_count != null ? { featureCount: job.feature_count } : {}), ...common, ...base,
  };
  return job.format === 'pmtiles'
    ? { ...vector, type: 'pmtiles', pmtilesKind: 'vector', sourceLayers: job.layers ?? [], lineWidth: 1.5, pointRadius: 4 }
    : { ...vector, type: 'vector', data: { type: 'FeatureCollection', features: [] } };
}

/**
 * The updates a conversion's status brings: its progress, or once ready what the layer is
 * drawn from. A raster gets its COG, bands and colour range (a DEM's styling when the
 * server took it for one); a PMTiles layer its archive, read for its layers and zooms; a
 * small vector its features.
 */
export async function jobUpdates(o: Overlay, job: DataJob): Promise<Partial<Overlay>> {
  const conversion = conversionOf(job);
  if (job.status !== 'ready') return { conversion };
  const bounds = job.bounds ? { bounds: job.bounds } : {};
  if (job.kind === 'raster') {
    const bands = job.bands ?? [];
    const b0 = bands[0] ?? { p2: 0, p98: 1, min: 0, max: 1 };
    const raster: Partial<Overlay> = {
      conversion, path: job.cog ?? o.path, bandCount: job.band_count ?? bands.length, bands, ...bounds,
      mode: (job.band_count ?? 1) >= 3 ? 'rgb' : 'cmap', vmin: b0.p2 ?? b0.min ?? 0, vmax: b0.p98 ?? b0.max ?? 1,
    };
    return job.dem ? { ...raster, ...asDem({ ...o, ...raster }) } : raster;
  }
  if (!job.url) throw new Error('the server gave no URL for it');
  const url = new URL(job.url, window.location.href).href;
  if (job.format === 'pmtiles') {
    const info = await inspectPmtiles(url);
    return {
      conversion, url, sourceLayers: info.layers.length ? info.layers : o.sourceLayers,
      minzoom: info.minzoom, maxNativeZoom: info.maxzoom, bounds: info.bounds ?? o.bounds,
    };
  }
  const data = parseGeoJson(await (await fetch(url)).text());
  return { conversion, data, bounds: featureBounds(data) };
}

export type OverlayDispatch = Dispatch<
  | { type: 'UPDATE_OVERLAY'; payload: { id: string; updates: Partial<Overlay> } }
  | { type: 'MOVE_OVERLAY_TO_BOTTOM'; payload: string }
>;

/**
 * Follow a file's conversion until it is ready or failed, updating its layer (added from
 * ``overlayFromJob``) as it goes; returns the last status. A raster that turns out to be a DEM moves to the bottom of the
 * stack, the ground the other layers sit on.
 */
export async function followData(o: Overlay, job: DataJob, dispatch: OverlayDispatch,
  wait = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<DataJob> {
  let current = o;
  const apply = async (j: DataJob) => {
    const updates = await jobUpdates(current, j);
    current = { ...current, ...updates };
    dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates } });
    if (updates.dem && !o.dem) dispatch({ type: 'MOVE_OVERLAY_TO_BOTTOM', payload: o.id });
  };
  try {
    while (job.status === 'converting') {
      await apply(job);
      await wait(POLL_MS);
      job = await json<DataJob>(await fetch(`/data/${job.id}`));
    }
    await apply(job);
  } catch (err) {
    job = { ...job, status: 'failed', error: (err as Error).message || String(err) };
    dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { conversion: conversionOf(job) } } });
  }
  return job;
}
