/**
 * The Assistant's page tools: what the model can do on the user's map and chart, whichever way
 * it reaches the page (the Assistant's answer, or `bowser mcp` over the page channel).
 * They run here, in the browser, through the app's own actions (src/context/AppContext.tsx);
 * the data tools run on the server (src/bowser/tools.py). Also how the data tools' results
 * appear on the page (`showResult`) and the page state each question starts with (`pageState`).
 */
import { refDragEnd, type RefApi } from '../map/interactions';
import { getNavigator } from '../map/navigator';
import { EXAGGERATION_MAX, EXAGGERATION_MIN } from '../map/terrain';
import { datasetRangeUrl } from '../hooks/useApi';
import { COLORMAP_OPTIONS, isInverted, withInvert } from '../utils/colormaps';
import { fetchHistogram, presetRange, RANGE_PRESETS, type RangePreset } from '../utils/colorPresets';
import { defaultMasks } from '../utils/defaultMasks';
import type { AppAction, AppState, Overlay } from '../types';
import { listCommands, runCommand, type CommandEnv } from './commands';
import {
  addService, clearHighlights, drawResult, isHighlight, listServices, removeService,
} from '../map/contextServices';
import { DRAWINGS_ID, drawingName } from '../map/overlays';
import { runChartTool } from './chartTools';
import { CHART_TOOL_NAMES } from './chartView';

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

/**
 * The page tools this page runs. Their names, descriptions and argument schemas are defined
 * once, on the server (src/bowser/tools.py), which offers them to the model in the Assistant
 * and through `bowser mcp`; the calls come here either in the Assistant's own answer
 * (`page_tools`) or over the page channel (./pageChannel.ts).
 */
export const PAGE_TOOL_NAMES = new Set([
  'get_view', 'fly_to', 'fit_bounds', 'pan', 'zoom', 'go_to', 'set_terrain', 'set_split_screen',
  'add_point', 'get_reference', 'set_reference_point', 'reset_reference', 'set_reference_date',
  'switch_layer', 'open_chart', 'add_overlay',
  'get_masks', 'set_masks', 'clear_masks', 'set_recommended_mask',
  'get_display', 'set_colormap', 'set_color_range', 'set_opacity',
  'list_commands', 'run_command',
  'list_context_layers', 'add_context_layer', 'remove_context_layer',
  'highlight_infrastructure', 'clear_highlights', 'get_areas', 'draw_highlight',
  ...CHART_TOOL_NAMES,
]);

/**
 * What a tool is doing, for the status line: the label the server sends with the call (each
 * tool's `status` in src/bowser/tools.py), else the tool's name in words.
 */
export function toolStatus(name: string, status?: string): string {
  return status || (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ');
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function lonLat(input: Record<string, unknown>): [number, number] {
  const { lon, lat } = input;
  if (!isNum(lon) || !isNum(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('Give lon and lat in degrees.');
  return [lon, lat];
}

const sameSpot = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

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

// ── names: close matches for a misspelt layer or colormap ───────────────────────────────

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join('');

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return d[b.length];
}

/** The known names closest to ``name`` (spelling, case, spaces and word order aside). */
export function closeMatches(name: string, known: string[]): string[] {
  const scored = known.map(k => {
    const a = squash(name), b = squash(k);
    const score = Math.min(distance(a, b), distance(words(name), words(k))) / Math.max(a.length, b.length, 1);
    return { k, score };
  });
  return scored.filter(x => x.score <= 0.4).sort((x, y) => x.score - y.score).slice(0, 3).map(x => x.k);
}

/** ``name`` if it is a layer of the cube, else an error naming the close matches. */
function layerName(state: AppState, name: unknown): string {
  const known = Object.keys(state.datasetInfo);
  if (typeof name === 'string' && known.includes(name)) return name;
  const close = typeof name === 'string' ? closeMatches(name, known) : [];
  throw new Error(`No layer ${JSON.stringify(name)}${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}. Layers: ${known.join(', ')}.`);
}

// ── the map ──────────────────────────────────────────────────────────────────────────

function view(ctx: PageContext): Record<string, unknown> {
  const s = ctx.getState();
  const nav = getNavigator();
  const out: Record<string, unknown> = {};
  if (nav) {
    const v = nav.getView();
    Object.assign(out, {
      center: [round(v.center[0]), round(v.center[1])], zoom: round(v.zoom, 2), bearing: round(v.bearing, 1),
      pitch: round(v.pitch, 1), bounds: v.bounds.map(b => round(b)), map: v.map,
    });
    out.terrain = nav.terrain ? nav.terrain.get() : { enabled: false, note: '3D terrain needs the MapLibre map.' };
  } else if (s.viewBounds) {
    const [so, w, n, e] = s.viewBounds;
    out.bounds = [w, so, e, n].map(b => round(b));
    out.center = [round((w + e) / 2), round((so + n) / 2)];
  }
  out.split_screen = { on: s.splitScreen, left_layer: s.currentDataset || null, right_layer: s.splitDataset };
  return out;
}

function needMap() {
  const nav = getNavigator();
  if (!nav) throw new Error('The map is not ready yet.');
  return nav;
}

const zoomOk = (z: unknown): z is number => isNum(z) && z >= 0 && z <= 22;

async function flyTo(ctx: PageContext, lon: number, lat: number, zoom?: number) {
  const nav = getNavigator();
  if (nav) await nav.flyTo(lon, lat, zoom);
  else {
    const half = zoom !== undefined ? 360 / 2 ** (zoom + 1) : 0.01;
    ctx.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [lat - half, lon - half, lat + half, lon + half] });
  }
}

async function fitBounds(ctx: PageContext, w: number, s: number, e: number, n: number, padding = 40, maxZoom?: number) {
  const nav = getNavigator();
  if (nav) await nav.fitBounds(w, s, e, n, padding, maxZoom);
  else ctx.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [s, w, n, e] });
}

