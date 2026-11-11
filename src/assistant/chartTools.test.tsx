/**
 * The chart tools on the real chart (TimeSeriesChart in the app's state, Chart.js mocked to keep
 * what it is asked to draw): each tool sets the same state as the chart's own control (the Model
 * card, the Style button, Display options, the layer chips, the Points panel), get_chart_data
 * returns exactly what the chart draws (reference date and masks applied), set_fit and add_step
 * change the drawn model, and check_series flags a step.
 */
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';

const drawn = vi.hoisted(() => ({ options: null as any, data: null as any }));
vi.mock('react-chartjs-2', () => ({
  Line: forwardRef((props: { options: unknown; data: unknown }, ref) => {
    useImperativeHandle(ref, () => ({ canvas: Object.assign(document.createElement('canvas'), { toDataURL: () => 'data:image/png;base64,AAAA' }), resetZoom: () => {}, scales: {} }));
    drawn.options = props.options;
    drawn.data = props.data;
    return null;
  }),
}));
const saved = vi.hoisted(() => ({ files: [] as { data: unknown; name: string }[] }));
vi.mock('../utils/saveFile', () => ({
  saveFile: async (data: unknown, name: string) => { saved.files.push({ data, name }); return true; },
  dataUrlToBlob: () => new Blob(),
}));

import TimeSeriesChart from '../components/TimeSeriesChart';
import PointManagerPanel from '../components/PointManagerPanel';
import { newDone, runPageTool, type PageContext } from './pageTools';

