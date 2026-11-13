/** A late point/radius response cannot replace the current chart settings. */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ data: null as null | { datasets: Array<{ _series?: { role: string }; data: Array<{ y: number }> }> } }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef, useEffect } = await import('react');
  return { Line: forwardRef((props: { data: typeof drawn.data }, _ref) => {
    drawn.data = props.data;
    useEffect(() => () => { drawn.data = null; }, []);
    return null;
  }) };
});
import TimeSeriesChart from './TimeSeriesChart';

const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const layer: RasterGroup = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0.1,
  nodata: null, uses_spatial_ref: false, algorithm: null, x_values: dates,
  latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
};
interface Pending { path: string; body: { points?: Array<{ id: string }>; buffer_m?: number }; finish: (response: Response) => void }
let pending: Pending[];
let deferPoints: boolean;
let dispatch: (action: AppAction) => void;
let current: AppState;
const raw = () => drawn.data?.datasets.find(d => d._series?.role === 'data')?.data.map(p => p.y);
const median = () => drawn.data?.datasets.find(d => d._series?.role === 'median')?.data.map(p => p.y);
const change = (a: AppAction) => act(() => dispatch(a));
const response = (request: Pending, value: number, ok = true) => new Response(JSON.stringify(!ok ? { detail: 'Invalid requested mask' } : request.path === '/multi_point'
  ? { labels: dates, datasets: request.body.points!.map(p => ({ pointId: p.id, label: 'Point', data: dates.map((x, i) => ({ x, y: i * value })), borderColor: '#2468aa' })) }
  : { labels: dates, median: dates.map((x, i) => ({ x, y: i * value })), samples: [], n_pixels: 9 }), { status: ok ? 200 : 422 });
const finish = async (request: Pending, value: number, ok = true) => act(async () => request.finish(response(request, value, ok)));

function Harness({ buffer }: { buffer: boolean }) {
  const context = useAppContext(); current = context.state; dispatch = context.dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.5, 0.5] } });
    dispatch({ type: 'TOGGLE_CHART' });
    if (buffer) dispatch({ type: 'TOGGLE_BUFFER' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return current.chartWindows[0] ? <TimeSeriesChart windowId={current.chartWindows[0].id} /> : null;
}
const show = (buffer = false) => render(<AppProvider><Harness buffer={buffer} /></AppProvider>);

beforeEach(() => {
  pending = []; deferPoints = true; drawn.data = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/config')) return new Response('{}');
    if (url.startsWith('/point')) return new Response('[0,0,0]');
    if (url.startsWith('/multi_point') || url.startsWith('/buffer_timeseries')) {
      const path = url.split('?')[0];
      const body = JSON.parse(init!.body as string);
      if (path === '/multi_point' && !deferPoints) return response({ path, body, finish: () => {} }, 1);
      return new Promise<Response>(resolve => pending.push({ path, body, finish: resolve }));
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('chart request lifetimes', () => {
  it('ignores a late point response after a mask change', async () => {
    show(); await waitFor(() => expect(pending).toHaveLength(1));
    change({ type: 'ADD_LAYER_MASK', payload: { id: 'q', dataset: 'quality', threshold: 0.5, mode: 'min' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await finish(pending[1], 2); await waitFor(() => expect(raw()).toEqual([0, 2, 4]));
    await finish(pending[0], 9); expect(raw()).toEqual([0, 2, 4]);
  });

  it('does not revive an old point after the latest request failed', async () => {
    show(); await waitFor(() => expect(pending).toHaveLength(1));
    change({ type: 'ADD_LAYER_MASK', payload: { id: 'q', dataset: 'quality', threshold: 0.5, mode: 'min' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await finish(pending[1], 0, false); await waitFor(() => expect(raw()).toBeUndefined());
    await finish(pending[0], 9); expect(raw()).toBeUndefined();
  });

  it('clears the old curve while a changed reference is loading', async () => {
    show(); await waitFor(() => expect(pending).toHaveLength(1));
    await finish(pending[0], 1); await waitFor(() => expect(raw()).toEqual([0, 1, 2]));
    change({ type: 'SET_REF_MARKER_POSITION', payload: [0.6, 0.6] });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(raw()).toBeUndefined();
    await finish(pending[1], 2); await waitFor(() => expect(raw()).toEqual([0, 2, 4]));
  });

  it('does not restore a removed point from its pending request', async () => {
    show(); await waitFor(() => expect(pending).toHaveLength(1));
    change({ type: 'REMOVE_TIME_SERIES_POINT', payload: current.timeSeriesPoints[0].id });
    await finish(pending[0], 9); expect(raw()).toBeUndefined();
  });

  it.each([true, false])('ignores an older radius response after a newer result (success=%s)', async ok => {
    deferPoints = false; show(true);
    await waitFor(() => expect(pending).toHaveLength(1));
    change({ type: 'SET_BUFFER_RADIUS', payload: 15 });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].body.buffer_m).toBe(15);
    await finish(pending[1], 2, ok);
    await waitFor(() => ok ? expect(median()).toEqual([0, 2, 4]) : expect(median()).toBeUndefined());
    await finish(pending[0], 9);
    if (ok) expect(median()).toEqual([0, 2, 4]);
    else expect(median()).toBeUndefined();
  });

  it('a dragged radius asks a few times, not once per tick, and ends on the last value', async () => {
    deferPoints = false; show(true);
    await waitFor(() => expect(pending).toHaveLength(1));
    await finish(pending[0], 1); await waitFor(() => expect(median()).toEqual([0, 1, 2]));
    const radii = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    for (const r of radii) {
      change({ type: 'SET_BUFFER_RADIUS', payload: r });
      await act(async () => { await new Promise(done => setTimeout(done, 10)); });
    }
    // The old band is gone at once, while the request waits its turn.
    expect(median()).toBeUndefined();
    await waitFor(() => expect(pending[pending.length - 1].body.buffer_m).toBe(20));
    await act(async () => { await new Promise(done => setTimeout(done, 300)); });
    const asked = pending.slice(1).map(p => p.body.buffer_m);
    expect(asked.length).toBeLessThanOrEqual(3);            // ten ticks in about 100 ms
    expect(asked[asked.length - 1]).toBe(20);
    await finish(pending[pending.length - 1], 2);
    await waitFor(() => expect(median()).toEqual([0, 2, 4]));
  });
});