const METRES_PER_DEGREE = 111_320;

async function pan(input: Record<string, unknown>) {
  const nav = needMap();
  const dir = String(input.direction ?? '');
  const azimuth = { north: 0, east: 90, south: 180, west: 270 }[dir];
  if (azimuth === undefined) throw new Error('Give direction: north, south, east or west.');
  const v = nav.getView();
  if (input.distance_m !== undefined) {
    const d = Number(input.distance_m);
    if (!(d > 0 && d <= 5e6)) throw new Error('Give distance_m between 0 and 5000 km.');
    const [lon, lat] = v.center;
    const dLat = (d / METRES_PER_DEGREE) * Math.cos((azimuth * Math.PI) / 180);
    const dLon = (d / (METRES_PER_DEGREE * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))) * Math.sin((azimuth * Math.PI) / 180);
    const nextLat = Math.max(-85, Math.min(85, lat + dLat));
    const nextLon = ((lon + dLon + 540) % 360) - 180;
    await nav.flyTo(nextLon, nextLat);
    return;
  }
  const fraction = input.fraction === undefined ? 0.5 : Number(input.fraction);
  if (!(fraction > 0 && fraction <= 2)) throw new Error('Give fraction between 0 and 2.');
  // Pixels on screen for the geographic direction, the map's rotation (bearing) allowed for.
  const r = ((azimuth - v.bearing) * Math.PI) / 180;
  const along = azimuth % 180 === 0 ? v.height : v.width;
  await nav.panBy(Math.round(Math.sin(r) * fraction * along), Math.round(-Math.cos(r) * fraction * along));
}

/** go_to never zooms in closer than this (MapLibre scale: about a neighbourhood). */
export const GO_TO_MAX_ZOOM = 15;

