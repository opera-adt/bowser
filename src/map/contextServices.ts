/**
 * The context layers of Overlays › Services, switched on and off in one place: by their toggles
 * (components/panel/OverlaysTab.tsx) and by the Assistant's page tools (list_context_layers,
 * add_context_layer, remove_context_layer), so a tool does exactly what a toggle does. Also the
 * highlight layers the AI tools draw (infrastructure and deformation zones from the server).
 */
import type { AppAction, AppState, Overlay, OverlayFeatures } from '../types';
import { CONTEXT_LAYERS, contextOverlay, LAND_COVER_YEARS, landCoverOverlay, type ContextKey } from './contextLayers';
import { geologyOverlay, soilsOverlay } from './services';
import { GNSS_LAYER_ID, type GnssStation } from './gnss';
import { featureBounds } from './fileParsers';

export interface ServiceEnv {
  getState: () => AppState;
  dispatch: (a: AppAction) => void;
}

export type ServiceId = ContextKey | 'land_cover' | 'geology' | 'soils' | 'gnss';

export interface ServiceInfo {
  id: ServiceId;
  label: string;
  shows: string;
  source: string;
}

const OSM = 'OpenStreetMap via OpenFreeMap';

/** The context layers, as the Services view lists them. */
export const SERVICES: ServiceInfo[] = [
  ...CONTEXT_LAYERS.map(c => ({ id: c.key, label: c.name, shows: c.note, source: OSM })),
  { id: 'land_cover', label: 'Land cover', shows: 'Sentinel-2 10 m land cover, yearly (water, trees, crops, built area...)', source: 'Impact Observatory, Microsoft, Esri' },
  { id: 'geology', label: 'Geology', shows: 'State geologic maps (SGMC), conterminous US', source: 'USGS' },
  { id: 'soils', label: 'Soils', shows: 'Soil map units in the view: peat, expansive clay, wet soils (US)', source: 'USDA SSURGO' },
  { id: 'gnss', label: 'GNSS stations', shows: 'GNSS stations in the view with their MIDAS velocities', source: 'Nevada Geodetic Laboratory (UNR)' },
];

export const SERVICE_IDS = SERVICES.map(s => s.id);

/** The overlay row a context layer added, if it is on. */
export function serviceRow(state: AppState, id: ServiceId): Overlay | undefined {
  if (id === 'land_cover') return state.overlays.find(o => o.landCoverYear);
  if (id === 'geology' || id === 'soils') return state.overlays.find(o => o.serviceKey === id);
  if (id === 'gnss') return state.overlays.find(o => o.id === GNSS_LAYER_ID);
  return state.overlays.find(o => o.type === 'context' && o.contextKey === id);
}

/** GNSS stations as the GNSS tab shows them on the map. */
export function gnssOverlay(list: GnssStation[]): Overlay {
  return {
    id: GNSS_LAYER_ID, name: 'GNSS stations (UNR)', type: 'vector', visible: true, opacity: 1, aboveData: true,
    color: '#e11d48', pointRadius: 5, lineWidth: 1,
    data: { type: 'FeatureCollection', features: list.map(s => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { ...s },
    })) },
    attribution: 'GNSS: Nevada Geodetic Laboratory (UNR), MIDAS velocities, NA fixed',
  };
}

export interface ServiceResult {
  id: ServiceId;
  on: boolean;
  name?: string;
  message?: string;
}

function checkId(id: unknown): ServiceId {
  if (typeof id === 'string' && (SERVICE_IDS as string[]).includes(id)) return id as ServiceId;
  throw new Error(`No context layer ${JSON.stringify(id)}. Context layers: ${SERVICE_IDS.join(', ')}.`);
}

/** The view as [west, south, east, north], or an error for the services that load for it. */
function viewBox(state: AppState, what: string): [number, number, number, number] {
  if (!state.viewBounds) throw new Error(`${what} load for the map's view, which is not known yet.`);
  const [south, west, north, east] = state.viewBounds;
  return [west, south, east, north];
}

/**
 * Turn a context layer on, as its toggle does (soils and GNSS load for the view). Already on:
 * only the opacity (and the land cover's year) change. ``id`` is checked.
 */
