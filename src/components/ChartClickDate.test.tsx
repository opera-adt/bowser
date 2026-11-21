/**
 * Clicking a point in the chart moves the map to that point's date. A series can have fewer
 * dates than the layer (masked dates are left out), so the point's position in its series is
 * not the layer's time step.
 */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState, RasterGroup } from '../types';

type Drawn = { data: null | { datasets: { label: string; data: { x: string; y: number }[] }[] }; options: any };
const drawn = vi.hoisted(() => ({ data: null, options: null } as Drawn));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: Drawn, _ref) => { drawn.data = props.data; drawn.options = props.options; return null; }) };
});

import TimeSeriesChart from './TimeSeriesChart';

const LABELS = ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01', '2020-05-01'];
// A mask hid the first two dates and the fourth at this point.
const VALID = ['2020-03-01', '2020-05-01'];
let chartLabels = LABELS;
let validLabels = VALID;
const layer = (x_values: string[]) => ({
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
}) as unknown as RasterGroup;

let stateRef: AppState;
function App({ onMap }: { onMap: string }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer(chartLabels), velocity: layer([]) } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: onMap });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.1, 0.2], name: 'Point 1' } });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}

beforeEach(() => {
  drawn.data = null; chartLabels = LABELS; validLabels = VALID;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/multi_point')) return new Response('{}');
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({
      labels: LABELS,
      datasets: body.points.map((p: { id: string; name: string; color: string }) => ({
        label: p.name, pointId: p.id, borderColor: p.color, backgroundColor: p.color,
        data: validLabels.map((x, i) => ({ x, y: i / 100 })),
      })),
    }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const series = () => drawn.data?.datasets.find(d => d.label === 'Point 1');
const click = (index: number) => act(() => {
  const datasetIndex = drawn.data!.datasets.findIndex(d => d.label === 'Point 1');
  drawn.options.onClick({}, [{ datasetIndex, index }], { data: drawn.data });
});

describe('clicking a date in the chart', () => {
  it("moves the map to that date, not to the point's position in its series", async () => {
    render(<AppProvider><App onMap="displacement" /></AppProvider>);
    await waitFor(() => expect(series()?.data.map(p => p.x.slice(0, 10))).toEqual(VALID));
    click(1);   // 2020-05-01: the second point of the series, the fifth step of the layer
    expect(stateRef.currentTimeIndex).toBe(4);
    click(0);   // 2020-03-01
    expect(stateRef.currentTimeIndex).toBe(2);
  });

  it('with the model on, the fitted line under the click does not decide the date', async () => {
    render(<AppProvider><App onMap="displacement" /></AppProvider>);
    await waitFor(() => expect(series()?.data.map(p => p.x.slice(0, 10))).toEqual(VALID));
    // What Chart.js hands over in "index" mode with the model line drawn first: the model's
    // element (its own dates are not acquisitions) and the click's time on the x scale.
    const model = { label: 'Point 1 model', _series: { role: 'model' }, data: [{ x: '2020-02-10', y: 0 }, { x: '2020-04-20', y: 0 }] };
    const datasets = [model, ...drawn.data!.datasets.map(d => d.label === 'Point 1' ? { ...d, _series: { role: 'data' } } : d)];
    const at = (iso: string) => ({ x: 7, scales: { x: { getValueForPixel: () => Date.parse(`${iso}T00:00:00Z`) } }, data: { datasets } });
    act(() => { const c = at('2020-04-25'); drawn.options.onClick({ x: c.x }, [{ datasetIndex: 0, index: 1 }], c); });
    expect(stateRef.currentTimeIndex).toBe(4);   // 2020-05-01, the observation nearest the click
    act(() => { const c = at('2020-02-20'); drawn.options.onClick({ x: c.x }, [{ datasetIndex: 0, index: 0 }], c); });
    expect(stateRef.currentTimeIndex).toBe(2);   // 2020-03-01
  });

  it('leaves the map alone when its layer has no such date', async () => {
    render(<AppProvider><App onMap="velocity" /></AppProvider>);
    await waitFor(() => expect(series()).toBeTruthy());
    const before = stateRef.currentTimeIndex;
    click(1);
    expect(stateRef.currentTimeIndex).toBe(before);
  });
});


it.each([['2026-01-01_2026-01-25', '2026-01-13_2026-01-25'], ['20260101_20260125', '20260113_20260125']])('clicks the second acquisition pair for %s when ending dates match', async (first, second) => {
  chartLabels = [first, second];
  validLabels = chartLabels;
  render(<AppProvider><App onMap="displacement" /></AppProvider>);
  await waitFor(() => expect(series()?.data).toHaveLength(2));
  expect(series()?.data.map(p => p.x)).toEqual(['2026-01-25', '2026-01-25']);
  click(1);
  expect(stateRef.currentTimeIndex).toBe(1);
  click(0);
  expect(stateRef.currentTimeIndex).toBe(0);
});
