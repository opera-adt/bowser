/** The chart's "Display options" fold: folded by default, opens and closes, remembered, and says when a custom setting applies. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, RasterGroup } from '../types';
import { CHART_DISPLAY_KEY } from '../utils/chartDisplayPref';

const drawn = vi.hoisted(() => ({ options: null as any, data: null as any }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: { options: unknown; data: unknown }, _ref) => { drawn.options = props.options; drawn.data = props.data; return null; }) };
});

import TimeSeriesChart from './TimeSeriesChart';

const LABELS = ['2020-01-01', '2020-02-01', '2020-03-01'];
const RESULT = {
  labels: LABELS, units: 'meters',
  statistics: LABELS.map((_, i) => ({ count: 4, mean: i / 100, median: i / 100, spatial_std: 0.001, minimum: 0, maximum: 0.1, percentiles: { 10: 0, 90: 0.03 } })),
};
const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values: LABELS, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
} as unknown as RasterGroup;
const SQUARE = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

function App({ setup }: { setup: AppAction[] }) {
  const { state, dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field' } });
    setup.forEach(dispatch);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}
const renderChart = async (setup: AppAction[] = []) => {
  render(<AppProvider><App setup={setup} /></AppProvider>);
  return screen.findByRole('button', { name: /Display options/ });
};

beforeEach(() => {
  localStorage.removeItem(CHART_DISPLAY_KEY);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/polygon_timeseries')
    ? new Response(JSON.stringify(RESULT)) : new Response('{}'))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.removeItem(CHART_DISPLAY_KEY); });

describe('chart display options', () => {
  it('are folded by default, with the layer chips still shown', async () => {
    const fold = await renderChart();
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Marker')).toBeNull();
    expect(screen.queryByText('y0 min')).toBeNull();
    expect(screen.getByText('displacement')).toBeTruthy();  // row 2 stays
    expect(fold.textContent).not.toContain('(custom)');
  });

  it('open and close, and the choice is remembered', async () => {
    let fold = await renderChart();
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Marker')).toBeTruthy();
    expect(screen.getByText('y0 min')).toBeTruthy();
    expect(localStorage.getItem(CHART_DISPLAY_KEY)).toBe('open');
    cleanup();
    fold = await renderChart();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(screen.queryByText('Marker')).toBeNull();
    expect(localStorage.getItem(CHART_DISPLAY_KEY)).toBeNull();
  });

  it('say "(custom)" when folded over a custom date range, which still applies', async () => {
    const fold = await renderChart([{ type: 'SET_DATE_RANGE_START', payload: '2020-02-01' }]);
    expect(fold.textContent).toContain('(custom)');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    const median = drawn.data.datasets.find((d: any) => d.label === 'Field median');
    expect(median.data.map((p: any) => p.x)).toEqual(['2020-02-01', '2020-03-01']);
  });

  it('say "(custom)" for y limits set before folding', async () => {
    const fold = await renderChart();
    fireEvent.click(fold);
    fireEvent.change(screen.getAllByPlaceholderText('auto')[0], { target: { value: '-5' } });
    await act(async () => { fireEvent.click(fold); });
    expect(fold.textContent).toContain('(custom)');
    expect(drawn.options.scales.y0.min).toBe(-5);
  });
});