export async function addService(
  env: ServiceEnv, idIn: unknown, opts: { opacity?: number; year?: number } = {},
): Promise<ServiceResult> {
  const id = checkId(idIn);
  const { dispatch } = env;
  const state = env.getState();
  if (opts.opacity !== undefined && !(opts.opacity >= 0 && opts.opacity <= 1)) throw new Error('opacity is 0-1.');
  const there = serviceRow(state, id);
  const withOpacity = (o: Overlay): Overlay => (opts.opacity === undefined ? o : { ...o, opacity: opts.opacity });
  if (id === 'land_cover') {
    const year = opts.year ?? (there?.landCoverYear ?? LAND_COVER_YEARS[LAND_COVER_YEARS.length - 1]);
    if (!LAND_COVER_YEARS.includes(year)) throw new Error(`Land cover years: ${LAND_COVER_YEARS.join(', ')}.`);
    // As the toggle and its year menu: the old year's row goes, the new one comes.
    if (there) dispatch({ type: 'REMOVE_OVERLAY', payload: there.id });
    const o = withOpacity(landCoverOverlay(year, `landcover_${Date.now()}`));
    dispatch({ type: 'ADD_OVERLAY', payload: o });
    return { id, on: true, name: o.name };
  }
  if (there) {
    if (opts.opacity !== undefined) dispatch({ type: 'UPDATE_OVERLAY', payload: { id: there.id, updates: { opacity: opts.opacity } } });
    return { id, on: true, name: there.name, message: 'Already on.' };
  }
  if (id === 'geology') {
    const o = withOpacity(geologyOverlay(`geology_${Date.now()}`));
    dispatch({ type: 'ADD_OVERLAY', payload: o });
    return { id, on: true, name: o.name };
  }
  if (id === 'soils') {
    const view = viewBox(state, 'Soils');
    dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: 'Loading soils in this view…' });
    try {
      const { overlay, notes } = await soilsOverlay(view, `soils_${Date.now()}`);
      const n = overlay.data?.features.length ?? 0;
      if (n) dispatch({ type: 'ADD_OVERLAY', payload: withOpacity(overlay) });
      const message = n
        ? `Soils: ${n.toLocaleString()} map units.${notes.length ? ` Left out: ${notes.join('; ')}.` : ''}`
        : 'No soil survey in this view (SSURGO covers the US).';
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: message });
      return { id, on: n > 0, name: n ? overlay.name : undefined, message };
    } catch (err) {
      const message = `Could not load soils: ${(err as Error).message}`;
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: message });
      throw new Error(message);
    }
  }
  if (id === 'gnss') {
    const [west, south, east, north] = viewBox(state, 'GNSS stations');
    const q = new URLSearchParams({ west: String(west), south: String(south), east: String(east), north: String(north) });
    const res = await fetch(`/gnss/stations?${q}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Could not find GNSS stations: ${body.detail ?? `HTTP ${res.status}`}`);
    const list = (body.stations ?? []) as GnssStation[];
    if (!list.length) return { id, on: false, message: 'No GNSS stations with 3+ years of data in this view.' };
    const o = withOpacity(gnssOverlay(list));
    dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_LAYER_ID });
    dispatch({ type: 'ADD_OVERLAY', payload: o });
    return { id, on: true, name: o.name, message: `${list.length} stations.` };
  }
  const o = withOpacity(contextOverlay(id, `ctx_${id}_${Date.now()}`));
  dispatch({ type: 'ADD_OVERLAY', payload: o });
  return { id, on: true, name: o.name };
}

/** Turn a context layer off, as its toggle does. */
export function removeService(env: ServiceEnv, idIn: unknown): ServiceResult {
  const id = checkId(idIn);
  const row = serviceRow(env.getState(), id);
  if (row) env.dispatch({ type: 'REMOVE_OVERLAY', payload: row.id });
  return { id, on: false, message: row ? undefined : 'It was not on.' };
}

/** What list_context_layers says: every context layer, and whether it is on. */
export function listServices(state: AppState): Record<string, unknown>[] {
  return SERVICES.map(s => {
    const row = serviceRow(state, s.id);
    return {
      ...s, on: Boolean(row),
      ...(row ? { opacity: row.opacity, visible: row.visible } : {}),
      ...(s.id === 'land_cover' ? { year: row?.landCoverYear ?? null, years: LAND_COVER_YEARS } : {}),
    };
  });
}

// ── highlight layers (the AI tools' results) ─────────────────────────────────────────────

/** Ids of highlight overlays start with this. */
export const HIGHLIGHT_PREFIX = 'ai_hl_';
export const HIGHLIGHT_COLOR = '#f97316';
export const ZONES_COLOR = '#c026d3';

export const isHighlight = (o: Overlay) => o.id.startsWith(HIGHLIGHT_PREFIX);

/** A highlight overlay of features from the server (one per result: drawing it again replaces it). */
export function highlightOverlay(resultId: string, name: string, data: OverlayFeatures, kind: string, color?: string): Overlay {
  return {
    id: `${HIGHLIGHT_PREFIX}${resultId}`, name, type: 'vector', visible: true, opacity: 0.9, aboveData: true,
    data, bounds: featureBounds(data), color: color ?? (kind === 'zones' ? ZONES_COLOR : HIGHLIGHT_COLOR),
    lineWidth: kind === 'zones' ? 2 : 3, pointRadius: 6,
    attribution: kind === 'zones'
      ? 'Deformation zones from the cube (Bowser)'
      : 'Data © OpenStreetMap contributors, ODbL 1.0, via the Overpass API',
  };
}

/** Draw a result kept on the server (GET /context/results/<id>); returns what was drawn. */
export async function drawResult(env: ServiceEnv, resultId: string, name?: string, color?: string) {
  if (!/^[a-z]{1,4}-[A-Za-z0-9_-]{4,16}$/.test(resultId)) throw new Error('Give a result_id from a tool.');
  const res = await fetch(`/context/results/${resultId}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.detail ?? `The server answered HTTP ${res.status}.`));
  const data = body.features as OverlayFeatures;
  const label = (name ?? '').trim().slice(0, 80) || (body.kind === 'zones' ? 'Deformation zones' : 'Infrastructure');
  const o = highlightOverlay(resultId, label, data, body.kind, color);
  env.dispatch({ type: 'REMOVE_OVERLAY', payload: o.id });
  env.dispatch({ type: 'ADD_OVERLAY', payload: o });
  return { ok: true, name: label, layer_id: o.id, n_features: data.features.length };
}

/** Remove the highlight layers (all, or the one named ``name``). */
export function clearHighlights(env: ServiceEnv, name?: string) {
  const rows = env.getState().overlays.filter(o => isHighlight(o) && (!name || o.name === name));
  if (name && !rows.length) {
    const names = env.getState().overlays.filter(isHighlight).map(o => o.name);
    throw new Error(`No highlight layer ${JSON.stringify(name)}. Highlights: ${names.join(', ') || 'none'}.`);
  }
  rows.forEach(o => env.dispatch({ type: 'REMOVE_OVERLAY', payload: o.id }));
  return { ok: true, removed: rows.map(o => o.name) };
}
