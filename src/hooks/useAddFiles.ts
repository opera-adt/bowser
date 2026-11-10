/**
 * Adding local files as overlays, from a drop on the map or the Layers tab. Vectors (GeoJSON,
 * CSV/TSV with lon/lat columns, KML, GPX, Shapefiles) are read in the browser. GeoTIFFs go to
 * /upload_raster and are tiled by the server, which reprojects any CRS. The map then fits to
 * what was added; progress and problems appear in the map's message.
 */
import { useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { featureBounds, fileKind, parseCsv, parseGeoJson, parseGpx, parseKml } from '../map/fileParsers';
import type { Overlay, OverlayFeatures } from '../types';

export const ACCEPT = '.geojson,.json,.csv,.tsv,.txt,.kml,.gpx,.zip,.shp,.dbf,.prj,.cpg,.shx,.tif,.tiff';
/** Vector files are read whole into memory. */
export const MAX_VECTOR_BYTES = 200 * 1024 * 1024;

type Bounds = [number, number, number, number]; // [west, south, east, north]

const VECTOR_COLORS = ['#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#17becf', '#e377c2', '#bcbd22', '#1f77b4'];
let added = 0;
const nextId = () => `ov_${Date.now()}_${++added}`;

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');
const union = (a: Bounds | null, b: Bounds | null): Bounds | null => {
  if (!a || !b) return a ?? b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
};

/** Default per-bin colors for discrete/categorical overlays. */
const BIN_PALETTE = [
  '#d62728', '#ff7f0e', '#ffd92f', '#2ca02c', '#1f77b4', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#17becf', '#bcbd22', '#393b79',
];
export const binColorsFor = (n: number, prev: string[] = []): string[] =>
  Array.from({ length: n }, (_, k) => prev[k] ?? BIN_PALETTE[k % BIN_PALETTE.length]);

function vectorOverlay(name: string, data: OverlayFeatures): Overlay {
  return {
    id: nextId(), name, type: 'vector', visible: true, opacity: 1, aboveData: true, data,
    bounds: featureBounds(data), color: VECTOR_COLORS[added % VECTOR_COLORS.length], lineWidth: 2, pointRadius: 5,
  };
}

/** Upload a GeoTIFF: band metadata from the server, WGS84 bounds from the tiler's tilejson. */
async function rasterOverlay(file: File): Promise<Overlay> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/upload_raster', { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.json().then(j => j.detail).catch(() => null);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  const meta = await res.json();
  let bounds: Bounds | null = null;
  try {
    const tj = await fetch(`/overlay/WebMercatorQuad/tilejson.json?url=${encodeURIComponent(meta.path)}&tilesize=256`).then(r => r.json());
    if (Array.isArray(tj.bounds) && tj.bounds.length === 4) bounds = tj.bounds;
  } catch { /* bounds optional */ }
  const b0 = meta.bands?.[0] ?? { p2: 0, p98: 1, min: 0, max: 1 };
  return {
    id: nextId(), name: meta.name, type: 'geotiff', path: meta.path, bandCount: meta.band_count, bands: meta.bands ?? [],
    bounds, visible: true, opacity: 1, aboveData: false, mode: meta.band_count >= 3 ? 'rgb' : 'cmap', cmap: 'viridis',
    vmin: b0.p2 ?? b0.min ?? 0, vmax: b0.p98 ?? b0.max ?? 1, discrete: false, nbins: 5, binColors: binColorsFor(5),
  };
}

async function readVector(file: File, kind: ReturnType<typeof fileKind>): Promise<OverlayFeatures> {
  const text = await file.text();
  switch (kind) {
    case 'geojson': return parseGeoJson(text);
    case 'csv': return parseCsv(text);
    case 'tsv': return parseCsv(text, '\t');
    case 'kml': return parseKml(text);
    case 'gpx': return parseGpx(text);
    default: throw new Error('unsupported format');
  }
}

