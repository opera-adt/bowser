/**
 * The Assistant's page tools: what the model can do on the user's map and chart.
 * They run here, in the browser, through the app's own actions (src/context/AppContext.tsx);
 * the data tools run on the server (src/bowser/tools.py). Also how the data tools' results
 * appear on the page (`showResult`) and the page state each question starts with (`pageState`).
 */
import { refDragEnd, type RefApi } from '../map/interactions';
import type { AppAction, AppState, Overlay } from '../types';
import type { PageToolSpec } from './client';

export interface PageContext {
  /** The latest rendered state (the loop runs across renders). */
  getState: () => AppState;
  dispatch: (a: AppAction) => void;
  api: RefApi;
  /** What this answer already did, which the state shows only after the next render. */
  done: { points: [number, number][]; chartOpen: boolean };
}

/** A fresh `done` for a new answer. */
export const newDone = (): PageContext['done'] => ({ points: [], chartOpen: false });

function openChart(ctx: PageContext): void {
  if (!ctx.getState().showChart && !ctx.done.chartOpen) ctx.dispatch({ type: 'TOGGLE_CHART' });
  ctx.done.chartOpen = true;
}

const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const LON = num('WGS84 longitude.', { minimum: -180, maximum: 180 });
const LAT = num('WGS84 latitude.', { minimum: -90, maximum: 90 });

/** What a tool is doing, for the status line: its spec's `status`, else its name in words. */
export function toolStatus(name: string, status?: string): string {
  return status || PAGE_TOOLS.find(t => t.name === name)?.status || (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ');
}

export const PAGE_TOOLS: PageToolSpec[] = [
  {
    name: 'fly_to',
    status: 'Moving the map',
    description: 'Move the map to a point (lon, lat, optional zoom 1-18; default about 2 km across) or to a box (west, south, east, north).',
    input_schema: obj({
      lon: LON, lat: LAT, zoom: num('Map zoom level, 1-18.', { minimum: 1, maximum: 18 }),
      west: LON, south: LAT, east: LON, north: LAT,
    }),
  },
  {
    name: 'add_point',
    status: 'Adding the point',
    description: "Add a time-series point to the map and the chart (the chart opens), so the user sees the point's series. Points read with the data tools are added already.",
    input_schema: obj({ lon: LON, lat: LAT, name: str('Short label, e.g. "Dam crest".') }, ['lon', 'lat']),
  },
  {
    name: 'set_reference_point',
    status: 'Setting the reference point',
    description: 'Move the reference point: every displacement on the map and chart becomes relative to it. Choose stable ground (bedrock, an old building, a GNSS station), not the feature being studied.',
    input_schema: obj({ lon: LON, lat: LAT }, ['lon', 'lat']),
  },
  {
    name: 'set_reference_date',
    status: 'Setting the reference date',
    description: 'Make displacement relative to a date of the current layer (values on that date become 0). Give the date (YYYY-MM-DD; the nearest date is used), or reset=true for the producer\'s reference date.',
    input_schema: obj({ date: str('Date, YYYY-MM-DD.'), reset: { type: 'boolean', description: "Go back to the producer's reference date." } }),
  },
  {
    name: 'switch_layer',
    status: 'Switching the layer',
    description: 'Show another layer of the cube on the map (a name from list_layers, e.g. velocity, temporal_coherence).',
    input_schema: obj({ layer: str('Layer name.') }, ['layer']),
  },
  {
    name: 'open_chart',
    status: 'Opening the chart',
    description: "Open the time-series chart with the page's points and areas.",
    input_schema: obj({}),
  },
  {
    name: 'add_overlay',
    status: 'Adding the overlay',
    description: "Add a GeoTIFF on the server's disk to the map as an overlay (full server only, and only where the page may open files on the server).",
    input_schema: obj({ path: str('Path of the GeoTIFF on the server.'), name: str('Name in the layer list.') }, ['path']),
  },
];

export const PAGE_TOOL_NAMES = new Set(PAGE_TOOLS.map(t => t.name));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function lonLat(input: Record<string, unknown>): [number, number] {
  const { lon, lat } = input;
  if (!isNum(lon) || !isNum(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('Give lon and lat in degrees.');
  return [lon, lat];
}

const sameSpot = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** Add a point unless one is already there; open the chart. Returns the point's name. */
function addPoint(ctx: PageContext, lon: number, lat: number, name?: string): string {
  const state = ctx.getState();
  const there = state.timeSeriesPoints.find(p => sameSpot(p.position, [lat, lon]));
  if (there) {
    openChart(ctx);
    return there.name;
  }
  const label = name?.trim().slice(0, 40)
    || `AI ${state.timeSeriesPoints.filter(p => p.name.startsWith('AI ')).length + ctx.done.points.length + 1}`;
  if (!ctx.done.points.some(p => sameSpot(p, [lat, lon]))) {
    ctx.dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [lat, lon], name: label } });
    ctx.done.points.push([lat, lon]);
  }
  openChart(ctx);
  return label;
}

