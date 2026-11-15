/**
 * Which side-panel tabs render again for an action that does not concern them.
 *
 * All six tabs stay mounted (ControlPanel hides the inactive ones) and every one reads the
 * single app context, whose value is a new object on each dispatch. So a map move, a tick
 * of a slider or a step of the date player renders all of them again. What changes on every
 * mouse move (the split divider) is kept in a store of its own for that reason.
 *
 * This file pins that, action by action: RERENDERS says which tabs render again for one
 * dispatch. Work on the context (selectors, state moved out of the reducer) shows up here
 * as tabs leaving the lists; a tab coming back into one is a regression.
 */
import { Profiler, useEffect, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from './AppContext';
import type { AppAction, RasterGroup } from '../types';
import { DEFAULT_SPLIT_POSITION, setSplitPosition } from '../map/splitPosition';
import MainTab from '../components/panel/MainTab';
import OverlaysTab from '../components/panel/OverlaysTab';
import StatsTab from '../components/panel/StatsTab';
import GnssTab from '../components/panel/GnssTab';
import ProjectTab from '../components/panel/ProjectTab';

vi.mock('../components/Histogram', () => ({ default: () => null }));
vi.mock('react-chartjs-2', () => ({ Line: () => null, Bar: () => null }));

const TABS = { main: MainTab, overlays: OverlaysTab, stats: StatsTab, gnss: GnssTab, project: ProjectTab } as const;
type Tab = keyof typeof TABS;
const ALL = Object.keys(TABS) as Tab[];

const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const layer = (name: string, over: Partial<RasterGroup> = {}): RasterGroup => ({
  name, unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0.1, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: dates, latlon_bounds: [0, 0, 1, 1],
  available_mask_vars: [], ...over,
});

/**
 * The tabs that render again for one dispatch of each action, today. The comment says
 * which tab the action is for; every other name in a list is a render that buys nothing.
 */
const RERENDERS: Record<string, { action: AppAction; tabs: Tab[] }> = {
  // The map was moved (every moveend). Read on demand by Overlays and GNSS.
  'a map move': { action: { type: 'SET_VIEW_BOUNDS', payload: [0.1, 0.1, 0.9, 0.9] }, tabs: ALL },
  // A tick of the data layer's opacity slider (a map toolbar, not a tab).
  'an opacity tick': { action: { type: 'SET_OPACITY', payload: 0.6 }, tabs: ALL },
  // A step of the date player. Main shows the date; Stats the values at it.
  'a date step': { action: { type: 'SET_TIME_INDEX', payload: 2 }, tabs: ALL },
  // The chart panel is opened: the footer button's business, and the chart's.
  'opening the chart': { action: { type: 'TOGGLE_CHART' }, tabs: ALL },
};

let dispatch: (a: AppAction) => void;
const rendered = new Set<Tab>();

function Seed({ children }: { children: ReactNode }) {
  const ctx = useAppContext();
  dispatch = ctx.dispatch;
  useEffect(() => {
    ctx.dispatch({ type: 'SET_DATASETS', payload: { displacement: layer('displacement'), velocity: layer('velocity', { x_values: [] }) } });
    ctx.dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    ctx.dispatch({ type: 'SET_DATA_MODE', payload: 'md' });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <>{children}</>;
}

async function mount() {
  render(
    <AppProvider>
      <Seed>
        {ALL.map(tab => {
          const Content = TABS[tab];
          return <Profiler key={tab} id={tab} onRender={id => { rendered.add(id as Tab); }}><Content /></Profiler>;
        })}
      </Seed>
    </AppProvider>,
  );
  // Let the tabs' own start-up requests and effects settle before counting.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/config')) return new Response(JSON.stringify({ polygon_stats: true, geotiff_export: true }));
    if (url.startsWith('/catalog')) return new Response(JSON.stringify({ datasets: [], allow_open: false }));
    if (url.startsWith('/gnss')) return new Response(JSON.stringify({ stations: [] }));
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('side-panel tabs rendered again by an action', () => {
  it.each(Object.entries(RERENDERS))('%s', async (_name, { action, tabs }) => {
    await mount();
    rendered.clear();
    act(() => dispatch(action));
    expect([...rendered].sort()).toEqual([...tabs].sort());
  });

  it('a divider drag renders nothing: its position is not in the context', async () => {
    await mount();
    rendered.clear();
    act(() => setSplitPosition(0.4));
    expect([...rendered]).toEqual([]);
    setSplitPosition(DEFAULT_SPLIT_POSITION);
  });

  it('an action the reducer ignores renders nothing', async () => {
    await mount();
    rendered.clear();
    act(() => dispatch({ type: 'NOT_AN_ACTION' } as unknown as AppAction));
    expect([...rendered]).toEqual([]);
  });
});