// 24 monthly dates; series A rises 12 mm/yr and steps up 10 mm at 2021-01-01.
const DATES = Array.from({ length: 24 }, (_, i) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`);
const STEP = '2021-01-01';
const YEARS = (i: number) => (Date.parse(DATES[i]) - Date.parse(DATES[0])) / (365.25 * 86_400_000);
const valueA = (i: number) => 0.012 * YEARS(i) + (i >= 12 ? 0.01 : 0);
const valueB = (i: number) => -0.0005 * i;

const layer = (extra: Partial<RasterGroup> = {}) => ({
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: DATES, latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
  ...extra,
}) as unknown as RasterGroup;
const LAYERS = { displacement: layer(), short_wavelength_displacement: layer({ name: 'short_wavelength_displacement' }) };

const requests: any[] = [];
const live = { state: null as AppState | null, dispatch: null as ((a: AppAction) => void) | null };

function App({ setup, panel }: { setup: AppAction[]; panel?: boolean }) {
  const { state, dispatch } = useAppContext();
  live.state = state;
  live.dispatch = dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: LAYERS });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'TOGGLE_CHART' });
    setup.forEach(dispatch);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null}
      {panel ? <PointManagerPanel /> : null}
    </>
  );
}

const A: AppAction = { type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.1, 0.1], name: 'A' } };
const B: AppAction = { type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.2, 0.2], name: 'B' } };

const ctx = (): PageContext => ({ getState: () => live.state!, dispatch: a => live.dispatch!(a), api: {} as never, done: newDone() });
const tool = (name: string, input: Record<string, unknown> = {}) => runPageTool(name, input, ctx()) as Promise<any>;
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); expect(ok()).toBe(true); };
const series = (label: string) => drawn.data?.datasets.find((d: any) => d.label === label);

async function open(setup: AppAction[] = [A], panel = false) {
  render(<AppProvider><App setup={setup} panel={panel} /></AppProvider>);
  await until(() => !!series('A'));
}

/** State without ids, which every render makes anew. */
const pointsOf = (s: AppState) => s.timeSeriesPoints.map(({ id: _id, ...p }) => p);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  requests.length = 0;
  saved.files.length = 0;
  drawn.data = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/multi_point')) {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      // A mask (any) hides the fifth date, as the server leaves out masked dates.
      const keep = (i: number) => !(body.layer_masks.length && i === 4);
      return new Response(JSON.stringify({
        labels: DATES,
        datasets: body.points.map((p: any) => ({
          label: p.name, pointId: p.id, borderColor: p.color, backgroundColor: p.color,
          data: DATES.flatMap((x, i) => (keep(i) ? [{ x, y: p.name === 'B' ? valueB(i) : valueA(i) }] : [])),
        })),
      }));
    }
    if (url.startsWith('/polygon_timeseries')) {
      return new Response(JSON.stringify({
        labels: DATES, units: 'meters',
        statistics: DATES.map((_, i) => ({ count: 4, mean: i / 1000, median: i / 1000, spatial_std: 0.001, minimum: 0, maximum: 0.1, percentiles: { 10: 0, 90: 0.03 } })),
      }));
    }
    return new Response('{}');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('get_chart_data', () => {
  it('returns exactly what the chart draws, with the reference date and masks applied', async () => {
    const mask = { id: 'm1', dataset: 'displacement', threshold: 0.5, mode: 'min' as const };
    await open([A, B, { type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } }, { type: 'ADD_LAYER_MASK', payload: mask }]);
    await until(() => series('A')?.data.length === 23);
    const out = await tool('get_chart_data');
    for (const name of ['A', 'B']) {
      const want = series(name).data as { x: string; y: number }[];
      const got = out.series.find((s: any) => s.name === name);
      expect(got.dates).toEqual(want.map(p => p.x));
      expect(got.values).toEqual(want.map(p => p.y));
      expect(got).toMatchObject({ kind: 'point', layer: 'displacement', unit: 'm', n: 23 });
    }
    // Relative to the reference date (2020-02-01): zero there, the masked date (2020-05-01) left out.
    const a = out.series.find((s: any) => s.name === 'A');
    expect(a.values[a.dates.indexOf('2020-02-01')]).toBe(0);
    expect(a.dates).not.toContain('2020-05-01');
    expect(requests[requests.length - 1].layer_masks).toEqual([{ dataset: 'displacement', threshold: 0.5, mode: 'min' }]);
    expect(out.reference[0]).toMatchObject({ layer: 'displacement', reference_date: '2020-02-01' });
    expect(out.masks).toEqual([{ layer: 'displacement', threshold: 0.5, mode: 'min' }]);
    expect(out.date_range).toMatchObject({ first: '2020-01-01', last: '2021-12-01' });
  });

  it('gives the model line as drawn when asked', async () => {
    await open([A, { type: 'TOGGLE_TRENDS' }]);
    await until(() => !!series('A trend'));
    const plain = await tool('get_chart_data');
    expect(plain.series[0].model).toBeUndefined();
    expect(plain.series[0].model_shown).toBe(true);
    const out = await tool('get_chart_data', { include_model: true });
    expect(out.series[0].model.values).toEqual(series('A trend').data.map((p: any) => p.y));
  });
});

describe('the model', () => {
  it('set_fit sets what the Model card sets, and turns the model on', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.change(await screen.findByLabelText('Polynomial order'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('annual'));
    fireEvent.change(screen.getByLabelText('Steps date'), { target: { value: STEP } });
    fireEvent.click(screen.getByTitle('Add the step date'));
    const byUi = { fit: live.state!.fitSettings, on: live.state!.showTrends };
    cleanup();
    await open();
    const out = await tool('set_fit', { polynomial_order: 1, annual: true, steps: [STEP] });
    expect({ fit: live.state!.fitSettings, on: live.state!.showTrends }).toEqual(byUi);
    expect(out.model.terms).toBe('linear + annual + 1 step(s)');
  });

  it('a step changes the drawn model; add_step returns its size with its error', async () => {
    await open([A, { type: 'TOGGLE_TRENDS' }]);
    await until(() => !!series('A trend'));
    const before = series('A trend').data;
    expect(before.some((p: any) => p.y === null)).toBe(false);  // one straight line
    const out = await tool('add_step', { date: STEP });
    const after = series('A trend').data;
    expect(after).not.toEqual(before);
    expect(after.some((p: any) => p.y === null)).toBe(true);  // broken at the step
    // 10 mm and 12 mm/yr (the data are in metres; fit results in mm).
    const size = out.step_size[0];
    expect(size).toMatchObject({ series: 'A', unit: 'mm' });
    expect(size.size.value).toBeCloseTo(10, 3);
    expect(size.size.sigma).toBeLessThan(0.01);
    expect(out.series[0].rate.value).toBeCloseTo(12, 2);
    expect(live.state!.fitSettings.steps).toEqual([STEP]);
    // The same numbers as get_fit_results, and remove_step undoes it.
    expect((await tool('get_fit_results')).series[0].steps).toEqual(out.series[0].steps);
    await tool('remove_step', { date: STEP });
    expect(live.state!.fitSettings.steps).toEqual([]);
  });

  it('refuses a date outside the series and notes one between acquisitions', async () => {
    await open([A, { type: 'TOGGLE_TRENDS' }]);
    await expect(tool('add_step', { date: '2019-06-01' })).rejects.toThrow('outside the series');
    await expect(tool('set_fit', { steps: ['2021-02-30'] })).rejects.toThrow('not a date');
    const out = await tool('add_step', { date: '2021-01-10' });
    expect(out.date_notes[0]).toContain('between the acquisitions 2021-01-01 and 2021-02-01');
    expect(out.date_notes[0]).toContain('nearest acquisition 2021-01-01');
  });

  it('get_fit_results gives the seasonal terms with errors; set_residuals shows the residuals', async () => {
    await open();
    await tool('set_fit', { polynomial_order: 1, annual: true, semiannual: true });
    const fit = (await tool('get_fit_results')).series[0];
    expect(fit.annual).toMatchObject({ amplitude: { value: expect.any(Number), sigma: expect.any(Number) }, peak_day_of_year: { sigma: expect.any(Number) } });
    expect(fit.semiannual.amplitude.sigma).toBeGreaterThanOrEqual(0);
    expect(fit.rms_residual).toBeGreaterThan(0);
    await tool('set_residuals', { on: true });
    await until(() => !!series('A residual'));
    expect(live.state!.showResiduals).toBe(true);
  });
});

describe('points and areas', () => {
  it('set_point_style sets what the Style button sets; the size is the marker size', async () => {
    await open([A, B]);
    fireEvent.click(screen.getByTitle(/Style the points and areas/));
    fireEvent.change(screen.getByLabelText('Colour of A'), { target: { value: '#e53935' } });
    fireEvent.change(screen.getByLabelText('Marker of A'), { target: { value: 'square' } });
    fireEvent.change(screen.getByLabelText('Line of A'), { target: { value: 'dashed' } });
    fireEvent.change(screen.getByLabelText('Marker size'), { target: { value: '6' } });
    const byUi = live.state!;
    const out = await tool('set_point_style', { point: 'B', color: 'red', marker: 'square', line: 'dashed', size: 6 });
    const s = live.state!;
    const [a, b] = pointsOf(s);
    expect({ ...b, name: 'A', position: a.position }).toEqual(pointsOf(byUi)[0]);
    expect(s.markerSize).toBe(byUi.markerSize);
    expect(out.point).toMatchObject({ color: '#e53935', marker: 'square', line: 'dashed' });
    await until(() => series('B')?.borderColor === '#e53935');
    expect(series('B').borderDash).toEqual([6, 4]);
    await expect(tool('set_point_style', { point: 'C' })).rejects.toThrow('No point "C"');
  });

  it('rename_point sets what the Points panel sets; list_points and remove_point', async () => {
    await open([A, B], true);
    fireEvent.click(screen.getByTitle('Manage Time Series Points'));
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'Dam crest' } });
    const [byUi] = pointsOf(live.state!);
    await tool('rename_point', { point: 'B', name: 'Dam crest' });
    expect({ ...pointsOf(live.state!)[1], position: byUi.position, color: byUi.color }).toEqual(byUi);
    // The chart and its CSV call the series by its new name (its data came under the old one).
    await until(() => !!series('Dam crest') && !series('A') && !series('B'));
    fireEvent.click(screen.getByTitle('Export CSV'));
    const csv = await new Promise<string>(done => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.readAsText(saved.files[0].data as Blob); });
    expect(csv).toContain('Time,Dam crest,Dam crest');
    expect(csv.split('\n').find(l => l.startsWith('2020-02-01'))).toBe(`2020-02-01,${valueA(1)},${valueB(1)}`);
    const list = await tool('list_points');
    expect(list.points.map((p: any) => p.name)).toEqual(['Dam crest', 'Dam crest']);
    expect(list.points[0]).toMatchObject({ lat: 0.1, lon: 0.1, marker: 'circle', line: 'solid', visible: true });
    await tool('remove_point', { point: list.points[1].id });
    expect(live.state!.timeSeriesPoints).toHaveLength(1);
  });

  it('set_area_style, rename_area and set_area_band set what the Style rows and the Band menu set', async () => {
    const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const areas: AppAction[] = [A, { type: 'ADD_CHART_AREA', payload: { geometry: square, name: 'Field' } }, { type: 'ADD_CHART_AREA', payload: { geometry: square, name: 'Other' } }];
    await open(areas);
    fireEvent.click(screen.getByTitle(/Style the points and areas/));
    fireEvent.change(screen.getByLabelText('Colour of Field'), { target: { value: '#1e88e5' } });
    fireEvent.change(screen.getByLabelText('Median line of Field'), { target: { value: 'dashed' } });
    fireEvent.change(screen.getByLabelText('Line width of Field'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('Mean of Field'));
    fireEvent.change(screen.getByLabelText('Band opacity of Field'), { target: { value: '0.4' } });
    fireEvent.change(screen.getByLabelText('Area band'), { target: { value: 'pct' } });
    const [field] = live.state!.chartAreas;
    await tool('set_area_style', { area: 'Other', color: 'blue', median_line: 'dashed', width: 3, show_mean: false, band_opacity: 0.4 });
    await tool('set_area_band', { band: 'std' });
    await tool('set_area_band', { band: 'p10p90' });
    await tool('rename_area', { area: 'Other', name: 'Field' });
    const other = live.state!.chartAreas[1];
    const { id: _a, ...want } = field;
    const { id: _b, ...got } = other;
    expect(got).toEqual(want);
    expect(live.state!.areaBand).toBe('pct');
    expect((await tool('list_areas')).areas[1]).toMatchObject({ name: 'Field', color: '#1e88e5', line: 'dashed', lineWidth: 3, showMean: false, bandOpacity: 0.4 });
  });
});

describe("the chart's view", () => {
  it('set_layer_display sets what Display options set (y limits, offset, colour)', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Display options/ }));
    fireEvent.change(screen.getAllByPlaceholderText('auto')[0], { target: { value: '-0.02' } });
    fireEvent.change(screen.getAllByPlaceholderText('auto')[1], { target: { value: '0.05' } });
    const byUi = drawn.options.scales.y0;
    cleanup();
    await open();
    const out = await tool('set_layer_display', { layer: 'displacement', ymin: -0.02, ymax: 0.05 });
    await until(() => drawn.options.scales.y0.min === -0.02);
    expect(drawn.options.scales.y0).toEqual(byUi);
    expect(out.display).toMatchObject({ ymin: -0.02, ymax: 0.05, offset: 0 });
    await tool('set_layer_display', { layer: 'displacement', color: '#43a047' });
    await until(() => series('A')?.borderColor === '#43a047');
    await expect(tool('set_layer_display', { layer: 'velocity', ymin: 0 })).rejects.toThrow('not in the chart');
  });

  it('set_date_range sets what From and To set; reset clears them', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Display options/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2020-06-01' } });
    const byUi = live.state!.dateRangeStart;
    await tool('set_date_range', { reset: true });
    expect(live.state!.dateRangeStart).toBeNull();
    await tool('set_date_range', { start: '2020-06-01' });
    expect(live.state!.dateRangeStart).toBe(byUi);
    await until(() => series('A')?.data[0].x === '2020-06-01');
    const data = await tool('get_chart_data');
    expect(data.series[0].dates[0]).toBe('2020-06-01');
    await expect(tool('set_date_range', { start: '2021-01-01', end: '2020-01-01' })).rejects.toThrow('before end');
  });

  it("set_chart_layers sets what the chart's layer chips set", async () => {
    await open();
    fireEvent.change(screen.getByDisplayValue('＋ layer…'), { target: { value: 'short_wavelength_displacement' } });
    const byUi = live.state!.chartWindows[0].dsNames;
    await tool('set_chart_layers', { layers: [] });
    expect(live.state!.chartWindows[0].dsNames).toEqual([]);
    // "＋ layer…" adds to the layer the chart follows (#144), so the chips show both.
    await tool('set_chart_layers', { layers: ['displacement', 'short_wavelength_displacement'] });
    expect(live.state!.chartWindows[0].dsNames).toEqual(byUi);
    await expect(tool('set_chart_layers', { layers: ['shortwavelength_displacement'] })).rejects.toThrow('did you mean short_wavelength_displacement');
  });

  it('export_chart saves what the Export CSV and Save as PNG buttons save', async () => {
    await open();
    fireEvent.click(screen.getByTitle('Export CSV'));
    const text = (b: unknown) => new Promise<string>(done => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.readAsText(b as Blob); });
    const byUi = await text(saved.files[0].data);
    await tool('export_chart', { format: 'csv' });
    expect(await text(saved.files[1].data)).toBe(byUi);
    expect(byUi).toContain('2021-01-01');
    expect(saved.files[1].name).toMatch(/^time-series-displacement-.*\.csv$/);
    await tool('export_chart', { format: 'png' });
    expect(saved.files[2]).toMatchObject({ data: 'data:image/png;base64,AAAA', name: expect.stringMatching(/^timeseries-displacement-\d+\.png$/) });
  });
});

describe('check_series', () => {
  it("flags the series' step at the date a model step goes, with its size", async () => {
    await open([A, B]);
    const out = await tool('check_series', { point: 'A', wavelength_m: 0.0555 });
    expect(out.series).toHaveLength(1);
    expect(out.series[0].steps).toEqual([expect.objectContaining({ before: '2020-12-01', after: STEP, step_date: STEP, possible_unwrapping: null })]);
    expect(out.series[0].steps[0].size_mm).toBeGreaterThan(10);
    expect(out.wavelength).toEqual({ m: 0.0555, half_mm: 27.75, source: 'given' });
    expect(out.note).toContain('ask the user before adding');
    const all = await tool('check_series');
    expect(all.series.map((s: any) => s.series)).toEqual(['A', 'B']);
    expect(all.wavelength.m).toBeNull();
  });
});