async function geocodeBest(query: string) {
  const q = query.trim();
  if (!q) throw new Error('Give a place name or an address.');
  const res = await fetch(`/geocode?${new URLSearchParams({ q, limit: '1' })}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.detail ?? `The geocoder answered HTTP ${res.status}.`));
  const best = body.results?.[0];
  if (!best) throw new Error(`Nothing found for ${JSON.stringify(q)}.`);
  return { best, attribution: body.attribution as string };
}

// ── the reference ────────────────────────────────────────────────────────────────────

function reference(state: AppState): Record<string, unknown> {
  const ds = state.currentDataset;
  const info = state.datasetInfo[ds];
  const [lat, lon] = state.refMarkerPosition;
  const dates = (info?.x_values ?? []).map(String);
  const refIdx = state.refTimeIndex[ds];
  return {
    layer: ds || null,
    reference_point: [round(lon), round(lat)],
    rereferencing: state.refEnabled,
    sample_circle: { on: state.refBufferEnabled, radius_m: state.refBufferRadius },
    cube_reference_point: info?.reference_lonlat ?? null,
    reference_date: refIdx !== undefined ? dates[refIdx] ?? null : info?.reference_date ?? null,
    reference_date_chosen: refIdx !== undefined,
    relative_to_reference_point: Boolean(info?.uses_spatial_ref),
  };
}

async function moveReference(ctx: PageContext, lon: number, lat: number, radius?: unknown) {
  const s = ctx.getState();
  let bufferOn = s.refBufferEnabled;
  let bufferRadius = s.refBufferRadius;
  if (radius !== undefined && radius !== null) {
    if (!isNum(radius) || radius < 0 || radius > 5000) throw new Error('Give radius_m between 0 and 5000.');
    // "Sample around ref marker" (Main › Reference): the switch and its radius slider.
    if (radius > 0) {
      bufferRadius = Math.round(radius);
      if (!s.refBufferEnabled) ctx.dispatch({ type: 'TOGGLE_REF_BUFFER' });
      ctx.dispatch({ type: 'SET_REF_BUFFER_RADIUS', payload: bufferRadius });
      bufferOn = true;
    } else {
      if (s.refBufferEnabled) ctx.dispatch({ type: 'TOGGLE_REF_BUFFER' });
      bufferOn = false;
    }
  }
  if (!s.refEnabled) ctx.dispatch({ type: 'TOGGLE_REF_ENABLED' });
  // As dropping the marker does: move it and fetch the reference series (shift layers).
  await refDragEnd({ ...s, refBufferEnabled: bufferOn, refBufferRadius: bufferRadius }, [lat, lon], ctx.api, ctx.dispatch);
  const info = s.datasetInfo[s.currentDataset];
  const relative = Boolean(info?.uses_spatial_ref);
  return {
    ok: true,
    reference_point: [lon, lat],
    sample_circle: { on: bufferOn, radius_m: bufferOn ? bufferRadius : 0 },
    chart_rereferenced: relative,
    note: relative
      ? 'Displacement on the map and chart is now relative to this point'
        + (bufferOn ? ` (the median within ${bufferRadius} m).` : '.')
      : `The current layer (${s.currentDataset}) is not re-referenced; displacement layers are.`,
  };
}

// ── masks ────────────────────────────────────────────────────────────────────────────

const RECOMMENDED = 'recommended_mask';

function masksOf(state: AppState) {
  return state.layerMasks.map(m => ({ layer: m.dataset, threshold: m.threshold, mode: m.mode }));
}

async function getMasks(ctx: PageContext, ranges: boolean) {
  const s = ctx.getState();
  const out: Record<string, unknown> = {
    masks: masksOf(s),
    recommended_mask: RECOMMENDED in s.datasetInfo ? s.layerMasks.some(m => m.dataset === RECOMMENDED) : 'not in this cube',
    custom_mask: s.customMaskPath,
    note: 'mode min keeps pixels >= threshold; mode max keeps pixels <= threshold. Masks apply to the map (both sides), the chart and the data tools.',
  };
  if (ranges) {
    const names = Object.keys(s.datasetInfo).slice(0, 30);
    out.layers = await Promise.all(names.map(async name => {
      const info = s.datasetInfo[name];
      const entry: Record<string, unknown> = { layer: name, unit: info.unit ?? null, has_dates: (info.x_values ?? []).length > 1 };
      try {
        const r = await fetch(datasetRangeUrl(name));
        if (r.ok) Object.assign(entry, await r.json());
      } catch { /* the range is optional */ }
      return entry;
    }));
  }
  return out;
}

function setMasks(ctx: PageContext, input: Record<string, unknown>) {
  const s = ctx.getState();
  if (!Array.isArray(input.masks)) throw new Error('Give masks as a list of {dataset, threshold, mode}.');
  const wanted = (input.masks as Record<string, unknown>[]).map(m => {
    const layer = layerName(s, m.dataset ?? m.layer);
    const threshold = Number(m.threshold);
    if (!Number.isFinite(threshold)) throw new Error(`Give a number threshold for ${layer}.`);
    const mode = m.mode ?? 'min';
    if (mode !== 'min' && mode !== 'max') throw new Error('mode is min (keep >= threshold) or max (keep <= threshold).');
    return { layer, threshold, mode: mode as 'min' | 'max' };
  });
  const replace = input.replace !== false;
  // As the Masking panel: remove (the x), add (Add layer mask), or change a row's threshold and mode.
  if (replace) s.layerMasks.forEach(m => ctx.dispatch({ type: 'REMOVE_LAYER_MASK', payload: m.id }));
  wanted.forEach((m, i) => {
    const there = replace ? undefined : s.layerMasks.find(x => x.dataset === m.layer);
    if (there) {
      ctx.dispatch({ type: 'UPDATE_LAYER_MASK', payload: { id: there.id, updates: { threshold: m.threshold, mode: m.mode } } });
    } else {
      const id = m.layer === RECOMMENDED ? 'mask_recommended' : `mask_${Date.now()}_${i}`;
      ctx.dispatch({ type: 'ADD_LAYER_MASK', payload: { id, dataset: m.layer, threshold: m.threshold, mode: m.mode } });
    }
  });
  const applied = replace ? wanted : [
    ...masksOf(s).filter(x => !wanted.some(w => w.layer === x.layer)), ...wanted,
  ];
  return {
    ok: true,
    masks: applied,
    kept: applied.map(m => `${m.layer} ${m.mode === 'min' ? '>=' : '<='} ${m.threshold}`),
    note: 'Pixels are shown where every mask holds.',
  };
}

// ── display ──────────────────────────────────────────────────────────────────────────

const COLORMAPS = COLORMAP_OPTIONS.map(o => o.value);

function side(input: Record<string, unknown>, s: AppState): 'left' | 'right' {
  const v = input.side ?? 'left';
  if (v !== 'left' && v !== 'right') throw new Error('side is left or right.');
  if (v === 'right' && !(s.splitScreen && s.splitDataset)) throw new Error('Split screen is off or has no right layer; use set_split_screen first.');
  return v;
}

function display(s: AppState, which: 'left' | 'right') {
  const right = which === 'right';
  const layer = right ? s.splitDataset : s.currentDataset;
  const unit = (layer && s.datasetInfo[layer]?.unit) || null;
  return {
    side: which,
    layer,
    colormap: right ? s.splitColormap : s.colormap,
    reversed: isInverted(right ? s.splitColormap : s.colormap),
    vmin: right ? s.splitVmin : s.vmin,
    vmax: right ? s.splitVmax : s.vmax,
    unit: !right && s.wrapEnabled ? 'radians (rewrapped)' : unit,
    opacity: right ? s.splitOpacity : s.opacity,
    rewrap: right ? false : s.wrapEnabled,
  };
}

const LENGTH: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };
const isMetres = (u: string | null | undefined) => /^(m|meters?|metres?)(\s*\/\s*(yr|y|year|a))?$/i.test((u ?? '').trim());

async function setColorRange(ctx: PageContext, input: Record<string, unknown>) {
  const s = ctx.getState();
  const which = side(input, s);
  const cur = display(s, which);
  let lo: number, hi: number;
  if (input.preset !== undefined && input.preset !== null) {
    const preset = String(input.preset) as RangePreset;
    if (!RANGE_PRESETS.includes(preset)) throw new Error(`preset is one of ${RANGE_PRESETS.join(', ')}.`);
    // As the histogram's buttons: the layer's histogram at the date shown.
    const hist = preset === 'symmetric' ? null : await fetchHistogram(cur.layer as string, s.currentTimeIndex);
    const r = presetRange(preset, hist, cur.vmin, cur.vmax);
    if (!r) throw new Error(`Could not read the layer's histogram for ${preset}.`);
    [lo, hi] = r;
  } else {
    let k = 1;
    if (input.unit !== undefined && input.unit !== null) {
      const u = String(input.unit);
      if (!(u in LENGTH)) throw new Error('unit is m, cm, mm or in.');
      if (!isMetres(cur.unit as string)) throw new Error(`The layer's unit is ${cur.unit ?? 'not given'}, not a length in metres; give vmin/vmax in it, without unit.`);
      k = LENGTH[u];
    }
    lo = isNum(input.vmin) ? input.vmin * k : cur.vmin;
    hi = isNum(input.vmax) ? input.vmax * k : cur.vmax;
  }
  if (!(lo < hi)) throw new Error(`vmin (${lo}) must be below vmax (${hi}).`);
  ctx.dispatch({ type: which === 'right' ? 'SET_SPLIT_VMIN' : 'SET_VMIN', payload: lo });
  ctx.dispatch({ type: which === 'right' ? 'SET_SPLIT_VMAX' : 'SET_VMAX', payload: hi });
  return { ok: true, side: which, layer: cur.layer, vmin: lo, vmax: hi, unit: cur.unit, preset: input.preset ?? null };
}

