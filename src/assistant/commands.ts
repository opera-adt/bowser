/**
 * The page's commands: every toolbar and panel control the Assistant can use, in one registry
 * (`list_commands` / `run_command`, src/assistant/pageTools.ts). Each entry does exactly what
 * its control does: app actions are dispatched as the control dispatches them, and a control
 * whose state lives in its component (measure, profile, terrain, the toolbars, play) is clicked.
 * The map's toolbar buttons carry ``data-command="<id>"``; a test checks every one of them has
 * an entry here.
 *
 * Toggles take ``{on: true|false}`` and do nothing when already so, so running one twice is
 * safe. Commands that delete work are ``destructive``: the model is told to ask first. Nothing
 * here opens a URL or a file.
 */
import { baseMaps } from '../basemap';
import { getNavigator } from '../map/navigator';
import { applyTheme, shownTheme } from '../utils/theme';
import type { AppAction, AppState } from '../types';

export interface CommandEnv {
  getState: () => AppState;
  dispatch: (a: AppAction) => void;
  /** The document the controls are in (tests give their own). */
  doc?: Document;
}

type Schema = Record<string, unknown>;

export interface Command {
  id: string;
  label: string;
  description: string;
  /** JSON schema of the arguments (an object). */
  args?: Schema;
  /** A switch: run takes {on}, and `state` is whether it is on (null when it cannot be read). */
  toggle?: boolean;
  destructive?: boolean;
  state?: (env: CommandEnv) => unknown;
  run: (env: CommandEnv, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const ON = { type: 'object', properties: { on: { type: 'boolean', description: 'On (true) or off (false).' } }, required: ['on'] };

const tick = () => new Promise(r => setTimeout(r, 30));
const doc = (env: CommandEnv) => env.doc ?? document;
const button = (env: CommandEnv, id: string) => doc(env).querySelector<HTMLElement>(`[data-command="${id}"]`);
const isActive = (el: HTMLElement | null) =>
  el
    ? el.classList.contains('active') || el.classList.contains('on')
      || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-expanded') === 'true'
    : null;

function needOn(args: Record<string, unknown>): boolean {
  if (typeof args.on !== 'boolean') throw new Error('Give on: true or false.');
  return args.on;
}

/** A switch held in the app state: flipped by the control's own action when it differs. */
function stateToggle(
  id: string, label: string, description: string, isOn: (s: AppState) => boolean, flip: (env: CommandEnv) => void,
): Command {
  return {
    id, label, description, toggle: true, args: ON,
    state: env => isOn(env.getState()),
    run: async (env, args) => {
      const on = needOn(args);
      if (isOn(env.getState()) !== on) flip(env);
      await tick();
      return { on: isOn(env.getState()) };
    },
  };
}

/** A switch held in a component: its button (data-command) is clicked when it differs. */
function buttonToggle(id: string, label: string, description: string, tab?: string): Command {
  return {
    id, label, description, toggle: true, args: ON,
    state: env => isActive(button(env, id)),
    run: async (env, args) => {
      const on = needOn(args);
      if (tab && env.getState().panelTab !== tab) {
        env.dispatch({ type: 'SET_PANEL_TAB', payload: tab });
        await tick();
      }
      const el = button(env, id);
      if (!el) throw new Error(`${label} is not on the page now (the toolbar or panel holding it is hidden).`);
      if ((el as HTMLButtonElement).disabled) throw new Error(`${label} is not available on this map.`);
      if (isActive(el) !== on) el.click();
      await tick();
      return { on: isActive(button(env, id)) };
    },
  };
}

const TABS = ['main', 'overlays', 'stats', 'gnss', 'project', 'assistant'];
const BANDS = ['std', 'pct'];
const GRID = ['off', 'plain', 'zebra'];

export const COMMANDS: Command[] = [
  // ── map tools: the left toolbar ──
  buttonToggle('map.measure', 'Measure distance', 'Measure tool: click points on the map, double-click to finish.'),
  buttonToggle('map.profile', 'Profile line', 'Profile tool: click a start and an end to draw a line, double-click to extract the profile.'),
  stateToggle('map.identify', 'Identify', 'Map clicks show what is there (GNSS stations, geology, soil, land cover, layers) instead of adding points.',
    s => s.identifyEnabled, env => {
      const s = env.getState();
      env.dispatch({ type: 'TOGGLE_IDENTIFY' });
      env.dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: s.identifyEnabled
        ? 'Identify off: map clicks add time-series points again.'
        : 'Identify on: map clicks show what is there, not time-series points (click the arrow again to turn off).' });
    }),
  stateToggle('map.rereference', 'Spatial re-referencing', 'Subtract the reference point from the map and chart.',
    s => s.refEnabled, env => env.dispatch({ type: 'TOGGLE_REF_ENABLED' })),
  stateToggle('map.point_picking', 'Point picking', 'Map clicks add time-series points.',
    s => s.pointPickingEnabled, env => env.dispatch({ type: 'TOGGLE_POINT_PICKING' })),
  stateToggle('map.draw_tools', 'Drawing tools', 'The drawing toolbar on the map (draw points, lines and polygons; Overlays › Drawing tools).',
    s => s.drawingEnabled, env => env.dispatch({ type: 'SET_DRAWING_ENABLED', payload: !env.getState().drawingEnabled })),
  // ── map tools: the right toolbar ──
  {
    id: 'map.fit_view', label: 'Fit view to dataset', description: "Fit the map to the current layer's extent.",
    run: env => {
      const s = env.getState();
      const info = s.currentDataset ? s.datasetInfo[s.currentDataset] : null;
      if (!info) throw new Error('No layer is shown.');
      const b = info.latlon_bounds;
      env.dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [b[1], b[0], b[3], b[2]] });
      return { bounds: b };
    },
  },
  {
    id: 'map.basemap', label: 'Basemap', description: 'Choose the basemap (layer 1), and optionally a second one on top (layer 2, or none) with its opacity.',
    args: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: Object.keys(baseMaps), description: 'Basemap for layer 1.' },
        secondary: { type: ['string', 'null'], description: 'Basemap for layer 2, or null for none.' },
        secondary_opacity: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    state: env => ({ name: env.getState().selectedBasemap, secondary: env.getState().secondaryBasemap }),
    run: (env, a) => {
      const known = Object.keys(baseMaps);
      if (a.name !== undefined) {
        if (typeof a.name !== 'string' || !known.includes(a.name)) throw new Error(`No basemap ${JSON.stringify(a.name)}. Basemaps: ${known.join(', ')}.`);
        env.dispatch({ type: 'SET_BASEMAP', payload: a.name });
      }
      if (a.secondary !== undefined) {
        if (a.secondary !== null && (typeof a.secondary !== 'string' || !known.includes(a.secondary))) {
          throw new Error(`No basemap ${JSON.stringify(a.secondary)}. Basemaps: ${known.join(', ')}.`);
        }
        env.dispatch({ type: 'SET_SECONDARY_BASEMAP', payload: a.secondary as string | null });
      }
      if (typeof a.secondary_opacity === 'number') {
        env.dispatch({ type: 'SET_SECONDARY_BASEMAP_OPACITY', payload: Math.min(1, Math.max(0, a.secondary_opacity)) });
      }
      return { name: a.name ?? env.getState().selectedBasemap };
    },
  },
  {
    id: 'map.split_screen', label: 'Split screen', toggle: true,
    description: 'Compare two layers side by side; optionally the right layer (set_split_screen also sets the left one).',
    args: { type: 'object', properties: { on: ON.properties.on, right_layer: { type: 'string', description: 'Layer on the right.' } }, required: ['on'] },
    state: env => env.getState().splitScreen,
    run: async (env, a) => {
      const on = needOn(a);
      const s = env.getState();
      if (typeof a.right_layer === 'string') {
        if (!s.datasetInfo[a.right_layer]) throw new Error(`No layer ${JSON.stringify(a.right_layer)}. Layers: ${Object.keys(s.datasetInfo).join(', ')}.`);
        env.dispatch({ type: 'SET_SPLIT_DATASET', payload: a.right_layer });
      }
      if (s.splitScreen !== on) env.dispatch({ type: 'TOGGLE_SPLIT_SCREEN' });
      await tick();
      return { on: env.getState().splitScreen, right_layer: env.getState().splitDataset };
    },
  },
  stateToggle('map.colorbar', 'Colour bar', 'The colour bar on the map.', s => s.showColorbar, env => env.dispatch({ type: 'TOGGLE_COLORBAR' })),
  stateToggle('map.los', 'LOS indicator', "The radar's line-of-sight geometry on the map.", s => s.showLosIndicator, env => env.dispatch({ type: 'TOGGLE_LOS_INDICATOR' })),
  {
    id: 'map.grid', label: 'Lat/lon grid', description: 'The latitude/longitude grid: off, plain or zebra (a framed border).',
    args: { type: 'object', properties: { mode: { type: 'string', enum: GRID } }, required: ['mode'] },
    state: env => env.getState().graticuleMode,
    run: async (env, a) => {
      if (typeof a.mode !== 'string' || !GRID.includes(a.mode)) throw new Error(`Give mode: ${GRID.join(', ')}.`);
      // The button cycles off → plain → zebra; click until the mode is reached.
      for (let i = 0; i < 3 && env.getState().graticuleMode !== a.mode; i++) {
        env.dispatch({ type: 'CYCLE_GRATICULE' });
        await tick();
      }
      return { mode: env.getState().graticuleMode };
    },
  },
  stateToggle('map.annotations', 'Annotation mode', 'Map clicks place text labels.', s => s.annotationMode, env => env.dispatch({ type: 'TOGGLE_ANNOTATION_MODE' })),
  stateToggle('map.inspect', 'Inspect pixel', 'Show the pixel value under the cursor.', s => s.pixelInspectEnabled, env => env.dispatch({ type: 'TOGGLE_PIXEL_INSPECT' })),
  {
    id: 'map.terrain', label: '3D terrain', toggle: true, args: ON,
    description: '3D terrain on the MapLibre map, as its popover (set_terrain also sets the exaggeration and tilt).',
    state: () => getNavigator()?.terrain?.get().enabled ?? null,
    run: async (_env, a) => {
      const on = needOn(a);
      const terrain = getNavigator()?.terrain;
      if (!terrain) throw new Error('3D terrain needs the MapLibre map.');
      const now = terrain.get();
      if (now.enabled !== on) await terrain.set(on, now.exaggeration);
      return { on };
    },
  },
  {
    id: 'map.toolbar', label: 'Map toolbars', toggle: true, args: ON, description: 'Show or hide the map toolbars.',
    state: env => Boolean(doc(env).querySelector('.map-toolbar')),
    run: async (env, a) => {
      const on = needOn(a);
      if (Boolean(doc(env).querySelector('.map-toolbar')) !== on) button(env, 'map.toolbar')?.click();
      await tick();
      return { on: Boolean(doc(env).querySelector('.map-toolbar')) };
    },
  },
  {
    id: 'panel.sidebar', label: 'Sidebar', toggle: true, args: ON, description: 'Show or hide the side panel.',
    state: env => !doc(env).querySelector('.app-container.sidebar-hidden'),
    run: async (env, a) => {
      const on = needOn(a);
      if (!doc(env).querySelector('.app-container.sidebar-hidden') !== on) button(env, 'panel.sidebar')?.click();
      await tick();
      return { on: !doc(env).querySelector('.app-container.sidebar-hidden') };
    },
  },
  // ── the panel ──
  {
    id: 'panel.tab', label: 'Open a panel tab', description: `Show a tab of the side panel: ${TABS.join(', ')}.`,
    args: { type: 'object', properties: { tab: { type: 'string', enum: TABS } }, required: ['tab'] },
    state: env => env.getState().panelTab,
    run: (env, a) => {
      if (typeof a.tab !== 'string' || !TABS.includes(a.tab)) throw new Error(`Give tab: ${TABS.join(', ')}.`);
      env.dispatch({ type: 'SET_PANEL_TAB', payload: a.tab });
      return { tab: a.tab };
    },
  },
  buttonToggle('panel.layer_info', 'Layer description', "The (i) note under the layer: the producer's description and Bowser's guidance.", 'main'),
  {
    id: 'layers.overlay', label: 'Show or hide an overlay', description: 'Show or hide one of the overlays (Overlays tab), by name or id.',
    args: { type: 'object', properties: { name: { type: 'string', description: 'Overlay name or id.' }, on: ON.properties.on }, required: ['name', 'on'] },
    state: env => env.getState().overlays.map(o => ({ id: o.id, name: o.name, visible: o.visible })),
    run: (env, a) => {
      const on = needOn(a);
      const o = env.getState().overlays.find(x => x.id === a.name || x.name === a.name);
      if (!o) throw new Error(`No overlay ${JSON.stringify(a.name)}. Overlays: ${env.getState().overlays.map(x => x.name).join(', ') || 'none'}.`);
      env.dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { visible: on } } });
      return { name: o.name, on };
    },
  },
  // ── the chart ──
  stateToggle('chart.open', 'Time-series chart', 'The time-series chart window.', s => s.showChart, env => env.dispatch({ type: 'TOGGLE_CHART' })),
  stateToggle('chart.model', 'Model', 'Fit a model (trend, seasonal terms, steps) to each series in the chart.', s => s.showTrends, env => env.dispatch({ type: 'TOGGLE_TRENDS' })),
  stateToggle('chart.residuals', 'Residuals', "The model's residuals in the chart.", s => s.showResiduals, env => env.dispatch({ type: 'TOGGLE_RESIDUALS' })),
  buttonToggle('chart.display_options', 'Chart display options', "The chart's Display options section (open the chart first)."),
  {
    id: 'chart.band', label: 'Area band', description: "The band drawn around an area's series: std (mean ± std) or pct (p10–p90).",
    args: { type: 'object', properties: { band: { type: 'string', enum: BANDS } }, required: ['band'] },
    state: env => env.getState().areaBand,
    run: (env, a) => {
      if (typeof a.band !== 'string' || !BANDS.includes(a.band)) throw new Error(`Give band: ${BANDS.join(', ')}.`);
      env.dispatch({ type: 'SET_AREA_BAND', payload: a.band as AppState['areaBand'] });
      return { band: a.band };
    },
  },
  // ── time ──
  {
    id: 'time.step', label: 'Step the date', description: 'Show the previous (-1) or next (+1) date of the layer.',
    args: { type: 'object', properties: { by: { type: 'integer', minimum: -50, maximum: 50 } }, required: ['by'] },
    state: env => env.getState().currentTimeIndex,
    run: (env, a) => goToIndex(env, env.getState().currentTimeIndex + Number(a.by ?? 0)),
  },
  {
    id: 'time.go_to', label: 'Go to a date', description: 'Show a date of the layer: by index (0 = first) or date (YYYY-MM-DD, the nearest).',
    args: { type: 'object', properties: { index: { type: 'integer', minimum: 0 }, date: { type: 'string' } } },
    run: (env, a) => {
      if (typeof a.index === 'number') return goToIndex(env, a.index);
      const want = Date.parse(String(a.date ?? ''));
      if (Number.isNaN(want)) throw new Error('Give index, or date as YYYY-MM-DD.');
      const dates = layerDates(env.getState());
      let best = 0;
      dates.forEach((d, i) => { if (Math.abs(Date.parse(d) - want) < Math.abs(Date.parse(dates[best]) - want)) best = i; });
      return goToIndex(env, best);
    },
  },
  {
    id: 'time.play', label: 'Play the dates', toggle: true,
    description: 'Play through the dates (forward, or backward) or stop, as clicking a date arrow twice does (Main tab).',
    args: { type: 'object', properties: { on: ON.properties.on, backward: { type: 'boolean' } }, required: ['on'] },
    state: env => isActive(button(env, 'time.next')) || isActive(button(env, 'time.previous')),
    run: async (env, a) => {
      const on = needOn(a);
      if (env.getState().panelTab !== 'main') {
        env.dispatch({ type: 'SET_PANEL_TAB', payload: 'main' });
        await tick();
      }
      const id = a.backward ? 'time.previous' : 'time.next';
      const playing = ['time.next', 'time.previous'].find(x => isActive(button(env, x)));
      if (!on && playing) button(env, playing)?.click();
      if (on && playing !== id) {
        if (playing) button(env, playing)?.click();
        const el = button(env, id);
        if (!el) throw new Error('This layer has no dates to play.');
        el.click();
        el.click();
      }
      await tick();
      return { on: Boolean(['time.next', 'time.previous'].find(x => isActive(button(env, x)))) };
    },
  },
  // ── the page ──
  {
    id: 'page.theme', label: 'Theme', description: 'Dark or light colours for the page (or follow the system).',
    args: { type: 'object', properties: { theme: { type: 'string', enum: ['dark', 'light', 'system'] } }, required: ['theme'] },
    state: () => shownTheme(),
    run: (_env, a) => {
      if (!['dark', 'light', 'system'].includes(String(a.theme))) throw new Error('Give theme: dark, light or system.');
      applyTheme(a.theme as 'dark' | 'light' | 'system');
      return { theme: shownTheme() };
    },
  },
  {
    id: 'points.clear_all', label: 'Clear all points', destructive: true,
    description: 'Remove every time-series point from the map and chart. Destructive: ask the user first.',
    state: env => env.getState().timeSeriesPoints.length,
    run: env => {
      const points = env.getState().timeSeriesPoints;
      points.forEach(p => env.dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: p.id }));
      return { removed: points.length };
    },
  },
];

