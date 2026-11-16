/** Data charts forward display masks; changes invalidate previous curves. */
import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ data: null as null | { datasets: Array<{ _series?: { role: string }; data: Array<{ y: number }> }> } }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef, useEffect } = await import('react');
  return { Line: forwardRef((props: { data: typeof drawn.data }, _ref) => { drawn.data = props.data; useEffect(() => () => { drawn.data = null; }, []); return null; }) };
});
import TimeSeriesChart from './TimeSeriesChart';

const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const layer: RasterGroup = { name: 'displacement', unit: 'meters', file_list: [], mask_file_list: ['configured.tif'], mask_min_value: 0,
  nodata: null, uses_spatial_ref: false, algorithm: null, x_values: dates, latlon_bounds: [0,0,1,1], available_mask_vars: [] };
let dispatch: (a: AppAction) => void;
let current: AppState;
let calls: Array<{ path: string; body: Record<string, unknown> }>;
let fail: boolean;
let uploadSupport: boolean | undefined;
function Harness({ buffer, mode, savedMask }: { buffer: boolean; mode: 'md' | 'cog'; savedMask?: string }) {
  const context = useAppContext(); dispatch = context.dispatch; current = context.state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_DATA_MODE', payload: mode });
    if (savedMask) dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: savedMask });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.5,0.5] } });
    dispatch({ type: 'TOGGLE_CHART' });
    if (buffer) dispatch({ type: 'TOGGLE_BUFFER' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return current.chartWindows[0] ? <TimeSeriesChart windowId={current.chartWindows[0].id} /> : null;
}
const show = (buffer = false, mode: 'md' | 'cog' = 'cog', savedMask?: string) => render(<AppProvider><Harness buffer={buffer} mode={mode} savedMask={savedMask} /></AppProvider>);
const change = (path: string | null) => act(() => dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: path }));
const raw = () => drawn.data?.datasets.find(d => d._series?.role === 'data')?.data.map(p => p.y);
const median = () => drawn.data?.datasets.find(d => d._series?.role === 'median')?.data.map(p => p.y);

beforeEach(() => {
  calls = []; drawn.data = null; fail = false; uploadSupport = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/config')) return new Response(JSON.stringify({ geotiff_upload: uploadSupport }));
    if (url.startsWith('/point')) return new Response('[0,0,0]');
    if (url.startsWith('/multi_point') || url.startsWith('/buffer_timeseries')) {
      const body = JSON.parse(init!.body as string); const path = url.split('?')[0]; calls.push({ path, body });
      if (fail && body.custom_mask_path) return new Response('{}', { status: 422 });
      const data = body.custom_mask_path ? [] : dates.map((x,i) => ({ x, y: i }));
      return new Response(JSON.stringify(path === '/multi_point'
        ? { labels: dates, datasets: body.points.map((p: { id: string }) => ({ pointId: p.id, label: 'Point', data, borderColor: '#2468aa' })) }
        : { labels: dates, median: data, samples: [], n_pixels: data.length ? 9 : 0 }));
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('forwards the configured primary mask and a valid zero threshold', async () => {
  show(); await waitFor(() => expect(raw()).toEqual([0,1,2]));
  expect(calls.find(c => c.path === '/multi_point')!.body).toMatchObject({ primary_mask: true, mask_min_value: 0 });
});
it('refreshes and clears point measurements for an uploaded mask and restores them', async () => {
  show(); await waitFor(() => expect(raw()).toEqual([0,1,2]));
  change('uploaded.tif'); await waitFor(() => expect(calls[calls.length - 1]!.body.custom_mask_path).toBe('uploaded.tif'));
  await waitFor(() => expect(raw() ?? []).toEqual([]));
  change(null); await waitFor(() => expect(raw()).toEqual([0,1,2]));
});
it('clears a failed buffer request, explains it, then recovers when cleared', async () => {
  show(true); await waitFor(() => expect(median()).toEqual([0,1,2]));
  expect(calls.find(c => c.path === '/buffer_timeseries')!.body).toMatchObject({ primary_mask: true, mask_min_value: 0 });
  fail = true; change('bad-mask.tif');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Buffer data unavailable/));
  expect(median()).toBeUndefined();
  change(null); await waitFor(() => expect(median()).toEqual([0,1,2]));
  expect(screen.queryByRole('alert')).toBeNull();
});

for (const buffer of [false, true]) {
  it(`keeps ${buffer ? 'radius' : 'point'} charts working for a lite project with an uploaded mask`, async () => {
    uploadSupport = false;
    show(buffer, 'md', 'saved-full-server-mask.tif');
    await waitFor(() => expect(buffer ? median() : raw()).toEqual([0,1,2]));
    expect(screen.getByText(/Uploaded mask not applied: this server cannot read/)).toBeTruthy();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => !('custom_mask_path' in c.body) && !('primary_mask' in c.body))).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
}