function setColormap(ctx: PageContext, input: Record<string, unknown>) {
  const s = ctx.getState();
  const which = side(input, s);
  const asked = String(input.name ?? '').trim();
  const reversedName = /_r$/i.test(asked);
  const base = asked.replace(/_r$/i, '');
  const hit = COLORMAP_OPTIONS.find(o => o.value.toLowerCase() === base.toLowerCase() || o.label.toLowerCase() === base.toLowerCase());
  if (!hit) {
    const close = closeMatches(base, COLORMAPS);
    throw new Error(`No colormap ${JSON.stringify(asked)}${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}. Colormaps: ${COLORMAPS.join(', ')}.`);
  }
  const current = which === 'right' ? s.splitColormap : s.colormap;
  const reverse = typeof input.reverse === 'boolean' ? input.reverse : reversedName || isInverted(current);
  const name = withInvert(hit.value, reverse);
  ctx.dispatch({ type: which === 'right' ? 'SET_SPLIT_COLORMAP' : 'SET_COLORMAP', payload: name });
  return { ok: true, side: which, colormap: name, reversed: reverse };
}

async function switchLayer(ctx: PageContext, layer: string) {
  const state = ctx.getState();
  // As the Layer menu (Main tab): the layer, and the reference series a re-referenced layer needs.
  ctx.dispatch({ type: 'SET_CURRENT_DATASET', payload: layer });
  if (state.datasetInfo[layer].uses_spatial_ref) {
    await refDragEnd({ ...state, currentDataset: layer }, state.refMarkerPosition, ctx.api, ctx.dispatch);
  }
}