function layerDates(s: AppState): string[] {
  return (s.datasetInfo[s.currentDataset]?.x_values ?? []).map(String);
}

function goToIndex(env: CommandEnv, index: number) {
  const dates = layerDates(env.getState());
  if (dates.length < 2) throw new Error('The current layer has no dates.');
  const i = Math.max(0, Math.min(dates.length - 1, Math.round(index)));
  env.dispatch({ type: 'SET_TIME_INDEX', payload: i });
  return { index: i, date: dates[i] };
}

export const COMMAND_IDS = new Set(COMMANDS.map(c => c.id));

/** The registry as list_commands gives it, filtered by the words of ``query``. */
export function listCommands(env: CommandEnv, query?: string): Record<string, unknown>[] {
  const words = (query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return COMMANDS
    .filter(c => {
      const text = `${c.id} ${c.label} ${c.description}`.toLowerCase();
      return words.every(w => text.includes(w));
    })
    .map(c => {
      const out: Record<string, unknown> = { id: c.id, label: c.label, description: c.description };
      if (c.args) out.args = c.args;
      if (c.toggle) out.toggle = true;
      if (c.destructive) out.destructive = true;
      if (c.state) {
        try { out.state = c.state(env); } catch { out.state = null; }
      }
      return out;
    });
}

/** Run command ``id`` with ``args``; returns its new state. Throws with a message for the model. */
export async function runCommand(env: CommandEnv, id: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const c = COMMANDS.find(x => x.id === id);
  if (!c) {
    const close = COMMANDS.filter(x => x.id.includes(id) || id.includes(x.id.split('.').pop() ?? '')).map(x => x.id);
    throw new Error(`No command ${JSON.stringify(id)}.${close.length ? ` Did you mean ${close.join(', ')}?` : ''} See list_commands.`);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Give args as an object.');
  const props = (c.args?.properties ?? {}) as Record<string, unknown>;
  const extra = Object.keys(args).filter(k => !(k in props));
  if (extra.length) throw new Error(`${id} takes ${Object.keys(props).join(', ') || 'no arguments'}, not ${extra.join(', ')}.`);
  const result = await c.run(env, args);
  return { id, ...(typeof result === 'object' && result !== null ? result : { result }) };
}
