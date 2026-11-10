/** The Stats tab: one row per area with its statistics, the whole-record view, sorting, row actions and the CSV. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../../types';
import type { PolygonTimeSeries } from '../../utils/polygonSeries';

const saved = vi.hoisted(() => ({ files: [] as { data: Blob | string; name: string }[] }));
vi.mock('../../utils/saveFile', () => ({
  saveFile: async (data: Blob | string, name: string) => { saved.files.push({ data, name }); return true; },
}));

import StatsTab from './StatsTab';

const LABELS = ['2020-01-01', '2021-01-01', '2022-01-01'];
const stat = (median: number, mean: number, std: number, p10: number, p90: number) =>
  ({ count: 9, mean, median, spatial_std: std, minimum: p10, maximum: p90, percentiles: { 10: p10, 90: p90 } });
// Dam: median rising 10 mm/yr. North: flat, wider.
const DAM: PolygonTimeSeries = { labels: LABELS, units: 'meters', polygon_pixels: 12, statistics: [
  stat(0, 0.001, 0.002, -0.002, 0.003), stat(0.010, 0.011, 0.002, 0.008, 0.013), stat(0.020, 0.021, 0.004, 0.016, 0.025),
] };
const NORTH: PolygonTimeSeries = { labels: LABELS, units: 'meters', polygon_pixels: 40, statistics: [
  stat(0.005, 0.005, 0.010, -0.008, 0.018), stat(0.005, 0.006, 0.010, -0.008, 0.018), stat(0.005, 0.004, 0.010, -0.008, 0.018),
] };
const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 34.7], [x + 0.01, 34.7], [x + 0.01, 34.72], [x, 34.7]]] });

const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: LABELS,
  latlon_bounds: [-90.2, 34.7, -90.0, 34.8], available_mask_vars: [],
} as unknown as RasterGroup;

let stateRef: AppState;
let dispatchRef: (a: AppAction) => void;
function Seed({ setup }: { setup: AppAction[] }) {
  const { state, dispatch } = useAppContext();
  stateRef = state; dispatchRef = dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'ADD_CHART_AREAS', payload: [
      { id: 'a1', name: 'Dam area', geometry: square(-90.12), source: { overlayId: 'v', layer: 'test_areas.geojson', index: 0 } },
      { id: 'a2', name: 'North shore', geometry: square(-90.10), source: { overlayId: 'v', layer: 'test_areas.geojson', index: 1 } },
    ] });
    dispatch({ type: 'SET_AREA_STATS', payload: { 'displacement::a1': { data: DAM }, 'displacement::a2': { data: NORTH } } });
    setup.forEach(dispatch);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.datasetInfo.displacement ? <StatsTab /> : null;
}
const renderTab = (setup: AppAction[] = []) => render(<AppProvider><Seed setup={setup} /></AppProvider>);
const noRef: AppAction[] = [{ type: 'TOGGLE_REF_ENABLED' }];

beforeEach(() => {
  saved.files = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = (name: string) => screen.getByRole('listitem', { name });
const value = (name: string, stat: string) =>
  within(row(name)).getByText(stat, { selector: 'dt' }).nextElementSibling!.textContent;

describe('Stats tab', () => {
  it('lists each area with its colour, source layer, pixels and statistics on the map date', () => {
    renderTab([...noRef, { type: 'SET_TIME_INDEX', payload: 1 }]);
    expect(screen.getAllByRole('listitem').map(r => r.getAttribute('aria-label'))).toEqual(['Dam area', 'North shore']);
    const swatch = row('Dam area').querySelector('.ov-swatch') as HTMLElement;
    expect(swatch.style.background).toBeTruthy();
    expect(within(row('Dam area')).getByText('test_areas.geojson · 12 px')).toBeTruthy();
    expect(value('Dam area', 'Median')).toBe('0.0100');
    expect(value('Dam area', 'Mean')).toBe('0.0110');
    expect(value('Dam area', 'Std')).toBe('0.00200');
    expect(value('Dam area', 'p10')).toBe('0.00800');
    expect(value('Dam area', 'p90')).toBe('0.0130');
    expect(Number(value('Dam area', 'Trend'))).toBeCloseTo(10, 0);  // mm/yr
    expect(screen.getByText(/On 2021-01-01/)).toBeTruthy();
  });

  it('takes off the viewer reference on that date', () => {
    renderTab([{ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 0.004, 0.008] } }, { type: 'SET_TIME_INDEX', payload: 1 }]);
    expect(value('Dam area', 'Median')).toBe('0.00600');
    expect(value('Dam area', 'Std')).toBe('0.00200');  // the spread is not shifted
    expect(screen.getByText(/relative to the reference/)).toBeTruthy();
  });

  it('takes each statistic off its own value on a chosen reference date', () => {
    renderTab([...noRef, { type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } }, { type: 'SET_TIME_INDEX', payload: 2 }]);
    expect(value('Dam area', 'Median')).toBe('0.0100');
    expect(value('Dam area', 'Mean')).toBe('0.0100');
    expect(value('Dam area', 'p90')).toBe('0.0120');
    expect(value('Dam area', 'Std')).toBe('0.00400');
    expect(screen.getByText(/relative to 2021-01-01/)).toBeTruthy();
  });

  it('averages over the record with Whole record', () => {
    renderTab(noRef);
    fireEvent.click(screen.getByRole('radio', { name: 'Whole record' }));
    expect(value('Dam area', 'Median')).toBe('0.0100');
    expect(value('Dam area', 'Std')).toBe('0.00267');
    expect(screen.getByText(/Average over all dates/)).toBeTruthy();
  });

  it('sorts by a statistic', () => {
    renderTab([...noRef, { type: 'SET_TIME_INDEX', payload: 0 }]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'median' } });
    expect(screen.getAllByRole('listitem').map(r => r.getAttribute('aria-label'))).toEqual(['North shore', 'Dam area']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'trend' } });
    expect(screen.getAllByRole('listitem').map(r => r.getAttribute('aria-label'))).toEqual(['Dam area', 'North shore']);
  });

  it('hides, zooms to and removes an area', () => {
    renderTab(noRef);
    fireEvent.click(within(row('Dam area')).getByTitle('Hide in the chart'));
    expect(stateRef.chartAreas[0].visible).toBe(false);
    fireEvent.click(within(row('Dam area')).getByTitle('Zoom to Dam area'));
    expect(stateRef.viewBounds).toEqual([34.7, -90.12, 34.72, -90.11]);
    fireEvent.click(within(row('North shore')).getByTitle('Remove North shore'));
    expect(stateRef.chartAreas.map(a => a.name)).toEqual(['Dam area']);
    expect(Object.keys(stateRef.areaStats)).toEqual(['displacement::a1']);
  });

  it('downloads the table as CSV in the shown units', async () => {
    renderTab([...noRef, { type: 'SET_TIME_INDEX', payload: 2 }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download CSV/ })); });
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0].name).toMatch(/^zonal-stats-displacement-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved.files[0].data as Blob);
    });
    const [head, dam, north] = text.trim().split('\n');
    expect(head).toBe('name,source,layer,date,pixels,mean_m,median_m,std_m,p10_m,p90_m,median_trend_mm_per_yr');
    expect(dam.split(',').slice(0, 10)).toEqual(['Dam area', 'test_areas.geojson', 'displacement', '2022-01-01', '12', '0.021', '0.02', '0.004', '0.016', '0.025']);
    expect(Number(dam.split(',')[10])).toBeCloseTo(10, 0);
    expect(north.startsWith('North shore,')).toBe(true);
  });

  it('shows the progress and a waiting row while answers come', () => {
    renderTab(noRef);
    act(() => dispatchRef({ type: 'SET_AREA_STATS', payload: { 'displacement::a2': { pending: true } } }));
    expect(screen.getByText(/1\/2 areas/)).toBeTruthy();
    expect(within(row('North shore')).getByText('Working…')).toBeTruthy();
  });

  it('says how to add areas when there are none', () => {
    renderTab([{ type: 'REMOVE_CHART_AREA', payload: 'a1' }, { type: 'REMOVE_CHART_AREA', payload: 'a2' }]);
    expect(screen.getByText(/No areas yet/)).toBeTruthy();
  });
});
