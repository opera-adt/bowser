/**
 * A layer whose steps are intervals can have two ending on the same date. The chart draws
 * them at that date, but a click must still select the step that was clicked.
 */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState, RasterGroup } from '../types';

type Drawn = { data: null | { datasets: { label: string; data: { x: string; y: number; label?: string }[] }[] }; options: any };
const drawn = vi.hoisted(() => ({ data: null, options: null } as Drawn));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: Drawn, _ref) => { drawn.data = props.data; drawn.options = props.options; return null; }) };
});

import TimeSeriesChart from './TimeSeriesChart';

// The second and third steps end on the same date.
const STEPS = ['20260101_20260113', '20260101_20260125', '20260113_20260125', '20260113_20260206'];
const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values: STEPS, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
} as unknown as RasterGroup;

let stateRef: AppState;
function App() {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.1, 0.2], name: 'Point 1' } });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}

beforeEach(() => {
  drawn.data = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/multi_point')) return new Response('{}');
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({
      labels: STEPS,
      datasets: body.points.map((p: { id: string; name: string; color: string }) => ({
        label: p.name, pointId: p.id, borderColor: p.color, backgroundColor: p.color,
        data: STEPS.map((x, i) => ({ x, y: i / 100 })),
      })),
    }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('clicking a step of an interval layer', () => {
  it('selects the clicked interval when two end on the same date', async () => {
    render(<AppProvider><App /></AppProvider>);
    await waitFor(() => expect(drawn.data?.datasets.find(d => d.label === 'Point 1')?.data).toHaveLength(4));
    const datasets = drawn.data!.datasets.map(d => d.label === 'Point 1' ? { ...d, _series: { role: 'data' } } : d);
    const point = datasets.find(d => d.label === 'Point 1')!;
    // Both 2026-01-25 steps are drawn at the same x, one above the other (as Chart.js places
    // them: x by date, y by value). A click on each must select that step.
    const i = datasets.indexOf(point);
    const dots = point.data.map((p, j) => ({ x: [100, 200, 200, 300][j], y: 400 - 1000 * p.y }));
    const chart = {
      data: { datasets },
      getDatasetMeta: (k: number) => ({ data: k === i ? dots : [] }),
      scales: { x: { getValueForPixel: () => Date.parse('2026-01-25T00:00:00Z') } },
    };
    for (const index of [1, 2]) {
      act(() => drawn.options.onClick({ x: dots[index].x, y: dots[index].y + 2 }, [{ datasetIndex: i, index: 0 }], chart));
      expect(stateRef.currentTimeIndex).toBe(index);
    }
  });
});
