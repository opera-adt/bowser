/** Polygon charts and Stats share masked summaries and discard obsolete answers. */
import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ data: null as null | { datasets: Array<{ label: string; data: Array<{ y: number }> }> } }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: { data: typeof drawn.data }, _ref) => {
    drawn.data = props.data; return null;
  }) };
});

import TimeSeriesChart from './TimeSeriesChart';
import StatsTab from './panel/StatsTab';

const geometry = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
const mask = { id: 'q', dataset: 'quality', threshold: 0.5, mode: 'min' as const };
const layer: RasterGroup = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0.1,
  nodata: null, uses_spatial_ref: true, algorithm: 'shift', x_values: dates,
  latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
};
function result(masked: boolean, count = masked ? 4 : 9) {
  return {
    labels: dates, units: 'meters', polygon_pixels: 9, common_pixels: count,
    reference: 'stored', optional_masks_applied: masked,
    masks: masked ? [{ dataset: 'quality', threshold: 0.5, operator: '>=', temporal_support: 'static' }] : [],
    statistics: [0, masked ? 6 : 10, masked ? 12 : 20].map(value => ({
      count, mean: count ? value : null, median: count ? value : null,
      spatial_std: count ? 1 : null, minimum: count ? value - 1 : null,
      maximum: count ? value + 1 : null, percentiles: { 10: count ? value - 1 : null, 90: count ? value + 1 : null },
    })),
  };
}
type Body = { layer_masks?: Array<{ dataset: string; threshold: number; mode: string }> };
type Posted = { body: Body; signal?: AbortSignal | null };
let posted: Posted[];
let answer: (body: Body, signal?: AbortSignal | null) => Promise<Response>;
let dispatch: (action: AppAction) => void;
let current: AppState;

function Harness({ setup, stats }: { setup: AppAction[]; stats: boolean }) {
  const ctx = useAppContext(); current = ctx.state; dispatch = ctx.dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: {
      displacement: layer, quality: { ...layer, name: 'quality', uses_spatial_ref: false, unit: '' },
    } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 1, 2] } });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_CHART_AREAS', payload: [{ id: 'area', name: 'Region', geometry }] });
    setup.forEach(dispatch);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return current.chartWindows[0] ? <>
    <TimeSeriesChart windowId={current.chartWindows[0].id} />
    {stats && <StatsTab />}
  </> : null;
}
function show(setup: AppAction[] = [], stats = false) {
  return render(<AppProvider><Harness setup={setup} stats={stats} /></AppProvider>);
}
const medians = () => drawn.data?.datasets.find(d => d.label === 'Region median')?.data.map(p => p.y);
const change = (action: AppAction) => act(() => dispatch(action));

