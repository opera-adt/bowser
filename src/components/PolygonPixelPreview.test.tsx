/** Real provider/API state; only the Chart.js canvas is replaced by an observer. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';
import { newDone, runPageTool } from '../assistant/pageTools';
type DrawOptions = {
  transitions?: { active?: { animation?: { duration?: number } } };
  plugins: { tooltip: { filter: (item: { dataset: Record<string, unknown> }) => boolean; animation?: false } };
};
const drawn = vi.hoisted(() => ({ options: null as DrawOptions | null, data: null as null | { datasets: Record<string, unknown>[] } }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef, useEffect } = await import('react');
  return { Line: forwardRef((props: { data: typeof drawn.data; options: DrawOptions }, _ref) => {
    drawn.data = props.data; drawn.options = props.options;
    useEffect(() => () => { drawn.data = null; }, []);
    return null;
  }) };
});
import TimeSeriesChart from './TimeSeriesChart';

const labels = ['2026-01-01', '2026-01-13', '2026-01-25'];
const geometry = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const layer: RasterGroup = { name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0,
  nodata: null, uses_spatial_ref: true, algorithm: 'shift', x_values: labels, latlon_bounds: [0, 0, 1, 1], available_mask_vars: [] };
type Body = { custom_mask_path?: string; curve_mode?: 'sample' | 'all'; sample_count?: number; layer_masks?: unknown[]; support: string };
let posted: { body: Body; signal?: AbortSignal | null }[];
let answerPreview: (body: Body) => Promise<Response>;
let dispatch: (action: AppAction) => void;
let current: AppState;
function payload(body: Body) {
  const masked = !!body.layer_masks?.length;
  const rows = masked ? [0, 7, 14] : [0, 6, 12];
  const all = [
    { row: 0, col: 0, x: 3, y: 4, values: [0, 6, 12] },
    ...(masked ? [{ row: 0, col: 1, x: 4, y: 4, values: [0, null, 16] }] : []),
  ];
  const curves = body.curve_mode === 'sample' ? all.slice(0, body.sample_count) : all;
  return { labels, units: 'meters', support: body.support, polygon_pixels: 2, common_pixels: 1,
    optional_masks_applied: masked,
    statistics: rows.map((v, i) => ({ count: masked && i !== 1 ? 2 : 1, mean: v, median: v, spatial_std: 1,
      minimum: v - 1, maximum: v + 1, percentiles: { '10': v - 1, '90': v + 1 } })),
    ...(body.curve_mode ? { pixel_curves: { mode: body.curve_mode, sample_seed: body.curve_mode === 'sample' ? 42 : null,
      eligible_pixels: all.length, plotted_pixels: curves.length, sampled: curves.length < all.length, curves } } : {}),
  };
}
function Harness() {
  const ctx = useAppContext(); current = ctx.state; dispatch = ctx.dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer, quality: { ...layer, name: 'quality', uses_spatial_ref: false } } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 1, 2] } });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_LAYER_MASK', payload: { id: 'q', dataset: 'quality', threshold: .5, mode: 'min' } });
    dispatch({ type: 'ADD_CHART_AREAS', payload: [{ id: 'area', name: 'Region', geometry }] });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return current.chartWindows[0] ? <TimeSeriesChart windowId={current.chartWindows[0].id} /> : null;
}
const pixels = () => drawn.data?.datasets.filter(d => d._pixelCurve) ?? [];
const values = () => pixels().map(d => (d.data as { y: number | null }[]).map(p => p.y));
const medians = () => (drawn.data?.datasets.find(d => d.label === 'Region median')?.data as { y: number }[] | undefined)?.map(p => p.y);
const requests = () => posted.filter(p => p.body.curve_mode);
const choose = (mode: string) => fireEvent.change(screen.getByLabelText('Polygon pixel histories'), { target: { value: mode } });
const change = (action: AppAction) => act(() => dispatch(action));
async function show() {
  render(<AppProvider><Harness /></AppProvider>);
  await waitFor(() => expect(medians()).toEqual([0, 6, 12]));
}
beforeEach(() => {
  posted = []; drawn.data = null;
  answerPreview = async body => new Response(JSON.stringify(payload(body)));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/config')) return new Response(JSON.stringify({ polygon_stats: true }));
    if (url.startsWith('/polygon_timeseries')) {
      const body = JSON.parse(String(init?.body)) as Body;
      posted.push({ body, signal: init?.signal });
      return body.curve_mode ? answerPreview(body) : new Response(JSON.stringify(payload(body)));
    }
    if (url.startsWith('/point')) return new Response('[0,1,2]');
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('polygon pixel controls', () => {
  it('starts off, adds bounded curves and keeps all-pixel summaries/Assistant statistics unchanged', async () => {
    await show();
    expect(requests()).toHaveLength(0);
    choose('sample');
    await waitFor(() => expect(values()).toEqual([[0, 5, 10], [0, null, 14]]));
    expect(requests()).toHaveLength(1);
    expect(requests()[0].body).toMatchObject({ curve_mode: 'sample', sample_count: 50, support: 'per_date' });
    expect(medians()).toEqual([0, 6, 12]);
    const out = await runPageTool('get_chart_data', {}, { getState: () => current, dispatch, api: {} as never, done: newDone() });
    expect(out).toMatchObject({ series: [{ kind: 'area', n: 3 }] });
    choose('none');
    await waitFor(() => expect(pixels()).toHaveLength(0));
    expect(medians()).toEqual([0, 6, 12]);
  });
  it('forwards an uploaded mask to previews and clears them if confirmation is missing', async () => {
    await show(); choose('sample'); await waitFor(() => expect(pixels()).toHaveLength(2));
    change({ type: 'SET_CUSTOM_MASK_PATH', payload: 'uploaded-mask.tif' });
    await waitFor(() => expect(requests()[requests().length - 1].body.custom_mask_path).toBe('uploaded-mask.tif'));
    await waitFor(() => expect(screen.getAllByText(/did not confirm every requested polygon mask/).length).toBeGreaterThan(0));
    expect(pixels()).toHaveLength(0);
    change({ type: 'SET_CUSTOM_MASK_PATH', payload: null });
    await waitFor(() => expect(pixels()).toHaveLength(2));
  });
  it('excludes pixel previews from index-mode tooltips while retaining summaries', async () => {
    await show(); choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    const filter = drawn.options!.plugins.tooltip.filter;
    expect(filter({ dataset: pixels()[0] })).toBe(false);
    expect(filter({ dataset: { label: 'Region median' } })).toBe(true);
    expect(filter({ dataset: { label: 'Point' } })).toBe(true);
  });
  it('turns hover and tooltip animations off only while pixel curves are shown', async () => {
    await show();
    expect(drawn.options!.transitions).toBeUndefined();
    expect(drawn.options!.plugins.tooltip.animation).toBeUndefined();
    choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    expect(drawn.options!.transitions?.active?.animation?.duration).toBe(0);
    expect(drawn.options!.plugins.tooltip.animation).toBe(false);
    choose('none');
    await waitFor(() => expect(pixels()).toHaveLength(0));
    await waitFor(() => expect(drawn.options!.transitions).toBeUndefined());
  });
  it('reuses native curves when references, baseline dates and display ranges change', async () => {
    await show(); choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    change({ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 2, 4] } });
    await waitFor(() => expect(values()).toEqual([[0, 4, 8], [0, null, 12]]));
    change({ type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } });
    await waitFor(() => expect(values()).toEqual([[-4, 0, 4]]));
    change({ type: 'SET_DATE_RANGE_START', payload: labels[1] });
    await waitFor(() => expect(values()).toEqual([[0, 4]]));
    expect(requests()).toHaveLength(1);
  });
  it('reports an older server without pretending the summary is a pixel history', async () => {
    answerPreview = async body => new Response(JSON.stringify({ ...payload(body), pixel_curves: undefined }));
    await show(); choose('sample');
    await waitFor(() => expect(screen.getByText(/does not provide pixel histories/)).toBeTruthy());
    expect(pixels()).toHaveLength(0);
    expect(medians()).toEqual([0, 6, 12]);
    expect(screen.queryByText('Loading pixel histories…')).toBeNull();
  });
  it('preserves summaries on a budget refusal and recovers with a smaller explicit sample', async () => {
    answerPreview = async body => body.curve_mode === 'all'
      ? new Response(JSON.stringify({ detail: 'Pixel-curve value budget exceeded' }), { status: 422 })
      : new Response(JSON.stringify(payload(body)));
    await show(); choose('all');
    await waitFor(() => expect(screen.getByText(/value budget exceeded/)).toBeTruthy());
    expect(pixels()).toHaveLength(0); expect(medians()).toEqual([0, 6, 12]);
    choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Pixel sample size'), { target: { value: '1' } });
    await waitFor(() => expect(pixels()).toHaveLength(1));
  });
  it('aborts pending histories when turned off and ignores their late response', async () => {
    let resolve: ((r: Response) => void) | undefined;
    answerPreview = () => new Promise(r => { resolve = r; });
    await show(); choose('sample');
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    choose('none');
    expect(requests()[0].signal?.aborted).toBe(true);
    await act(async () => resolve!(new Response(JSON.stringify(payload(requests()[0].body)))));
    expect(pixels()).toHaveLength(0); expect(medians()).toEqual([0, 6, 12]);
  });
  it('discards old curves and sends current masks when mask support changes', async () => {
    await show(); choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    change({ type: 'REMOVE_LAYER_MASK', payload: 'q' });
    expect(pixels()).toHaveLength(0);
    await waitFor(() => expect(values()).toEqual([[0, 5, 10]]));
    expect(requests()[requests().length - 1]?.body).toMatchObject({ support: 'common' });
  });
  it('rejects a sample over the bound without sending an oversized request', async () => {
    await show(); choose('sample');
    await waitFor(() => expect(pixels()).toHaveLength(2));
    const before = requests().length;
    fireEvent.change(screen.getByLabelText('Pixel sample size'), { target: { value: '501' } });
    await waitFor(() => expect(screen.getByText(/Choose a sample size from 1 to 500/)).toBeTruthy());
    expect(requests()).toHaveLength(before);
    expect(pixels()).toHaveLength(0);
    expect(medians()).toEqual([0, 6, 12]);
  });
  it('discloses inconsistent preview dates instead of mixing them with a different summary', async () => {
    answerPreview = async body => new Response(JSON.stringify({ ...payload(body), labels: [...labels].reverse() }));
    await show(); choose('sample');
    await waitFor(() => expect(screen.getByText(/dates do not match the area summary/)).toBeTruthy());
    expect(pixels()).toHaveLength(0);
    expect(medians()).toEqual([0, 6, 12]);
  });

});


it('refetches preview and summary under the same explicit pixel support', async () => {
  await show(); choose('sample');
  await waitFor(() => expect(pixels()).toHaveLength(2));
  change({ type: 'SET_AREA_SUPPORT', payload: 'common' });
  await waitFor(() => expect(requests()[requests().length - 1].body.support).toBe('common'));
  await waitFor(() => expect(current.areaStats['displacement::area']?.data?.support).toBe('common'));
  expect(posted[posted.length - 1].body.layer_masks).toBeTruthy();
  answerPreview = async body => new Response(JSON.stringify({ ...payload(body), support: 'common' }));
  change({ type: 'SET_AREA_SUPPORT', payload: 'per_date' });
  await waitFor(() => expect(screen.getByText(/requested pixel support/)).toBeTruthy());
  expect(pixels()).toHaveLength(0);
});

it('omits unavailable uploaded masks consistently from lite summaries and pixel previews', async () => {
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.startsWith('/config')
    ? Promise.resolve(new Response(JSON.stringify({ polygon_stats: true, geotiff_upload: false })))
    : original(url, init)));
  await show(); choose('sample');
  await waitFor(() => expect(pixels()).toHaveLength(2));
  change({ type: 'SET_CUSTOM_MASK_PATH', payload: 'unavailable-on-lite.tif' });
  await waitFor(() => expect(screen.getAllByText(/Uploaded mask not applied/).length).toBeGreaterThan(0));
  await waitFor(() => expect(pixels()).toHaveLength(2));
  expect(requests()[requests().length - 1].body.custom_mask_path).toBeUndefined();
  expect(medians()).toEqual([0, 6, 12]);
});
