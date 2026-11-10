/**
 * The page tools that change the reference, masks, colours and split screen: each dispatches what
 * the panel's own control dispatches (checked against the control where it is a component), and
 * names are checked with close matches.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatch, mockState } = vi.hoisted(() => ({ dispatch: vi.fn(), mockState: {} as Record<string, any> }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch }) }));
vi.mock('react-chartjs-2', () => ({ Bar: () => null }));

import { closeMatches, newDone, PAGE_TOOL_NAMES, runPageTool, type PageContext } from './pageTools';
import { registerNavigator } from '../map/navigator';
import Histogram from '../components/Histogram';
import { MapTopRightToolbar } from '../components/MapToolbars';

vi.mock('../components/ProfileTool', () => ({ useProfileContext: () => ({ active: false, setActive: vi.fn() }) }));

const layer = (extra: Record<string, unknown> = {}) => ({
  name: 'x', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null, uses_spatial_ref: false, algorithm: null,
  latlon_bounds: [-90.2, 34.7, -89.9, 34.9], x_values: [0], available_mask_vars: [], unit: '', ...extra,
});

const HIST = { bins: [-0.02, 0, 0.02], counts: [5, 5], min: -0.05, max: 0.04, p2: -0.03, p98: 0.03, p16: -0.011, p84: 0.012, p23: -0.0251, p977: 0.0262 };

let api: { fetchPointTimeSeries: ReturnType<typeof vi.fn>; fetchBufferTimeSeries: ReturnType<typeof vi.fn> };
const ctx = (): PageContext => ({ getState: () => mockState as never, dispatch, api: api as never, done: newDone() });
const last = <T,>(a: T[]): T => a[a.length - 1];
const actions = () => dispatch.mock.calls.map(c => c[0]);

beforeEach(() => {
  dispatch.mockReset();
  api = {
    fetchPointTimeSeries: vi.fn(async () => [0, 1, 2]),
    fetchBufferTimeSeries: vi.fn(async () => ({ median: [{ x: '2020-01-01', y: 0 }, { x: '2020-02-01', y: 1 }], labels: [] })),
  };
  for (const k of Object.keys(mockState)) delete mockState[k];
  Object.assign(mockState, {
    currentDataset: 'displacement',
    datasetInfo: {
      displacement: layer({ uses_spatial_ref: true, algorithm: 'shift', unit: 'm', x_values: ['2020-01-01', '2020-02-01'], reference_lonlat: [-90.1, 34.8] }),
      temporal_coherence: layer(), phase_similarity: layer(), timeseries_inversion_residuals: layer(), recommended_mask: layer(),
    },
    refMarkerPosition: [34.75, -90.0], refEnabled: false, refBufferEnabled: false, refBufferRadius: 30, refTimeIndex: {},
    layerMasks: [{ id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }], customMaskPath: null,
    colormap: 'rdbu_r', vmin: -0.01, vmax: 0.02, opacity: 0.8, wrapEnabled: false, currentTimeIndex: 1,
    splitScreen: false, splitDataset: null, splitColormap: 'viridis', splitVmin: 0, splitVmax: 1, splitOpacity: 1,
    timeSeriesPoints: [], chartAreas: [], showChart: false, viewBounds: null, panelTab: 'main', datasetRanges: {},
    selectedBasemap: 'esriSatellite', secondaryBasemap: null, basemapSwapped: false, basemapOpacity: 1, secondaryBasemapOpacity: 0.5,
    showColorbar: false, showLosIndicator: false, graticuleMode: 'off', annotationMode: false, pixelInspectEnabled: false,
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/histogram/')) return new Response(JSON.stringify(HIST));
    if (url.startsWith('/dataset_range/')) return new Response(JSON.stringify({ min: 0, max: 1, p2: 0.1, p98: 0.95 }));
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the reference', () => {
  it('set_reference_point moves the marker, turns on the circle with its radius and re-references the chart', async () => {
    const out = await runPageTool('set_reference_point', { lon: -90.05, lat: 34.8, radius_m: 200 }, ctx()) as any;
    expect(actions()).toEqual([
      { type: 'TOGGLE_REF_BUFFER' },
      { type: 'SET_REF_BUFFER_RADIUS', payload: 200 },
      { type: 'TOGGLE_REF_ENABLED' },
      { type: 'SET_REF_MARKER_POSITION', payload: [34.8, -90.05] },
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 1] } },
    ]);
    // The reference series is the circle's median, as with "Sample around ref marker".
    expect(api.fetchBufferTimeSeries).toHaveBeenCalledWith(-90.05, 34.8, 'displacement', 200, 0);
    expect(out).toMatchObject({ reference_point: [-90.05, 34.8], sample_circle: { on: true, radius_m: 200 }, chart_rereferenced: true });
  });

  it('radius 0 turns the circle off; no radius keeps it', async () => {
    Object.assign(mockState, { refBufferEnabled: true, refEnabled: true });
    await runPageTool('set_reference_point', { lon: -90.05, lat: 34.8, radius_m: 0 }, ctx());
    expect(actions()[0]).toEqual({ type: 'TOGGLE_REF_BUFFER' });
    expect(api.fetchPointTimeSeries).toHaveBeenCalledWith(-90.05, 34.8, 'displacement');
    dispatch.mockReset();
    await runPageTool('set_reference_point', { lon: -90.05, lat: 34.8 }, ctx());
    expect(actions().map(a => a.type)).toEqual(['SET_REF_MARKER_POSITION', 'SET_REF_VALUES']);
  });

  it('get_reference and reset_reference', async () => {
    mockState.refTimeIndex = { displacement: 1 };
    expect(await runPageTool('get_reference', {}, ctx())).toMatchObject({
      reference_point: [-90, 34.75], rereferencing: false, sample_circle: { on: false, radius_m: 30 },
      cube_reference_point: [-90.1, 34.8], reference_date: '2020-02-01', reference_date_chosen: true,
    });
    const out = await runPageTool('reset_reference', {}, ctx()) as any;
    expect(actions()).toContainEqual({ type: 'SET_REF_MARKER_POSITION', payload: [34.8, -90.1] });
    expect(out.note).toContain("cube's own");
    delete mockState.datasetInfo.displacement.reference_lonlat;
    await expect(runPageTool('reset_reference', {}, ctx())).rejects.toThrow('names no reference point');
  });

  it('set_reference_date picks the nearest date', async () => {
    expect(await runPageTool('set_reference_date', { date: '2020-01-25' }, ctx())).toMatchObject({ reference_date: '2020-02-01', index: 1 });
    expect(actions()).toEqual([{ type: 'SET_REF_TIME_INDEX', payload: { dataset: 'displacement', index: 1 } }]);
  });
});

describe('masks', () => {
  it("set_masks replaces the panel's masks, min keeping >= and max keeping <= the threshold", async () => {
    const out = await runPageTool('set_masks', { masks: [
      { dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' },
      { dataset: 'phase_similarity', threshold: 0.6, mode: 'min' },
      { dataset: 'timeseries_inversion_residuals', threshold: 0, mode: 'max' },
    ] }, ctx()) as any;
    const a = actions();
    expect(a[0]).toEqual({ type: 'REMOVE_LAYER_MASK', payload: 'mask_recommended' });
    expect(a.slice(1).map(x => ({ ...x.payload, id: undefined }))).toEqual([
      { id: undefined, dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' },
      { id: undefined, dataset: 'phase_similarity', threshold: 0.6, mode: 'min' },
      { id: undefined, dataset: 'timeseries_inversion_residuals', threshold: 0, mode: 'max' },
    ]);
    expect(a.slice(1).every(x => x.type === 'ADD_LAYER_MASK')).toBe(true);
    expect(out.kept).toEqual(['temporal_coherence >= 0.7', 'phase_similarity >= 0.6', 'timeseries_inversion_residuals <= 0']);
  });

  it('a wrong layer name is refused with the close match; nothing changes', async () => {
    await expect(runPageTool('set_masks', { masks: [{ dataset: 'time_series_residual_inversion', threshold: 0, mode: 'max' }] }, ctx()))
      .rejects.toThrow('did you mean timeseries_inversion_residuals?');
    await expect(runPageTool('set_masks', { masks: [{ dataset: 'temporal_coherence', threshold: 0.5, mode: 'above' }] }, ctx()))
      .rejects.toThrow('mode is min');
    expect(dispatch).not.toHaveBeenCalled();
    expect(closeMatches('temporal coherence', ['temporal_coherence', 'displacement'])).toEqual(['temporal_coherence']);
  });

  it('added masks update a layer already masked; clear and recommended_mask', async () => {
    await runPageTool('set_masks', { masks: [{ dataset: 'recommended_mask', threshold: 0.9, mode: 'min' }], replace: false }, ctx());
    expect(actions()).toEqual([{ type: 'UPDATE_LAYER_MASK', payload: { id: 'mask_recommended', updates: { threshold: 0.9, mode: 'min' } } }]);
    dispatch.mockReset();
    await runPageTool('set_recommended_mask', { on: false }, ctx());
    expect(actions()).toEqual([{ type: 'REMOVE_LAYER_MASK', payload: 'mask_recommended' }]);
    dispatch.mockReset();
    mockState.layerMasks = [];
    await runPageTool('set_recommended_mask', { on: true }, ctx());
    expect(actions()).toEqual([{ type: 'ADD_LAYER_MASK', payload: { id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' } }]);
  });

  it('get_masks lists the masks and each layer with its range', async () => {
    const out = await runPageTool('get_masks', {}, ctx()) as any;
    expect(out.masks).toEqual([{ layer: 'recommended_mask', threshold: 0.5, mode: 'min' }]);
    expect(out.recommended_mask).toBe(true);
    expect(out.layers.find((l: any) => l.layer === 'temporal_coherence')).toMatchObject({ p2: 0.1, p98: 0.95 });
  });
});

describe('display', () => {
  it("set_color_range presets set what the histogram's buttons set", async () => {
    for (const [button, preset] of [['2–98%', '2-98%'], ['±1σ', '1sigma'], ['±2σ', '2sigma'], ['Full', 'full'], ['±0', 'symmetric']]) {
      dispatch.mockReset();
      const view = render(<Histogram />);
      await act(async () => { await new Promise(r => setTimeout(r, 300)); });
      fireEvent.click(view.getByText(button));
      const byButton = actions();
      cleanup();
      dispatch.mockReset();
      const out = await runPageTool('set_color_range', { preset }, ctx()) as any;
      expect(actions()).toEqual(byButton);
      expect([out.vmin, out.vmax]).toEqual([byButton[0].payload, byButton[1].payload]);
    }
  });

  it('explicit vmin/vmax, in mm for a layer in metres', async () => {
    const out = await runPageTool('set_color_range', { vmin: -20, vmax: 20, unit: 'mm' }, ctx()) as any;
    expect(actions()).toEqual([{ type: 'SET_VMIN', payload: -0.02 }, { type: 'SET_VMAX', payload: 0.02 }]);
    expect(out.unit).toBe('m');
    mockState.currentDataset = 'temporal_coherence';
    await expect(runPageTool('set_color_range', { vmin: 0, vmax: 1, unit: 'mm' }, ctx())).rejects.toThrow('not a length');
  });

  it('set_colormap checks the name, keeps or sets reversal, and the right side needs split screen', async () => {
    await runPageTool('set_colormap', { name: 'viridis' }, ctx());
    expect(last(actions())).toEqual({ type: 'SET_COLORMAP', payload: 'viridis_r' });   // rdbu_r was reversed
    await runPageTool('set_colormap', { name: 'viridis', reverse: false }, ctx());
    expect(last(actions())).toEqual({ type: 'SET_COLORMAP', payload: 'viridis' });
    await expect(runPageTool('set_colormap', { name: 'viridiss' }, ctx())).rejects.toThrow('did you mean viridis');
    await expect(runPageTool('set_colormap', { name: 'viridis', side: 'right' }, ctx())).rejects.toThrow('Split screen');
    Object.assign(mockState, { splitScreen: true, splitDataset: 'temporal_coherence' });
    await runPageTool('set_colormap', { name: 'magma', side: 'right' }, ctx());
    expect(last(actions())).toEqual({ type: 'SET_SPLIT_COLORMAP', payload: 'magma' });
    const d = await runPageTool('get_display', { side: 'right' }, ctx()) as any;
    expect(d).toMatchObject({ layer: 'temporal_coherence', colormap: 'viridis', vmin: 0, vmax: 1 });
    expect(d.colormaps).toContain('viridis');
  });

  it('set_split_screen sets both sides as the panel and the split button do', async () => {
    const bar = render(<MapTopRightToolbar onToggleToolbars={() => {}} />);
    fireEvent.click(bar.getByTitle('Split screen — compare two layers'));
    const byButton = actions();
    cleanup();
    dispatch.mockReset();
    await expect(runPageTool('set_split_screen', { on: true, left_layer: 'phase similarity' }, ctx())).rejects.toThrow('did you mean phase_similarity?');
    const out = await runPageTool('set_split_screen', { on: true, left_layer: 'phase_similarity', right_layer: 'temporal_coherence' }, ctx()) as any;
    expect(actions()).toEqual([
      { type: 'SET_CURRENT_DATASET', payload: 'phase_similarity' },   // the Layer menu
      { type: 'SET_SPLIT_DATASET', payload: 'temporal_coherence' },   // the Right layer menu
      ...byButton,                                                    // the split button
    ]);
    expect(out.on).toBe(false);   // the mocked state does not change; the real one does
  });

  it('set_terrain on the Leaflet map says it needs MapLibre', async () => {
    const off = registerNavigator({
      kind: 'leaflet', getView: () => ({ center: [0, 0], zoom: 3, bearing: 0, pitch: 0, bounds: [-1, -1, 1, 1], map: 'leaflet', width: 1, height: 1 }),
      flyTo: async () => {}, fitBounds: async () => {}, panBy: async () => {}, zoomTo: async () => {},
    });
    await expect(runPageTool('set_terrain', { on: true }, ctx())).rejects.toThrow('3D terrain needs the MapLibre map');
    off();
  });
});

it('every page tool the server defines has an implementation here', () => {
  // src/bowser/tools.py PAGE_COMMANDS plus add_overlay (the Assistant's alone).
  const server = ['get_view', 'fly_to', 'fit_bounds', 'pan', 'zoom', 'go_to', 'set_terrain', 'set_split_screen', 'add_point',
    'get_reference', 'set_reference_point', 'reset_reference', 'set_reference_date', 'switch_layer', 'open_chart', 'get_masks',
    'set_masks', 'clear_masks', 'set_recommended_mask', 'get_display', 'set_colormap', 'set_color_range', 'set_opacity',
    'list_commands', 'run_command', 'add_overlay',
    'list_context_layers', 'add_context_layer', 'remove_context_layer', 'highlight_infrastructure', 'clear_highlights',
    'get_areas', 'draw_highlight'];
  expect([...PAGE_TOOL_NAMES].sort()).toEqual(server.sort());
});