/** Run a page tool; returns what the model is told. Throws with a message for the model. */
export async function runPageTool(name: string, input: Record<string, unknown>, ctx: PageContext): Promise<unknown> {
  const state = ctx.getState();
  switch (name) {
    case 'get_view':
      return view(ctx);
    case 'fly_to': {
      const [lon, lat] = lonLat(input);
      if (input.zoom !== undefined && input.zoom !== null && !zoomOk(input.zoom)) throw new Error('zoom is 0-22.');
      await flyTo(ctx, lon, lat, zoomOk(input.zoom) ? input.zoom : undefined);
      return { ok: true, view: view(ctx) };
    }
    case 'fit_bounds': {
      const { west, south, east, north } = input;
      if (![west, south, east, north].every(isNum)) throw new Error('Give west, south, east and north.');
      const [w, s, e, n] = [west, south, east, north] as number[];
      if (w >= e || s >= n || Math.abs(w) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90) {
        throw new Error('Give west < east and south < north, in degrees.');
      }
      const padding = isNum(input.padding) ? Math.max(0, Math.min(400, input.padding)) : 40;
      await fitBounds(ctx, w, s, e, n, padding);
      return { ok: true, view: view(ctx) };
    }
    case 'pan':
      await pan(input);
      return { ok: true, view: view(ctx) };
    case 'zoom': {
      const nav = needMap();
      const { level, delta } = input;
      if ((level === undefined || level === null) === (delta === undefined || delta === null)) throw new Error('Give level or delta, not both.');
      const target = isNum(level) ? level : nav.getView().zoom + Number(delta);
      if (!zoomOk(target)) throw new Error('The zoom would be outside 0-22.');
      await nav.zoomTo(target);
      return { ok: true, view: view(ctx) };
    }
    case 'go_to': {
      const { best, attribution } = await geocodeBest(String(input.query ?? ''));
      const b = best.bbox as [number, number, number, number] | null;
      if (zoomOk(input.zoom)) await flyTo(ctx, best.lon, best.lat, input.zoom);
      // A place's extent, but not closer than street level (a dam or a house is a tiny box).
      else if (b && b[0] < b[2] && b[1] < b[3]) await fitBounds(ctx, b[0], b[1], b[2], b[3], 40, GO_TO_MAX_ZOOM);
      else await flyTo(ctx, best.lon, best.lat, GO_TO_MAX_ZOOM);
      return { ok: true, place: best.name, lon: best.lon, lat: best.lat, bbox: b, kind: best.kind, attribution, view: view(ctx) };
    }
    case 'set_terrain': {
      const nav = getNavigator();
      if (!nav?.terrain) throw new Error('3D terrain needs the MapLibre map (open Bowser without ?map=leaflet, in a browser with WebGL2).');
      if (typeof input.on !== 'boolean') throw new Error('Give on: true or false.');
      const ex = isNum(input.exaggeration) ? input.exaggeration : nav.terrain.get().exaggeration;
      if (input.pitch !== undefined && input.pitch !== null && !(isNum(input.pitch) && input.pitch >= 0 && input.pitch <= 85)) {
        throw new Error('pitch is 0-85 degrees.');
      }
      const done = await nav.terrain.set(input.on, ex, isNum(input.pitch) ? input.pitch : undefined);
      return {
        ok: true, terrain: done, pitch: round(nav.getView().pitch, 1),
        ...(isNum(input.exaggeration) && done.exaggeration !== input.exaggeration
          ? { note: `Exaggeration is ${EXAGGERATION_MIN}-${EXAGGERATION_MAX}; ${input.exaggeration} became ${done.exaggeration}.` } : {}),
      };
    }
    case 'set_split_screen': {
      if (typeof input.on !== 'boolean') throw new Error('Give on: true or false.');
      const left = input.left_layer ? layerName(state, input.left_layer) : null;
      const right = input.right_layer ? layerName(state, input.right_layer) : null;
      if (left && left !== state.currentDataset) await switchLayer(ctx, left);
      // The Right Layer menu (Main tab, in split screen) and the split-screen button.
      if (right) ctx.dispatch({ type: 'SET_SPLIT_DATASET', payload: right });
      if (state.splitScreen !== input.on) ctx.dispatch({ type: 'TOGGLE_SPLIT_SCREEN' });
      await new Promise(r => setTimeout(r, 0));
      const s = ctx.getState();
      return {
        ok: true, on: s.splitScreen,
        left: display(s, 'left'),
        right: s.splitDataset ? display(s, 'right') : null,
        note: s.splitScreen && !s.splitDataset ? 'Choose a right layer (right_layer).' : undefined,
      };
    }
    case 'add_point': {
      const [lon, lat] = lonLat(input);
      const label = addPoint(ctx, lon, lat, typeof input.name === 'string' ? input.name : undefined);
      return { ok: true, name: label, layer: state.currentDataset, note: 'The point is on the map and in the chart.' };
    }
    case 'get_reference':
      return reference(state);
    case 'set_reference_point': {
      const [lon, lat] = lonLat(input);
      return moveReference(ctx, lon, lat, input.radius_m);
    }
    case 'reset_reference': {
      const cube = state.datasetInfo[state.currentDataset]?.reference_lonlat;
      if (!cube) throw new Error(`The cube names no reference point for ${state.currentDataset || 'this layer'}; choose one with set_reference_point.`);
      return { ...(await moveReference(ctx, cube[0], cube[1])), note: "Back at the cube's own reference point." };
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
      const layer = layerName(state, input.layer);
      await switchLayer(ctx, layer);
      return { ok: true, layer };
    }
    case 'open_chart':
      openChart(ctx);
      return { ok: true, points: state.timeSeriesPoints.map(p => p.name), areas: state.chartAreas.map(a => a.name) };
    case 'add_overlay':
      return addOverlay(String(input.path ?? ''), typeof input.name === 'string' ? input.name : undefined, ctx);
    case 'get_masks':
      return getMasks(ctx, input.layer_ranges !== false);
    case 'set_masks':
      return setMasks(ctx, input);
    case 'clear_masks': {
      const keep = input.keep_recommended === true;
      state.layerMasks.filter(m => !(keep && m.dataset === RECOMMENDED))
        .forEach(m => ctx.dispatch({ type: 'REMOVE_LAYER_MASK', payload: m.id }));
      return { ok: true, masks: keep ? masksOf(state).filter(m => m.layer === RECOMMENDED) : [] };
    }
    case 'set_recommended_mask': {
      if (!(RECOMMENDED in state.datasetInfo)) throw new Error('This cube has no recommended_mask layer.');
      if (typeof input.on !== 'boolean') throw new Error('Give on: true or false.');
      const there = state.layerMasks.filter(m => m.dataset === RECOMMENDED);
      const initialMask = defaultMasks(state.datasetInfo, state.currentDataset)[0];
      if (input.on && !initialMask) throw new Error('The recommended mask is not compatible with this layer. Choose a static summary or a matching acquisition axis.');
      if (input.on && !there.length && initialMask) ctx.dispatch({ type: 'ADD_LAYER_MASK', payload: initialMask });
      if (!input.on) there.forEach(m => ctx.dispatch({ type: 'REMOVE_LAYER_MASK', payload: m.id }));
      return { ok: true, recommended_mask: input.on };
    }
    case 'get_display': {
      const which = side(input, state);
      return {
        ...display(state, which),
        split_screen: { on: state.splitScreen, left_layer: state.currentDataset || null, right_layer: state.splitDataset },
        colormaps: COLORMAPS,
        note: 'Add _r to a colormap (or reverse=true) to reverse it. vmin/vmax are in the layer\'s unit.',
      };
    }
    case 'set_colormap':
      return setColormap(ctx, input);
    case 'set_color_range':
      return setColorRange(ctx, input);
    case 'set_opacity': {
      const which = side(input, state);
      const o = Number(input.opacity);
      if (!(o >= 0 && o <= 1)) throw new Error('opacity is 0-1.');
      ctx.dispatch({ type: which === 'right' ? 'SET_SPLIT_OPACITY' : 'SET_OPACITY', payload: o });
      return { ok: true, side: which, opacity: o };
    }
    case 'list_commands':
      return { commands: listCommands(commandEnv(ctx), typeof input.query === 'string' ? input.query : undefined) };
    case 'run_command': {
      const args = (input.args ?? {}) as Record<string, unknown>;
      return runCommand(commandEnv(ctx), String(input.id ?? ''), args);
    }
    case 'list_context_layers':
      return {
        layers: listServices(state),
        highlights: state.overlays.filter(isHighlight).map(o => ({ name: o.name, features: o.data?.features.length ?? 0 })),
        note: 'add_context_layer / remove_context_layer switch these as the toggles in Overlays › Services do.',
      };
    case 'add_context_layer': {
      const opacity = isNum(input.opacity) ? input.opacity : undefined;
      const year = isNum(input.year) ? input.year : undefined;
      return { ok: true, ...(await addService(commandEnv(ctx), input.id, { opacity, year })) };
    }
    case 'remove_context_layer':
      return { ok: true, ...removeService(commandEnv(ctx), input.id) };
    case 'draw_highlight':
      return drawResult(commandEnv(ctx), String(input.result_id ?? ''),
        typeof input.name === 'string' ? input.name : undefined, typeof input.color === 'string' ? input.color : undefined);
    case 'highlight_infrastructure':
      return highlightInfrastructure(ctx, input);
    case 'clear_highlights':
      return clearHighlights(commandEnv(ctx), typeof input.name === 'string' && input.name ? input.name : undefined);
    case 'get_areas':
      return getAreas(state, typeof input.name === 'string' && input.name ? input.name : undefined);
    default:
      if (CHART_TOOL_NAMES.has(name)) return runChartTool(name, input, ctx);
      throw new Error(`No page tool ${name}.`);
  }
}

