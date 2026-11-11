/**
 * Renaming a point (Points panel) renames its series in the chart legend and the CSV export,
 * without fetching the series again: the label is the point's name, not the one the server
 * echoed when the series was fetched.
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ data: null as null | { datasets: { label: string }[] } }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: { data: typeof drawn.data }, _ref) => { drawn.data = props.data; return null; }) };
});
const saved = vi.hoisted(() => ({ files: [] as { data: Blob | string; name: string }[] }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (data: Blob | string, name: string) => { saved.files.push({ data, name }); return true; },
}));

import TimeSeriesChart from './TimeSeriesChart';

const LABELS = ['2020-01-01', '2020-02-01', '2020-03-01'];
const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values: LABELS, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
} as unknown as RasterGroup;

let multiPoint: number;
let dispatchRef: (a: AppAction) => void = () => {};
let stateRef: AppState;

function App() {
  const { state, dispatch } = useAppContext();
  dispatchRef = dispatch;
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
  multiPoint = 0;
  saved.files = [];
  drawn.data = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/multi_point')) {
      multiPoint++;
      // The server labels each series with the name the point had when it was asked.
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        labels: LABELS,
        datasets: body.points.map((p: { id: string; name: string; color: string }) => ({
          label: p.name, pointId: p.id, borderColor: p.color, backgroundColor: p.color,
          data: LABELS.map((x, i) => ({ x, y: i / 100 })),
        })),
      }));
    }
    return new Response('{}');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const labels = () => drawn.data?.datasets.map(d => d.label) ?? [];

describe('renaming a point', () => {
  it('renames its series in the chart and the CSV, without fetching it again', async () => {
    render(<AppProvider><App /></AppProvider>);
    await waitFor(() => expect(labels()).toContain('Point 1'));
    const fetched = multiPoint;

    const id = stateRef.timeSeriesPoints[0].id;
    await act(async () => { dispatchRef({ type: 'UPDATE_TIME_SERIES_POINT', payload: { id, updates: { name: 'Dam crest' } } }); });
    await waitFor(() => expect(labels()).toContain('Dam crest'));
    expect(labels()).not.toContain('Point 1');
    expect(multiPoint).toBe(fetched);

    await act(async () => { fireEvent.click(screen.getByTitle('Export CSV')); });
    await waitFor(() => expect(saved.files.length).toBe(1));
    const csv = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved.files[0].data as Blob);
    });
    expect(csv).toContain('# Dam crest,');
    expect(csv).toContain('Time,Dam crest');
    expect(csv).not.toContain('Point 1');
  });
});