/** Run a page tool; returns what the model is told. Throws with a message for the model. */
export async function runPageTool(name: string, input: Record<string, unknown>, ctx: PageContext): Promise<unknown> {
  const state = ctx.getState();
  switch (name) {
    case 'fly_to': {
      const { west, south, east, north, zoom } = input;
      if ([west, south, east, north].every(isNum)) {
        ctx.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [south as number, west as number, north as number, east as number] });
        return { ok: true, view: [west, south, east, north] };
      }
      const [lon, lat] = lonLat(input);
      const half = isNum(zoom) ? 180 / 2 ** Math.max(1, Math.min(18, zoom)) : 0.01;
      ctx.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [lat - half, lon - half, lat + half, lon + half] });
      return { ok: true, center: [lon, lat] };
    }
    case 'add_point': {
      const [lon, lat] = lonLat(input);
      const label = addPoint(ctx, lon, lat, typeof input.name === 'string' ? input.name : undefined);
      return { ok: true, name: label, layer: state.currentDataset, note: 'The point is on the map and in the chart.' };
    }
    case 'set_reference_point': {
      const [lon, lat] = lonLat(input);
      await refDragEnd(state, [lat, lon], ctx.api, ctx.dispatch);
      return { ok: true, reference_point: [lon, lat], note: 'Displacement on the map and chart is now relative to this point.' };
    }
    case 'set_reference_date': {
      const ds = state.currentDataset;
      const dates = (state.datasetInfo[ds]?.x_values ?? []).map(String);
      if (!ds || dates.length < 2) throw new Error('The current layer has no dates.');
      if (input.reset === true) {
        ctx.dispatch({ type: 'SET_REF_TIME_INDEX', payload: { dataset: ds, index: null } });
        return { ok: true, reference_date: null, note: "Back to the producer's reference date." };
      }
      const want = Date.parse(String(input.date ?? ''));
      if (Number.isNaN(want)) throw new Error('Give date as YYYY-MM-DD, or reset=true.');
      let best = 0;
      dates.forEach((d, i) => { if (Math.abs(Date.parse(d) - want) < Math.abs(Date.parse(dates[best]) - want)) best = i; });
      ctx.dispatch({ type: 'SET_REF_TIME_INDEX', payload: { dataset: ds, index: best } });
      return { ok: true, layer: ds, reference_date: dates[best], index: best };
    }
    case 'switch_layer': {
      const layer = String(input.layer ?? '');
      if (!state.datasetInfo[layer]) throw new Error(`No layer ${JSON.stringify(layer)}. Layers: ${Object.keys(state.datasetInfo).join(', ')}.`);
      ctx.dispatch({ type: 'SET_CURRENT_DATASET', payload: layer });
      // A re-referenced layer needs the reference point's series for the map.
      if (state.datasetInfo[layer].uses_spatial_ref) {
        await refDragEnd({ ...state, currentDataset: layer }, state.refMarkerPosition, ctx.api, ctx.dispatch);
      }
      return { ok: true, layer };
    }
    case 'open_chart':
      openChart(ctx);
      return { ok: true, points: state.timeSeriesPoints.map(p => p.name), areas: state.chartAreas.map(a => a.name) };
    case 'add_overlay':
      return addOverlay(String(input.path ?? ''), typeof input.name === 'string' ? input.name : undefined, ctx);
    default:
      throw new Error(`No page tool ${name}.`);
  }
}

