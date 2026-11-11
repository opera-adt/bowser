/**
 * Adding files as overlays, from a drop on the map or the Layers tab, a path on the server,
 * or `bowser run --overlay`. Small vectors (GeoJSON, CSV/TSV with lon/lat columns, KML, GPX,
 * Shapefiles) are read in the browser. Rasters, vectors over /config's
 * ``data_conversion.pmtiles_min_mb`` and GeoPackages go to the server (POST /data), which
 * makes them ready to draw once, in the background (map/addData.ts): the layer's row says
 * so meanwhile. The map then fits to what was added; progress and problems appear in the
 * map's message.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { featureBounds, fileKind, parseCsv, parseGeoJson, parseGpx, parseKml } from '../map/fileParsers';
import { followData, overlayFromJob, SERVER_ONLY, startData, uploadData, type DataJob } from '../map/addData';
import type { Overlay, OverlayFeatures } from '../types';

export const ACCEPT = '.geojson,.json,.csv,.tsv,.txt,.kml,.gpx,.zip,.shp,.dbf,.prj,.cpg,.shx,.gpkg,.fgb,.kmz,.tif,.tiff';

/** What the server converts added files to (/config ``data_conversion``); all off on bowser-lite. */
export interface DataConversion {
  cog: boolean;
  pmtiles: boolean;
  pmtiles_min_mb: number | null;
}

/** /config's ``data_conversion``, or null until it is known. */
export function useDataConversion(): DataConversion | null {
  const [conversion, setConversion] = useState<DataConversion | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => { if (live && cfg?.data_conversion) setConversion(cfg.data_conversion); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return conversion;
}
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

/**
 * Add a file the server is making ready (POST /data's answer): its layer now, drawn once
 * the server is done. Returns the layer.
 */
export function useAddServerData() {
  const { dispatch } = useAppContext();
  return useCallback((job: DataJob): Overlay => {
    const o = overlayFromJob(job, { id: nextId(), color: VECTOR_COLORS[added % VECTOR_COLORS.length], binColors: binColorsFor(5) });
    dispatch({ type: 'ADD_OVERLAY', payload: o });
    void followData(o, job, dispatch);
    return o;
  }, [dispatch]);
}

export function useAddFiles() {
  const { dispatch } = useAppContext();
  const conversion = useDataConversion();
  const addServerData = useAddServerData();
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
    // Through the server: uploaded, then converted in the background (its row says how far along).
    const viaServer = async (parts: File[], name: string) => {
      say(`Uploading ${name}…`);
      const up = await uploadData(parts);
      const o = addServerData(await startData(up.path, name));
      bounds = union(bounds, o.bounds ?? null);
      count += 1;
    };
    // Vectors this large are tiled on the server when it can (PMTiles), rather than read here.
    const tooBig = (bytes: number) => !!conversion?.pmtiles && conversion.pmtiles_min_mb !== null
      && bytes > conversion.pmtiles_min_mb * 1024 * 1024;

    for (const file of list) {
      const kind = fileKind(file.name);
      if (kind === 'shapefile-part') {
        const key = baseName(file.name).toLowerCase();
        shpGroups.set(key, [...(shpGroups.get(key) ?? []), file]);
        continue;
      }
      try {
        if (SERVER_ONLY.test(file.name)) {
          if (conversion && !conversion.cog) {
            throw new Error(kind === 'kmz'
              ? 'KMZ needs the full Bowser server (bowser run); or unzip it and add the .kml inside'
              : 'GeoPackage and FlatGeobuf files need the full Bowser server (bowser run)');
          }
          await viaServer([file], file.name);
          continue;
        }
        if (kind === 'unknown') throw new Error('unsupported file type (GeoJSON, CSV/TSV, KML/KMZ, GPX, Shapefile, GeoPackage or GeoTIFF)');
        if (kind === 'geotiff' || tooBig(file.size)) {
          await viaServer([file], file.name);
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
        if (tooBig(parts.reduce((n, f) => n + f.size, 0))) {
          const shp = parts.find(f => f.name.toLowerCase().endsWith('.shp'));
          if (!shp) throw new Error('a Shapefile needs its .shp (add .shp, .dbf and .prj together, or a .zip)');
          await viaServer(parts, shp.name);
          continue;
        }
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
  }, [dispatch, conversion, addServerData]);
}