async function readShapefileZip(file: File) {
  const { default: shp } = await import('shpjs');
  const out = await shp(await file.arrayBuffer());
  return Array.isArray(out) ? out : [out];
}

async function readShapefileParts(parts: File[]) {
  const by = (ext: string) => parts.find(f => f.name.toLowerCase().endsWith(`.${ext}`));
  const shpFile = by('shp');
  if (!shpFile) throw new Error('a Shapefile needs its .shp (add .shp, .dbf and .prj together, or a .zip)');
  const { default: shp } = await import('shpjs');
  const [shpBuf, dbf, prj, cpg] = await Promise.all([shpFile.arrayBuffer(), by('dbf')?.arrayBuffer(), by('prj')?.text(), by('cpg')?.text()]);
  const out = await shp({ shp: shpBuf, ...(dbf ? { dbf } : {}), ...(prj ? { prj } : {}), ...(cpg ? { cpg } : {}) });
  return Array.isArray(out) ? out[0] : out;
}

export function useAddFiles() {
  const { dispatch } = useAppContext();
  return useCallback(async (files: FileList | File[]) => {
    const say = (message: string | null) => dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: message });
    const list = Array.from(files);
    const problems: string[] = [];
    const shpGroups = new Map<string, File[]>();
    let bounds: Bounds | null = null;
    let count = 0;
    const add = (o: Overlay) => {
      dispatch({ type: 'ADD_OVERLAY', payload: o });
      bounds = union(bounds, o.bounds ?? null);
      count += 1;
    };

    for (const file of list) {
      const kind = fileKind(file.name);
      if (kind === 'shapefile-part') {
        const key = baseName(file.name).toLowerCase();
        shpGroups.set(key, [...(shpGroups.get(key) ?? []), file]);
        continue;
      }
      try {
        if (kind === 'unknown') throw new Error('unsupported file type (GeoJSON, CSV/TSV, KML, GPX, Shapefile or GeoTIFF)');
        if (kind === 'kmz') throw new Error('KMZ is not supported; unzip it and add the .kml inside');
        if (kind === 'geotiff') {
          say(`Uploading ${file.name}…`);
          add(await rasterOverlay(file));
          continue;
        }
        if (file.size > MAX_VECTOR_BYTES) throw new Error(`${(file.size / 1024 / 1024).toFixed(0)} MB is over the 200 MB limit`);
        if (kind === 'shapefile-zip') {
          const layers = await readShapefileZip(file);
          const withFeatures = layers.filter(l => l.features?.length);
          if (!withFeatures.length) throw new Error('no features in the Shapefile');
          for (const layer of withFeatures) {
            add(vectorOverlay(layers.length > 1 && layer.fileName ? `${baseName(file.name)} · ${layer.fileName}` : baseName(file.name), layer));
          }
          continue;
        }
        add(vectorOverlay(baseName(file.name), await readVector(file, kind)));
      } catch (err) {
        problems.push(`${file.name}: ${(err as Error).message || String(err)}`);
      }
    }

    for (const parts of shpGroups.values()) {
      const name = baseName(parts[0].name);
      try {
        const layer = await readShapefileParts(parts);
        if (!layer.features?.length) throw new Error('no features in the Shapefile');
        add(vectorOverlay(name, layer));
      } catch (err) {
        problems.push(`${name}: ${(err as Error).message || String(err)}`);
      }
    }

    if (bounds) {
      const [w, s, e, n] = bounds as Bounds;
      const pad = w === e && s === n ? 0.01 : 0;
      dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [Math.max(-85, s - pad), w - pad, Math.min(85, n + pad), e + pad] });
    }
    if (problems.length) say(problems.length === 1 ? `Could not add ${problems[0]}` : `Could not add ${problems.length} files. ${problems.join(' · ')}`);
    else say(count === 1 ? 'Added 1 layer.' : `Added ${count} layers.`);
  }, [dispatch]);
}
