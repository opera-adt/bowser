/**
 * Areas in the time-series chart (+ Area): the button, picking a polygon, the request,
 * the series drawn (median, dashed mean, p10–p90 band), the viewer's reference taken off,
 * the error line, and the button off on bowser-lite.
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, Overlay, RasterGroup } from '../types';
import { areaChartDatasets, polygonChoices, polygonErrorMessage, type PolygonTimeSeries } from '../utils/polygonSeries';
import { chartedFeatureColors, vectorLayerSpecs } from '../map/overlays';

// Chart.js can't draw in jsdom: keep what the chart would draw.
const drawn = vi.hoisted(() => ({ data: null as null | { labels: string[]; datasets: any[] }, options: null as any }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return {
    Line: forwardRef((props: { data: typeof drawn.data; options: unknown }, _ref) => {
      drawn.data = props.data; drawn.options = props.options; return null;
    }),
  };
});

import TimeSeriesChart from './TimeSeriesChart';
import ChartAreaButton, { AREA_NEEDS_SERVER } from './ChartAreaButton';

const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [[[-90.117, 34.752], [-90.111, 34.752], [-90.111, 34.758], [-90.117, 34.758], [-90.117, 34.752]]],
};
const RESULT: PolygonTimeSeries = {
  labels: ['2020-01-01', '2020-02-01', '2020-03-01'],
  units: 'meters',
  statistics: [
    { count: 9, mean: 0.0, median: 0.0, spatial_std: 0.001, minimum: -0.002, maximum: 0.002, percentiles: { 10: -0.001, 90: 0.001 } },
    { count: 9, mean: 0.011, median: 0.010, spatial_std: 0.002, minimum: 0.005, maximum: 0.02, percentiles: { 10: 0.008, 90: 0.014 } },
    { count: 9, mean: 0.021, median: 0.020, spatial_std: 0.003, minimum: 0.01, maximum: 0.03, percentiles: { 10: 0.016, 90: 0.025 } },
  ],
};
const REF = [0.0, 0.004, 0.008];

let config: Record<string, unknown>;
let polygonReply: { status: number; body: unknown };
let requests: { url: string; body: any }[];

beforeEach(() => {
  config = { title: 'Bowser', geotiff_export: true, polygon_stats: true };
  polygonReply = { status: 200, body: RESULT };
  requests = [];
  drawn.data = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    if (url.startsWith('/config')) return new Response(JSON.stringify(config));
    if (url.startsWith('/polygon_timeseries')) return new Response(JSON.stringify(polygonReply.body), { status: polygonReply.status });
    if (url.startsWith('/point')) return new Response(JSON.stringify(REF));
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const layer = (name: string): RasterGroup => ({
  name, unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: RESULT.labels,
  latlon_bounds: [-90.2, 34.7, -90.0, 34.8], available_mask_vars: [],
} as unknown as RasterGroup);

const drawingsOverlay = (features: unknown[]): Overlay => ({
  id: 'drawings', name: 'Drawings', type: 'vector', visible: true, opacity: 1,
  data: { type: 'FeatureCollection', features },
});

/** The app with a displacement layer, the chart open, and whatever ``setup`` adds. */
let dispatchRef: (a: AppAction) => void = () => {};
let stateRef: AppState;
function Seed({ setup, children }: { setup: AppAction[]; children: React.ReactNode }) {
  const { state, dispatch } = useAppContext();
  dispatchRef = dispatch;
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer('displacement') } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    setup.forEach(dispatch);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.datasetInfo.displacement ? <>{children}</> : null;
}
const renderApp = (setup: AppAction[], ui: React.ReactNode) =>
  render(<AppProvider><Seed setup={setup}>{ui}</Seed></AppProvider>);