const commandEnv = (ctx: PageContext): CommandEnv => ({ getState: ctx.getState, dispatch: ctx.dispatch });

// ── areas and highlights ─────────────────────────────────────────────────────────────

type Geometry = { type: string; coordinates: unknown };

/** The shapes drawn on the map (Overlays › Draw) and the chart's areas, by name. */
function areasOf(state: AppState): { name: string; kind: string; geometry: Geometry }[] {
  const out: { name: string; kind: string; geometry: Geometry }[] = [];
  const drawings = state.overlays.find(o => o.id === DRAWINGS_ID);
  (drawings?.data?.features as { geometry?: Geometry | null }[] | undefined ?? []).forEach((f, i) => {
    if (f?.geometry) out.push({ name: drawingName(f) || `${f.geometry.type} ${i + 1}`, kind: `drawn ${f.geometry.type}`, geometry: f.geometry });
  });
  for (const a of state.chartAreas ?? []) out.push({ name: a.name, kind: 'chart area', geometry: a.geometry });
  return out;
}

function getAreas(state: AppState, name?: string) {
  const all = areasOf(state);
  if (!name) return { areas: all.map(a => ({ name: a.name, kind: a.kind })), note: 'Give a name to get its geometry.' };
  const hit = all.find(a => a.name === name) ?? all.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    const close = closeMatches(name, all.map(a => a.name));
    throw new Error(`No drawn shape or chart area ${JSON.stringify(name)}${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}. `
      + `Areas: ${all.map(a => a.name).join(', ') || 'none'}.`);
  }
  if (!['Polygon', 'MultiPolygon'].includes(hit.geometry.type)) throw new Error(`${hit.name} is a ${hit.geometry.type}, not an area.`);
  return hit;
}

