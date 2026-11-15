/**
 * Which side-panel tabs render again for an action that does not concern them.
 *
 * All six tabs stay mounted (ControlPanel hides the inactive ones) and every one reads the
 * single app context, whose value is a new object on each dispatch. So a map move, a tick
 * of a slider or a step of the date player renders all of them again. What changes on every
 * mouse move or map move (the split divider, the view's bounds) is kept in a store of its own
 * for that reason.
 *
 * This file pins that, action by action: RERENDERS says which tabs render again for one
 * dispatch. Work on the context (selectors, state moved out of the reducer) shows up here
 * as tabs leaving the lists; a tab coming back into one is a regression.
 */
import { Profiler, useEffect, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext, useAppDispatch, useAppFields, useAppState, useGetAppState } from './AppContext';
import type { AppAction, RasterGroup } from '../types';
import { DEFAULT_SPLIT_POSITION, setSplitPosition } from '../map/splitPosition';
import { setViewBounds } from '../map/viewBounds';
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
  // A tick of the data layer's opacity slider. Main has the slider.
  'an opacity tick': { action: { type: 'SET_OPACITY', payload: 0.6 }, tabs: ['main'] },
  // A step of the date player. Main shows the date, Stats the values at it, Project's export its file name.
  'a date step': { action: { type: 'SET_TIME_INDEX', payload: 2 }, tabs: ['main', 'project', 'stats'] },
  // The chart panel is opened. Stats fetches for the chart's areas while it is open.
  'opening the chart': { action: { type: 'TOGGLE_CHART' }, tabs: ['stats'] },
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

  // GNSS lists each station's distance from the view; Project's GIF export crops to it.
  it('a map move renders only the two tabs that show something of the view', async () => {
    await mount();
    rendered.clear();
    act(() => setViewBounds([0.1, 0.1, 0.9, 0.9]));
    expect([...rendered].sort()).toEqual(['gnss', 'project']);
    setViewBounds(null);
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

describe('a component that follows one part of the state', () => {
  const renders = { opacity: 0, dispatchOnly: 0 };
  let read: () => { opacity: number; currentTimeIndex: number };
  function Opacity() { renders.opacity++; return <span data-testid="opacity">{useAppState(s => s.opacity)}</span>; }
  function DispatchOnly() { renders.dispatchOnly++; useAppDispatch(); read = useGetAppState(); return null; }

  it('renders for its part only, and reads the rest when asked', () => {
    const view = render(<AppProvider><Seed><Opacity /><DispatchOnly /></Seed></AppProvider>);
    renders.opacity = renders.dispatchOnly = 0;
    act(() => dispatch({ type: 'SET_TIME_INDEX', payload: 2 }));
    act(() => dispatch({ type: 'TOGGLE_CHART' }));
    expect(renders).toEqual({ opacity: 0, dispatchOnly: 0 });
    act(() => dispatch({ type: 'SET_OPACITY', payload: 0.35 }));
    expect(renders).toEqual({ opacity: 1, dispatchOnly: 0 });
    expect(view.getByTestId('opacity').textContent).toBe('0.35');
    expect(read()).toMatchObject({ opacity: 0.35, currentTimeIndex: 2 });
  });

  it('sees every action of one event together, as readers of the whole state do', () => {
    const seen: string[] = [];
    function Whole() { const { state } = useAppContext(); seen.push(`whole ${state.opacity}/${state.currentTimeIndex}`); return null; }
    function Part() { seen.push(`part ${useAppState(s => s.opacity)}/${useAppState(s => s.currentTimeIndex)}`); return null; }
    render(<AppProvider><Seed><Whole /><Part /></Seed></AppProvider>);
    seen.length = 0;
    act(() => { dispatch({ type: 'SET_OPACITY', payload: 0.2 }); dispatch({ type: 'SET_TIME_INDEX', payload: 1 }); });
    expect(seen).toEqual(['whole 0.2/1', 'part 0.2/1']);
  });

  it('following several fields renders when one of them changes, and for nothing else', () => {
    let count = 0;
    function Two() { count++; const state = useAppFields('opacity', 'showChart'); return <span data-testid="two">{`${state.opacity} ${state.showChart}`}</span>; }
    const view = render(<AppProvider><Seed><Two /></Seed></AppProvider>);
    count = 0;
    act(() => dispatch({ type: 'SET_TIME_INDEX', payload: 1 }));
    expect(count).toBe(0);
    act(() => dispatch({ type: 'SET_OPACITY', payload: 0.5 }));
    act(() => dispatch({ type: 'TOGGLE_CHART' }));
    expect(count).toBe(2);
    expect(view.getByTestId('two').textContent).toBe('0.5 true');
  });

  it('outside the provider says so', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Lost() { useAppState(s => s.opacity); return null; }
    expect(() => render(<Lost />)).toThrow(/within an AppProvider/);
    quiet.mockRestore();
  });
});
