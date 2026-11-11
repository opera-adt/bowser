/**
 * "Sample around ref marker" (Main › Reference Point) changes the chart as it changes the map:
 * turning it on or off, or changing its radius, fetches the points' series again with the new
 * ``ref_buffer_m``.
 */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, RasterGroup } from '../types';

vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((_props: unknown, _ref) => null) };
});

import TimeSeriesChart from './TimeSeriesChart';

const LABELS = ['2020-01-01', '2020-02-01', '2020-03-01'];
const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: LABELS, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
} as unknown as RasterGroup;

let multiPoint: { ref_buffer_m: number }[];
let dispatchRef: (a: AppAction) => void = () => {};
const last = () => multiPoint[multiPoint.length - 1].ref_buffer_m;

function App() {
  const { state, dispatch } = useAppContext();
  dispatchRef = dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.1, 0.2] } });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}

beforeEach(() => {
  multiPoint = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/multi_point')) {
      multiPoint.push(JSON.parse(init!.body as string));
      return new Response(JSON.stringify({ labels: LABELS, datasets: [] }));
    }
    return new Response('{}');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the chart and the sample around the reference marker', () => {
  it('fetch the series again when it is turned on, resized and turned off', async () => {
    render(<AppProvider><App /></AppProvider>);
    await waitFor(() => expect(multiPoint.length).toBeGreaterThan(0));
    expect(last()).toBe(0);

    await act(async () => { dispatchRef({ type: 'TOGGLE_REF_BUFFER' }); });
    await waitFor(() => expect(last()).toBe(500));

    await act(async () => { dispatchRef({ type: 'SET_REF_BUFFER_RADIUS', payload: 1200 }); });
    await waitFor(() => expect(last()).toBe(1200));

    await act(async () => { dispatchRef({ type: 'TOGGLE_REF_BUFFER' }); });
    await waitFor(() => expect(last()).toBe(0));
  });
});