/** A GeoTIFF on the server's disk as an overlay: only where the page may open server paths. */
async function addOverlay(path: string, name: string | undefined, ctx: PageContext): Promise<unknown> {
  if (!path.trim()) throw new Error('Give the path of a GeoTIFF on the server.');
  const [config, catalog] = await Promise.all([
    fetch('/config').then(r => r.json()).catch(() => ({})),
    fetch('/catalog').then(r => r.json()).catch(() => ({})),
  ]);
  if (!config.geotiff_export) throw new Error('This server (bowser-lite) cannot show GeoTIFF overlays; run `bowser run`.');
  if (!catalog.allow_open) throw new Error('Opening files on the server from the page is off here.');
  const q = `url=${encodeURIComponent(path)}`;
  const statsRes = await fetch(`/overlay/statistics?${q}`);
  if (!statsRes.ok) {
    const detail = await statsRes.json().then(j => j.detail).catch(() => null);
    throw new Error(`Could not read ${path}: ${detail ?? `HTTP ${statsRes.status}`}`);
  }
  const stats = await statsRes.json() as Record<string, { min: number; max: number; percentile_2?: number; percentile_98?: number }>;
  const bands = Object.entries(stats).map(([band, s]) => ({
    name: band, min: s.min, max: s.max, p2: s.percentile_2 ?? s.min, p98: s.percentile_98 ?? s.max,
  }));
  let bounds: [number, number, number, number] | null = null;
  try {
    const tj = await fetch(`/overlay/WebMercatorQuad/tilejson.json?${q}&tilesize=256`).then(r => r.json());
    if (Array.isArray(tj.bounds) && tj.bounds.length === 4) bounds = tj.bounds;
  } catch { /* bounds optional */ }
  const b0 = bands[0] ?? { p2: 0, p98: 1 };
  const overlay: Overlay = {
    id: `ov_ai_${Date.now()}`, name: name?.trim() || path.split('/').pop() || path, type: 'geotiff', path,
    bandCount: bands.length, bands, bounds, visible: true, opacity: 1, aboveData: false,
    mode: bands.length >= 3 ? 'rgb' : 'cmap', cmap: 'viridis', vmin: b0.p2, vmax: b0.p98, discrete: false, nbins: 5,
  };
  ctx.dispatch({ type: 'ADD_OVERLAY', payload: overlay });
  if (bounds) ctx.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [bounds[1], bounds[0], bounds[3], bounds[2]] });
  return { ok: true, name: overlay.name, bands: bands.length, bounds };
}

/** Put what a data tool found on the page: its points in the chart, a polygon as a chart area. */
export function showResult(name: string, input: Record<string, unknown>, ctx: PageContext): void {
  if (['point_timeseries', 'trend_at_point', 'value_at_point'].includes(name)) {
    if (isNum(input.lon) && isNum(input.lat)) addPoint(ctx, input.lon, input.lat);
  } else if (name === 'multi_point_timeseries' && Array.isArray(input.points)) {
    for (const p of input.points as Record<string, unknown>[]) {
      if (isNum(p.lon) && isNum(p.lat)) addPoint(ctx, p.lon, p.lat, typeof p.name === 'string' ? p.name : undefined);
    }
  } else if (name === 'polygon_statistics' && input.geometry && typeof input.geometry === 'object') {
    let g = input.geometry as { type?: string; geometry?: unknown; coordinates?: unknown };
    if (g.type === 'Feature') g = (g.geometry ?? {}) as typeof g;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      ctx.dispatch({ type: 'ADD_CHART_AREA', payload: { geometry: { type: g.type, coordinates: g.coordinates }, name: 'AI area' } });
      openChart(ctx);
    }
  }
}

/** What the page shows, sent with each question: the layer, date, references, view and points. */
export function pageState(state: AppState, dataset: string | null): Record<string, unknown> {
  const ds = state.currentDataset;
  const info = state.datasetInfo[ds];
  const dates = info?.x_values ?? [];
  const refIdx = state.refTimeIndex[ds];
  const [lat, lon] = state.refMarkerPosition;
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const out: Record<string, unknown> = {
    layer: ds || null,
    layers: Object.keys(state.datasetInfo),
    date_shown: dates.length > 1 ? String(dates[state.currentTimeIndex] ?? '') : null,
    reference_point: info?.uses_spatial_ref && state.refEnabled ? [round(lon), round(lat)] : null,
    reference_date: refIdx !== undefined ? String(dates[refIdx] ?? '') : info?.reference_date ?? null,
    points: state.timeSeriesPoints.map(p => ({ name: p.name, lon: round(p.position[1]), lat: round(p.position[0]) })),
    chart_open: state.showChart,
  };
  if (state.viewBounds) {
    const [s, w, n, e] = state.viewBounds;
    out.view = [round(w), round(s), round(e), round(n)];
  }
  if (dataset) out.dataset = dataset;
  return out;
}
