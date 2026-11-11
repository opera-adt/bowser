/** "＋ layer…" in a chart that follows the map adds the layer next to the shown one; it does not replace it. */
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ options: null as any }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((props: { options: unknown }, _ref) => { drawn.options = props.options; return null; }) };
});

import TimeSeriesChart from './TimeSeriesChart';

const LABELS = ['2020-01-01', '2020-02-01', '2020-03-01'];
const RESULT = {
  labels: LABELS, units: 'meters',
  statistics: LABELS.map((_, i) => ({ count: 4, mean: i / 100, median: i / 100, spatial_std: 0.001, minimum: 0, maximum: 0.1, percentiles: { 10: 0, 90: 0.03 } })),
};
const layer = (name: string) => ({
  name, unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: null, x_values: LABELS, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
}) as unknown as RasterGroup;
const SQUARE = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

function App() {
  const { state, dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer('displacement'), short_wavelength_displacement: layer('short_wavelength_displacement') } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'TOGGLE_CHART' });
    dispatch({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field' } });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/polygon_timeseries')
    ? new Response(JSON.stringify(RESULT)) : new Response('{}'))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('adding a layer to a chart that follows the map', () => {
  it('keeps the shown layer and adds the new one on its own y axis', async () => {
    render(<AppProvider><App /></AppProvider>);
    const add = await screen.findByDisplayValue('＋ layer…');
    expect(screen.getByText('displacement')).toBeTruthy();

    fireEvent.change(add, { target: { value: 'short_wavelength_displacement' } });

    expect(screen.getByTitle('Remove displacement')).toBeTruthy();
    expect(screen.getByTitle('Remove short_wavelength_displacement')).toBeTruthy();
    await waitFor(() => expect(Object.keys(drawn.options.scales).filter(k => /^y\d$/.test(k))).toEqual(['y0', 'y1']));
  });
});
