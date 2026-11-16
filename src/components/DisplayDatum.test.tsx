/** An explicitly non-independent datum is visible without becoming a measurement. */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

type Drawn = { data: null | { datasets: { label: string; data: { x: string; y: number }[] }[] }; options: Record<string, unknown> | null };
const drawn = vi.hoisted(() => ({ data: null, options: null } as Drawn));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: Drawn, _ref) => { drawn.data = props.data; drawn.options = props.options; return null; }) };
});

import TimeSeriesChart from './TimeSeriesChart';
import { DEFAULT_FIT, fitSeries } from '../map/fitSettings';
import { newDone, runPageTool } from '../assistant/pageTools';
import { getChart } from '../assistant/chartView';

const saved = vi.hoisted(() => ({ files: [] as Blob[] }));
vi.mock('../utils/saveFile', () => ({ saveFile: async (data: Blob) => { saved.files.push(data); return true; } }));

const LABELS = ['2026-01-13', '2026-02-13', '2026-03-13'];
const VALID = LABELS;
const layer = (x_values: string[]) => ({
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: null, x_values, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
}) as unknown as RasterGroup;

let stateRef: AppState;
let dispatchRef: (a: AppAction) => void;
function App({ onMap }: { onMap: string }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  dispatchRef = dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer(LABELS), velocity: layer([]) } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: onMap });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'TOGGLE_TRENDS' });
    dispatch({ type: 'TOGGLE_RESIDUALS' });
    dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.1, 0.2], name: 'Point 1' } });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}

beforeEach(() => {
  drawn.data = null;
  saved.files = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/multi_point')) return new Response('{}');
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({
      labels: ['2026-01-01', ...LABELS],
      display_datum: { date: '2026-01-01', value: 0, independent_observation: false },
      datasets: body.points.map((p: { id: string; name: string; color: string }) => ({
        label: p.name, pointId: p.id, borderColor: p.color, backgroundColor: p.color,
        data: [{ x: '2026-01-01', y: 0 }, ...VALID.map((x, i) => ({ x, y: i + 2 }))],
      })),
    }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('explicit display datum', () => {
  it('draws a separate datum without adding an observation to the fitted series', async () => {
    render(<AppProvider><App onMap="displacement" /></AppProvider>);
    await waitFor(() => expect(drawn.data?.datasets.find(d => d.label === 'Point 1')?.data).toHaveLength(3));
    const snapshot = getChart(stateRef.chartWindows[0].id)?.snapshot();
    const result = Object.values(snapshot!.fits)[0];
    expect(result.points).toHaveLength(3);
    expect(result.fit!.rate).toBe(fitSeries(VALID.map((x, i) => ({ x, y: i + 2 })), DEFAULT_FIT)!.rate);
    expect(drawn.data?.datasets.find(d => d.label === 'Point 1 residual')?.data).toHaveLength(3);
    expect(drawn.data?.datasets.find(d => d.label === 'Point 1 reference datum')?.data).toEqual([{ x: '2026-01-01', y: 0 }]);
    const extracted = await runPageTool('get_chart_data', {}, { getState: () => stateRef,
      dispatch: dispatchRef, api: {} as never, done: newDone() });
    expect(extracted).toMatchObject({ series: [{ n: 3, values: [2, 3, 4] }] });
    expect(getChart(stateRef.chartWindows[0].id)!.exportCsv()).toBe(true);
    const csv = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(saved.files[0]);
    });
    expect(csv.split('\n').filter(line => /^2026-/.test(line)).map(line => line.split(',')[0])).toEqual(LABELS);
  });

  it('does not keep an obsolete zero annotation after choosing a different temporal reference', async () => {
    render(<AppProvider><App onMap="displacement" /></AppProvider>);
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label.endsWith('reference datum'))).toBe(true));
    act(() => dispatchRef({ type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } }));
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label.endsWith('reference datum'))).toBe(false));
    expect(drawn.data?.datasets.find(d => d.label === 'Point 1')?.data.map(p => p.y)).toEqual([-1, 0, 1]);
    expect(Object.values(getChart(stateRef.chartWindows[0].id)!.snapshot()!.fits)[0].points).toHaveLength(3);
  });
});