beforeEach(() => {
  posted = []; drawn.data = null;
  answer = async body => new Response(JSON.stringify(result(!!body.layer_masks?.length)));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/config')) return new Response(JSON.stringify({ polygon_stats: true }));
    if (url.startsWith('/polygon_timeseries')) {
      const body = JSON.parse(init!.body as string) as Body;
      posted.push({ body, signal: init?.signal });
      return answer(body, init?.signal);
    }
    if (url.startsWith('/point')) return new Response('[0,1,2]');
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('polygon masking controls', () => {
  it('sends only native mask fields, shares chart/Stats requests and applies the reference once', async () => {
    show([{ type: 'ADD_LAYER_MASK', payload: mask }], true);
    await waitFor(() => expect(medians()).toEqual([0, 5, 10]));
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({ variable: 'displacement', geometry, support: 'common',
      percentiles: [10, 90], layer_masks: [{ dataset: 'quality', threshold: 0.5, mode: 'min' }] });
    const row = screen.getByRole('listitem', { name: 'Region' });
    expect(within(row).getByText('Usable pixels').nextElementSibling!.textContent).toBe('4');
    expect(screen.queryByText(/masks not applied/)).toBeNull();
  });

  it('refetches on threshold/mode changes and restores stored support when masks are removed', async () => {
    show();
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    change({ type: 'ADD_LAYER_MASK', payload: mask });
    await waitFor(() => expect(medians()).toEqual([0, 5, 10]));
    change({ type: 'UPDATE_LAYER_MASK', payload: { id: 'q', updates: { threshold: 0.8, mode: 'max' } } });
    await waitFor(() => expect(posted[posted.length - 1]?.body.layer_masks?.[0]).toEqual({ dataset: 'quality', threshold: 0.8, mode: 'max' }));
    await waitFor(() => expect(current.areaStats['displacement::area']?.data).toBeTruthy());
    change({ type: 'REMOVE_LAYER_MASK', payload: 'q' });
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    expect(posted).toHaveLength(4);
  });

  it('keeps mask summaries when moving the reference or changing the reference date', async () => {
    show([{ type: 'ADD_LAYER_MASK', payload: mask }]);
    await waitFor(() => expect(medians()).toEqual([0, 5, 10]));
    change({ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 2, 4] } });
    await waitFor(() => expect(medians()).toEqual([0, 4, 8]));
    change({ type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } });
    await waitFor(() => expect(medians()).toEqual([-4, 0, 4]));
    expect(posted).toHaveLength(1);
  });

  it('aborts superseded requests and ignores a late success after a newer failure', async () => {
    let finish: ((response: Response) => void) | undefined;
    answer = body => body.layer_masks?.length
      ? Promise.resolve(new Response(JSON.stringify({ detail: 'Dynamic mask coordinates do not match' }), { status: 422 }))
      : new Promise(resolve => { finish = resolve; });
    show();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    change({ type: 'ADD_LAYER_MASK', payload: mask });
    await waitFor(() => expect(screen.getByText(/Dynamic mask coordinates do not match/)).toBeTruthy());
    expect(posted[0].signal?.aborted).toBe(true);
    await act(async () => finish!(new Response(JSON.stringify(result(false)))));
    expect(current.areaStats['displacement::area']?.data).toBeUndefined();
    expect(current.areaStats['displacement::area']?.error).toContain('Dynamic mask');
  });

  it('does not restore an earlier A request after masks change A to B to A', async () => {
    const pending: Array<(response: Response) => void> = [];
    answer = () => new Promise(resolve => { pending.push(resolve); });
    show();
    await waitFor(() => expect(pending).toHaveLength(1));
    change({ type: 'ADD_LAYER_MASK', payload: mask });
    await waitFor(() => expect(pending).toHaveLength(2));
    change({ type: 'REMOVE_LAYER_MASK', payload: 'q' });
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2](new Response(JSON.stringify(result(false)))));
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    await act(async () => {
      pending[1](new Response(JSON.stringify(result(true))));
      pending[0](new Response(JSON.stringify(result(false, 0))));
    });
    expect(current.areaStats['displacement::area']?.data?.common_pixels).toBe(9);
    expect(medians()).toEqual([0, 9, 18]);
  });

  it.each(['empty', 'network', 'unconfirmed'])(
    'clears the previous curve for a %s response and recovers when the mask is cleared', async kind => {
      show();
      await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
      answer = async body => {
        if (!body.layer_masks?.length) return new Response(JSON.stringify(result(false)));
        if (kind === 'network') throw new Error('offline');
        return new Response(JSON.stringify(result(kind !== 'unconfirmed', kind === 'empty' ? 0 : 9)));
      };
      change({ type: 'ADD_LAYER_MASK', payload: mask });
      await waitFor(() => expect(current.areaStats['displacement::area']?.error).toBeTruthy());
      expect(current.areaStats['displacement::area']?.data).toBeUndefined();
      change({ type: 'REMOVE_LAYER_MASK', payload: 'q' });
      await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    },
  );

  it('clears curves for unsupported uploaded masks and recovers when cleared', async () => {
    show();
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    change({ type: 'SET_CUSTOM_MASK_PATH', payload: 'uploaded-mask.tif' });
    await waitFor(() => expect(screen.getByText(/Area statistics do not yet support uploaded masks/)).toBeTruthy());
    expect(current.areaStats['displacement::area']?.data).toBeUndefined();
    expect(posted).toHaveLength(1);
    change({ type: 'SET_CUSTOM_MASK_PATH', payload: null });
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
  });

  it('refetches an edited geometry and does not resurrect a removed area', async () => {
    show();
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
    let finish: ((response: Response) => void) | undefined;
    answer = () => new Promise(resolve => { finish = resolve; });
    change({ type: 'UPDATE_CHART_AREA', payload: { id: 'area', updates: { geometry: { ...geometry, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] } } } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    change({ type: 'REMOVE_CHART_AREA', payload: 'area' });
    await act(async () => finish!(new Response(JSON.stringify(result(false)))));
    expect(current.areaStats['displacement::area']).toBeUndefined();
  });

  it('rejects an unsupported configured GeoTIFF mask without requesting unmasked statistics', async () => {
    show([
      { type: 'SET_DATA_MODE', payload: 'cog' },
      { type: 'SET_DATASETS', payload: { displacement: { ...layer, mask_file_list: ['mask.tif'] } } },
    ]);
    await waitFor(() => expect(current.areaStats['displacement::area']?.error).toContain('configured GeoTIFF'));
    expect(posted).toHaveLength(0);
    expect(screen.queryByText(/Masking hides every date/)).toBeNull();
  });

  it('sends a GeoTIFF upper bound and applies the spatial reference once', async () => {
    show([
      { type: 'SET_DATA_MODE', payload: 'cog' },
      { type: 'ADD_LAYER_MASK', payload: { ...mask, mode: 'max' } },
    ], true);
    await waitFor(() => expect(medians()).toEqual([0, 5, 10]));
    expect(posted).toHaveLength(1);
    expect(posted[0].body.layer_masks).toEqual([
      { dataset: 'quality', threshold: 0.5, mode: 'max' },
    ]);
    expect(current.areaStats['displacement::area']?.error).toBeUndefined();
    change({ type: 'REMOVE_LAYER_MASK', payload: 'q' });
    await waitFor(() => expect(medians()).toEqual([0, 9, 18]));
  });

  it.each(['source', 'project'])(
    'invalidates a pending response after changing the %s', async kind => {
      const pending: Array<(response: Response) => void> = [];
      answer = () => new Promise(resolve => { pending.push(resolve); });
      show();
      await waitFor(() => expect(pending).toHaveLength(1));
      change(kind === 'source'
        ? { type: 'SET_DATASETS', payload: { displacement: { ...layer, description: 'New source metadata' } } }
        : { type: 'LOAD_PROJECT', payload: { layerMasks: [mask] } });
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => pending[1](new Response(JSON.stringify(result(kind === 'project')))));
      const expected = kind === 'project' ? [0, 5, 10] : [0, 9, 18];
      await waitFor(() => expect(medians()).toEqual(expected));
      await act(async () => pending[0](new Response(JSON.stringify(result(false, 0)))));
      expect(medians()).toEqual(expected);
      expect(current.areaStats['displacement::area']?.error).toBeUndefined();
    },
  );
});