/** Look up the infrastructure of an area on the server (POST /infrastructure), then draw it. */
async function highlightInfrastructure(ctx: PageContext, input: Record<string, unknown>) {
  const kinds = Array.isArray(input.kinds) && input.kinds.length ? input.kinds : ['roads'];
  const body: Record<string, unknown> = { kinds };
  let label = '';
  if (typeof input.area === 'string' && input.area) {
    const a = getAreas(ctx.getState(), input.area) as { name: string; geometry: Geometry };
    body.geometry = a.geometry;
    label = a.name;
  } else if (typeof input.zone === 'string' && input.zone) {
    body.zone = input.zone;
    label = `zone ${input.zone}`;
  } else if (Array.isArray(input.bbox)) {
    body.bbox = input.bbox;
    label = 'the box';
  } else if (input.geometry && typeof input.geometry === 'object') {
    body.geometry = input.geometry;
    label = 'the area';
  } else {
    throw new Error('Give one of geometry, bbox, area or zone.');
  }
  const res = await fetch('/infrastructure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const found = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(found.detail ?? `The server answered HTTP ${res.status}.`));
  const name = `${(kinds as string[]).join(', ')} in ${label}`.replace(/^./, c => c.toUpperCase());
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : undefined;
  const counts = Object.fromEntries(Object.entries(found.summary ?? {}).map(([k, v]) => [k, (v as { count: number }).count]));
  const about = { counts, text: found.text, attribution: found.attribution };
  if (!found.n_features) {
    return { ok: true, name, n_features: 0, ...about, note: 'Nothing found in OpenStreetMap there, so nothing was drawn.' };
  }
  const drawn = await drawResult(commandEnv(ctx), found.result_id, name, color);
  return { ...drawn, ...about, note: `On the map as "${name}" (Overlays › Layers); clear_highlights removes it.` };
}


/** A GeoTIFF on the server's disk as an overlay: only where the page may open server paths. */
async function addOverlay(path: string, name: string | undefined, ctx: PageContext): Promise<unknown> {
  if (!path.trim()) throw new Error('Give the path of a GeoTIFF on the server.');
  const [config, catalog] = await Promise.all([
    fetch('/config').then(r => r.json()).catch(() => ({})),
    fetch('/catalog').then(r => r.json()).catch(() => ({})),
  ]);
  if (!config.geotiff_upload) throw new Error('This server (bowser-lite) cannot show GeoTIFF overlays; run `bowser run`.');
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

/**
 * What the page shows, sent with each question (the relay tells the model; a few hundred
 * tokens): the view, layer and date, the reference, masks, points and areas, split screen,
 * terrain and the selected point. With it the model knows "here" without a tool call.
 */
export function pageState(state: AppState, dataset: string | null): Record<string, unknown> {
  const ds = state.currentDataset;
  const info = state.datasetInfo[ds];
  const dates = info?.x_values ?? [];
  const refIdx = state.refTimeIndex[ds];
  const [lat, lon] = state.refMarkerPosition;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const out: Record<string, unknown> = {
    layer: ds || null,
    layers: Object.keys(state.datasetInfo),
    date_shown: dates.length > 1 ? String(dates[state.currentTimeIndex] ?? '') : null,
    time_index: dates.length > 1 ? state.currentTimeIndex : null,
    reference_point: info?.uses_spatial_ref && state.refEnabled ? [r5(lon), r5(lat)] : null,
    reference_circle_m: info?.uses_spatial_ref && state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : null,
    reference_date: refIdx !== undefined ? String(dates[refIdx] ?? '') : info?.reference_date ?? null,
    points: state.timeSeriesPoints.slice(0, 12).map(p => ({ name: p.name, lon: r5(p.position[1]), lat: r5(p.position[0]) })),
    chart_open: state.showChart,
    masks: masksOf(state),
  };
  if (state.timeSeriesPoints.length > 12) out.more_points = state.timeSeriesPoints.length - 12;
  const areas = (state.chartAreas ?? []).map(a => a.name);
  if (areas.length) out.areas = areas.slice(0, 8);
  const selected = state.timeSeriesPoints.find(p => p.id === state.selectedPointId);
  if (selected) out.selected_point = selected.name;
  const nav = getNavigator();
  if (nav) {
    const v = nav.getView();
    out.view = { center: [r5(v.center[0]), r5(v.center[1])], zoom: Math.round(v.zoom * 10) / 10, bounds: v.bounds.map(r5) };
    const t = nav.terrain?.get();
    if (t?.enabled) out.terrain = { exaggeration: t.exaggeration, pitch: Math.round(v.pitch) };
  } else if (state.viewBounds) {
    const [so, w, n, e] = state.viewBounds;
    out.view = { bounds: [r5(w), r5(so), r5(e), r5(n)], center: [r5((w + e) / 2), r5((so + n) / 2)] };
  }
  if (state.splitScreen) out.split_screen = { left_layer: ds || null, right_layer: state.splitDataset };
  if (dataset) out.dataset = dataset;
  return out;
}

/** The page's layer masks as the server's data tools take them. */
export function pageMasks(state: AppState): { dataset: string; threshold: number; mode: 'min' | 'max' }[] {
  return state.layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode }));
}