describe('+ Area button', () => {
  it('starts drawing a polygon on the map when there is none to pick', async () => {
    renderApp([], <ChartAreaButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an area' }));
    expect(stateRef.areaDrawing).toBe(true);
    expect(stateRef.drawingEnabled).toBe(true);
    expect(screen.queryByText('Add an area to the chart:')).toBeNull();
    // Pressing it again stops waiting and closes the tools it opened.
    fireEvent.click(screen.getByRole('button', { name: 'Add an area' }));
    expect(stateRef.areaDrawing).toBe(false);
    expect(stateRef.drawingEnabled).toBe(false);
  });

  it('leaves the Draw tools open when they were open before', () => {
    renderApp([{ type: 'SET_DRAWING_ENABLED', payload: true }], <ChartAreaButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an area' }));
    act(() => dispatchRef({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE } }));
    expect(stateRef.areaDrawing).toBe(false);
    expect(stateRef.drawingEnabled).toBe(true);
  });

  it('lists the polygons on the map and adds the one picked', () => {
    const line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
    const poly = { type: 'Feature', properties: { name: 'Dam crest' }, geometry: SQUARE };
    renderApp([{ type: 'SET_OVERLAYS', payload: [drawingsOverlay([line, poly])] }], <ChartAreaButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an area' }));
    expect(screen.getByText('Add an area to the chart:')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dam crest' }));
    expect(stateRef.chartAreas).toHaveLength(1);
    expect(stateRef.chartAreas[0]).toMatchObject({ name: 'Dam crest', geometry: SQUARE, visible: true });
    expect(stateRef.areaDrawing).toBe(false);
  });

  it('offers drawing a new area under the list', () => {
    renderApp([{ type: 'SET_OVERLAYS', payload: [drawingsOverlay([{ geometry: SQUARE }])] }], <ChartAreaButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an area' }));
    fireEvent.click(screen.getByRole('button', { name: /Draw a new area/ }));
    expect(stateRef.areaDrawing).toBe(true);
  });

  it('is off, with the reason, on bowser-lite', async () => {
    config = { title: 'Bowser', geotiff_export: false, polygon_stats: false };
    renderApp([], <ChartAreaButton />);
    const button = screen.getByRole('button', { name: 'Add an area' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.title).toBe(AREA_NEEDS_SERVER);
  });
});

describe('polygon choices', () => {
  it('names polygons by their property or the layer, and skips other shapes', () => {
    const file: Overlay = {
      id: 'v1', name: 'parcels.geojson', type: 'vector', visible: true, opacity: 1,
      data: { type: 'FeatureCollection', features: [
        { geometry: { type: 'Point', coordinates: [0, 0] } },
        { geometry: { type: 'MultiPolygon', coordinates: [SQUARE.coordinates] } },
        { geometry: SQUARE, properties: { NAME: 'Lot 7' } },
      ] },
    };
    const choices = polygonChoices([{ id: 'w', name: 'WMS', type: 'wms', visible: true, opacity: 1 }, file]);
    expect(choices.map(c => [c.key, c.name, c.geometry.type])).toEqual([
      ['v1:1', 'parcels.geojson 1', 'MultiPolygon'],
      ['v1:2', 'Lot 7', 'Polygon'],
    ]);
  });
});

describe('area series', () => {
  const base = {
    result: RESULT, name: 'Area 1', color: '#1f77b4', factor: 1, unit: 'm', yAxisID: 'y0',
    toX: (x: string) => x, inRange: () => true,
  };

  it('are the p10–p90 band, the median and the dashed mean, in one colour', () => {
    const ds = areaChartDatasets({ ...base, reference: null, band: 'pct' });
    expect(ds.map(d => d.label)).toEqual(['Area 1 p90', 'Area 1 p10', 'Area 1 median', 'Area 1 mean']);
    expect(ds.map(d => d._legend)).toEqual(['Area 1 p10–p90', undefined, 'Area 1 median', 'Area 1 mean']);
    expect(ds[0].fill).toBe('+1');  // the upper edge fills down to the lower one
    expect(ds[3].borderDash).toEqual([6, 4]);
    expect(new Set(ds.map(d => d.borderColor))).toEqual(new Set(['#1f77b4']));
    expect((ds[2].data as any[]).map(p => p.y)).toEqual([0.0, 0.010, 0.020]);
    expect((ds[0].data as any[]).map(p => p.y)).toEqual([0.001, 0.014, 0.025]);
    expect(ds[2]._note).toBeUndefined();
  });

  it('take off the reference per date and convert units', () => {
    const ds = areaChartDatasets({ ...base, reference: REF, factor: 1000 / 25.4, unit: 'in', band: 'pct' });
    const ys = (i: number) => (ds[i].data as any[]).map(p => +p.y.toFixed(6));
    const inch = (m: number) => +(m * 1000 / 25.4).toFixed(6);
    expect(ys(2)).toEqual([inch(0), inch(0.006), inch(0.012)]);       // median − ref
    expect(ys(3)).toEqual([inch(0), inch(0.007), inch(0.013)]);       // mean − ref
    expect(ys(1)).toEqual([inch(-0.001), inch(0.004), inch(0.008)]);  // p10 − ref
    expect(ds[2]._note).toBe('relative to the reference');
  });

  it('band the mean ± 1 std by default, the std not shifted by the reference', () => {
    const ds = areaChartDatasets({ ...base, reference: REF });
    expect(ds.map(d => d.label)).toEqual(['Area 1 +1 std', 'Area 1 −1 std', 'Area 1 median', 'Area 1 mean']);
    expect(ds.map(d => d._legend)).toEqual(['Area 1 mean ± 1 std', undefined, 'Area 1 median', 'Area 1 mean']);
    const ys = (i: number) => (ds[i].data as any[]).map(p => +p.y.toFixed(6));
    expect(ys(3)).toEqual([0, 0.007, 0.013]);           // mean − ref
    expect(ys(0)).toEqual([0.001, 0.009, 0.016]);       // + std
    expect(ys(1)).toEqual([-0.001, 0.005, 0.010]);      // − std
  });

  it('are zero on a chosen reference date: each line minus its own value there', () => {
    const pct = areaChartDatasets({ ...base, reference: REF, band: 'pct', refIndex: 1 });
    const ys = (d: Record<string, unknown>) => (d.data as any[]).map(p => +p.y.toFixed(6));
    // After the viewer reference: median [0, .006, .012], mean [0, .007, .013], p10 [-.001, .004, .008], p90 [.001, .010, .017].
    expect(ys(pct[2])).toEqual([-0.006, 0, 0.006]);
    expect(ys(pct[3])).toEqual([-0.007, 0, 0.006]);
    expect(ys(pct[1])).toEqual([-0.005, 0, 0.004]);
    expect(ys(pct[0])).toEqual([-0.009, 0, 0.007]);
    expect(pct[2]._note).toBe('relative to the reference');
    // The std band sits on the shifted mean, its width unchanged.
    const std = areaChartDatasets({ ...base, reference: null, refIndex: 0 });
    expect(ys(std[0])).toEqual([0.001, 0.013, 0.024]);
    // A reference date the answer doesn't have: nothing to draw, as for a point.
    expect(areaChartDatasets({ ...base, reference: null, refIndex: -1 }).every(d => (d.data as unknown[]).length === 0)).toBe(true);
  });

  it('leave out dates without pixels or reference, and outside the date range', () => {
    const result = { ...RESULT, statistics: [{ ...RESULT.statistics[0], count: 0, median: null, mean: null, percentiles: { 10: null, 90: null } }, ...RESULT.statistics.slice(1)] };
    const ds = areaChartDatasets({ ...base, result, reference: [0, NaN, 0], inRange: x => x !== '2020-03-01' });
    expect(ds[2].data).toEqual([]);
  });

  it('turn API errors into a short message', () => {
    expect(polygonErrorMessage(422, { detail: 'Polygon contains no native pixel centers' })).toBe('Polygon contains no native pixel centers');
    expect(polygonErrorMessage(422, { detail: [{ msg: 'Value error, Supply a GeoJSON Polygon or MultiPolygon geometry' }] }))
      .toBe('Supply a GeoJSON Polygon or MultiPolygon geometry');
    expect(polygonErrorMessage(501, { detail: 'x' })).toBe('needs the full Bowser server');
    expect(polygonErrorMessage(500, null)).toBe('request failed (HTTP 500)');
  });
});

describe('areas in the time-series chart', () => {
  const open: AppAction[] = [
    { type: 'TOGGLE_CHART' },
    { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: REF } },
    { type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field' } },
  ];
  function ChartOfFirstWindow() {
    const { state } = useAppContext();
    return state.chartWindows[0] ? <TimeSeriesChart windowId={state.chartWindows[0].id} /> : null;
  }

  it('requests the area for the chart layer and draws it relative to the reference', async () => {
    window.history.replaceState({}, '', '/?dataset=arkabutla');
    renderApp(open, <ChartOfFirstWindow />);
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field median')).toBe(true));
    window.history.replaceState({}, '', '/');
    const req = requests.find(r => r.url.startsWith('/polygon_timeseries'))!;
    expect(req.url).toBe('/polygon_timeseries?dataset=arkabutla');
    expect(req.body).toEqual({ variable: 'displacement', geometry: SQUARE, support: 'common', percentiles: [10, 90] });

    const byLabel = Object.fromEntries(drawn.data!.datasets.map(d => [d.label, d]));
    const ys = (label: string) => byLabel[label].data.map((p: any) => +p.y.toFixed(6));
    expect(ys('Field median')).toEqual([0, 0.006, 0.012]);
    expect(ys('Field mean')).toEqual([0, 0.007, 0.013]);
    expect(ys('Field +1 std')).toEqual([0.001, 0.009, 0.016]);
    // The legend shows median, mean and the band once each; the tooltip says what it is relative to.
    const legend = drawn.options.plugins.legend.labels.generateLabels({
      data: drawn.data, isDatasetVisible: () => true,
    });
    expect(legend.map((l: any) => l.text)).toEqual(['Field mean ± 1 std', 'Field median', 'Field mean']);
    expect(legend.map((l: any) => l.lineDash)).toEqual([undefined, undefined, [6, 4]]);
    expect(screen.queryByText(/masks not applied/)).toBeNull();
    const median = drawn.data!.datasets.indexOf(byLabel['Field median']);
    const tip = drawn.options.plugins.tooltip.callbacks.label({ chart: { data: drawn.data }, datasetIndex: median, parsed: { y: 0.006 } });
    expect(tip).toBe('Field median: 0.0060 m, relative to the reference');
    expect(screen.getByTitle('Remove Field')).toBeTruthy();
  });

  it('keeps a hidden area chip on show, dimmed, under Pure CSS (whose .hidden is display: none)', async () => {
    const pure = document.createElement('style');
    pure.textContent = '.hidden,[hidden]{display:none!important}';
    document.head.appendChild(pure);
    try {
      renderApp(open, <ChartOfFirstWindow />);
      await waitFor(() => expect(screen.getByTitle('Remove Field')).toBeTruthy());
      act(() => dispatchRef({ type: 'UPDATE_CHART_AREA', payload: { id: stateRef.chartAreas[0].id, updates: { visible: false } } }));
      const chip = screen.getByTitle('Remove Field').closest('.chart-area-chip') as HTMLElement;
      expect(chip.classList.contains('area-hidden')).toBe(true);
      expect(getComputedStyle(chip).display).not.toBe('none');
    } finally {
      pure.remove();
    }
  });

  it('switches the band to p10–p90 and remembers the choice', async () => {
    renderApp(open, <ChartOfFirstWindow />);
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field +1 std')).toBe(true));
    const select = screen.getByRole('combobox', { name: 'Area band' }) as HTMLSelectElement;
    expect(select.value).toBe('std');
    fireEvent.change(select, { target: { value: 'pct' } });
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field p90')).toBe(true));
    expect(drawn.data!.datasets.some(d => d.label === 'Field +1 std')).toBe(false);
    expect(localStorage.getItem('bowser-area-band')).toBe('pct');
    cleanup();
    renderApp(open, <ChartOfFirstWindow />);
    expect((screen.getByRole('combobox', { name: 'Area band' }) as HTMLSelectElement).value).toBe('pct');
    localStorage.removeItem('bowser-area-band');
  });

  it('draws areas relative to a chosen reference date, as points are', async () => {
    renderApp([...open, { type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } }], <ChartOfFirstWindow />);
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field median')).toBe(true));
    const byLabel = Object.fromEntries(drawn.data!.datasets.map(d => [d.label, d]));
    const ys = (label: string) => byLabel[label].data.map((p: any) => +p.y.toFixed(6));
    expect(ys('Field median')).toEqual([-0.006, 0, 0.006]);
    expect(ys('Field mean')).toEqual([-0.007, 0, 0.006]);
  });

  it('keeps one colour per area across chart layers, listed once in Style, and on the map', async () => {
    const areaLayer: Overlay = { id: 'v1', name: 'areas', type: 'vector', visible: true, opacity: 1, color: '#5bc0be',
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Field' }, geometry: SQUARE }] } };
    renderApp([
      { type: 'SET_DATASETS', payload: { displacement: layer('displacement'), phase_similarity: { ...layer('phase_similarity'), uses_spatial_ref: false, unit: '' } } },
      { type: 'SET_OVERLAYS', payload: [areaLayer] },
      { type: 'TOGGLE_CHART' },
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: REF } },
      { type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field', source: { overlayId: 'v1', layer: 'areas', index: 0 } } },
    ], <ChartOfFirstWindow />);
    act(() => dispatchRef({ type: 'SET_CHART_WINDOW_DS', payload: { id: stateRef.chartWindows[0].id, dsNames: ['displacement', 'phase_similarity'] } }));
    await waitFor(() => expect(drawn.data?.datasets.filter(d => d._area && (d.data as unknown[]).length > 0)).toHaveLength(8));
    fireEvent.click(screen.getByTitle(/Style the points and areas/));
    expect(screen.getAllByLabelText('Colour of Field')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Colour of Field'), { target: { value: '#00aa00' } });
    await waitFor(() => expect(drawn.data!.datasets.filter(d => d._area).every(d => d.borderColor === '#00aa00')).toBe(true));
    const areaSets = drawn.data!.datasets.filter(d => d._area);
    expect(areaSets.map(d => d.label)).toEqual([
      'Field [displacement] +1 std', 'Field [displacement] −1 std', 'Field [displacement] median', 'Field [displacement] mean',
      'Field [phase_similarity] +1 std', 'Field [phase_similarity] −1 std', 'Field [phase_similarity] median', 'Field [phase_similarity] mean',
    ]);
    expect(areaSets[0].backgroundColor).toBe('#00aa0033');
    expect(areaSets[4].backgroundColor).toBe('#00aa0033');
    // Layers differ by their y axis, not by colour.
    expect(new Set(areaSets.map(d => d.yAxisID))).toEqual(new Set(['y0', 'y1']));
    const fill = vectorLayerSpecs(areaLayer, chartedFeatureColors(areaLayer, stateRef.chartAreas))[0].paint['fill-color'];
    expect(fill).toEqual(['match', ['id'], 0, '#00aa00', '#5bc0be']);
    // A layer's colour (Display options) recolours that layer's series and y axis, so the two
    // layers tell apart; the other layer and the map keep the feature's colour.
    fireEvent.click(screen.getByRole('button', { name: /Display options/ }));
    fireEvent.change(screen.getAllByTitle("Colour of this layer's series and y axis")[1], { target: { value: '#ff00ff' } });
    await waitFor(() => expect(drawn.options.scales.y1.ticks.color).toBe('#ff00ff'));
    const recoloured = drawn.data!.datasets.filter(d => d._area);
    expect(recoloured.filter(d => d.yAxisID === 'y1').every(d => d.borderColor === '#ff00ff')).toBe(true);
    expect(recoloured.filter(d => d.yAxisID === 'y0').every(d => d.borderColor === '#00aa00')).toBe(true);
    expect(vectorLayerSpecs(areaLayer, chartedFeatureColors(areaLayer, stateRef.chartAreas))[0].paint['fill-color'])
      .toEqual(['match', ['id'], 0, '#00aa00', '#5bc0be']);
  });

  it('fetches the reference like the map for a chart layer that is not on the map', async () => {
    renderApp([
      { type: 'SET_DATASETS', payload: { displacement: layer('displacement'), other: layer('other') } },
      { type: 'SET_CURRENT_DATASET', payload: 'other' },
      { type: 'SET_REF_MARKER_POSITION', payload: [34.75, -90.1] },
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [9, 9, 9] } },  // stale: not the map's layer
      { type: 'TOGGLE_CHART' },
      { type: 'ADD_CHART_AREA', payload: { geometry: SQUARE, name: 'Field' } },
    ], <ChartOfFirstWindow />);
    act(() => dispatchRef({ type: 'SET_CHART_WINDOW_DS', payload: { id: stateRef.chartWindows[0].id, dsNames: ['displacement'] } }));
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field median')).toBe(true));
    const point = requests.find(r => r.url.startsWith('/point?dataset_name=displacement'));
    expect(point?.url).toContain('lat=34.75');
    const median = drawn.data!.datasets.find(d => d.label === 'Field median');
    expect(median.data.map((p: any) => +p.y.toFixed(6))).toEqual([0, 0.006, 0.012]);
  });

  it('says the areas ignore the masks the points use', async () => {
    renderApp([...open, { type: 'ADD_LAYER_MASK', payload: { id: 'm', dataset: 'displacement', threshold: 0.5, mode: 'min' } }],
      <ChartOfFirstWindow />);
    expect(await screen.findByText(/Areas: masks not applied/)).toBeTruthy();
  });

  it('shows stored values when the reference is off', async () => {
    renderApp([...open, { type: 'TOGGLE_REF_ENABLED' }], <ChartOfFirstWindow />);
    await waitFor(() => expect(drawn.data?.datasets.some(d => d.label === 'Field median')).toBe(true));
    const median = drawn.data!.datasets.find(d => d.label === 'Field median');
    expect(median.data.map((p: any) => p.y)).toEqual([0.0, 0.010, 0.020]);
    expect(median._note).toBeUndefined();
  });

  it('shows a short message when the server refuses the polygon, and removes the area', async () => {
    polygonReply = { status: 422, body: { detail: 'Polygon contains no native pixel centers' } };
    renderApp(open, <ChartOfFirstWindow />);
    expect((await screen.findByRole('alert')).textContent).toBe('Field: Polygon contains no native pixel centers');
    fireEvent.click(screen.getByTitle('Remove Field'));
    expect(stateRef.chartAreas).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds the polygon drawn after + Area', async () => {
    renderApp([{ type: 'TOGGLE_CHART' }, { type: 'SET_AREA_DRAWING', payload: true }], <ChartOfFirstWindow />);
    expect(screen.getByText(/Draw the area on the map/)).toBeTruthy();
    act(() => dispatchRef({ type: 'ADD_CHART_AREA', payload: { geometry: SQUARE } }));
    expect(stateRef.chartAreas.map(a => a.name)).toEqual(['Area 1']);
    expect(stateRef.areaDrawing).toBe(false);
  });
});
