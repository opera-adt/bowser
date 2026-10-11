/**
 * MapLibre map wiring, with maplibre-gl faked (no WebGL in jsdom): app state ->
 * sources/layers/markers, and map events -> the same actions the Leaflet map dispatches.
 * What the actions *are* is pinned in src/map/*.test.ts; this checks the plumbing.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const { FakeMap, FakeMarker, FakePopup, dispatch, mockState } = vi.hoisted(() => {
  type Handler = (e: any) => void;
  class FakeMap {
    static last: FakeMap;
    sources = new Map<string, any>();
    layers: { id: string; paint?: any }[] = [];
    handlers = new Map<string, Handler[]>();
    fitted: unknown = null;
    static fail = false;
    constructor(public opts: any) {
      if (FakeMap.fail) throw new Error('Failed to initialize WebGL');
      FakeMap.last = this; setTimeout(() => this.fire('load', {}), 0);
    }
    on(ev: string, h: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]); return this; }
    off(ev: string, h: Handler) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter(x => x !== h)); return this; }
    fire(ev: string, e: any) { (this.handlers.get(ev) ?? []).forEach(h => h(e)); }
    addControl() { return this; }
    addSource(id: string, s: any) { this.sources.set(id, s); }
    removeSource(id: string) { this.sources.delete(id); }
    getSource(id: string) { return this.sources.get(id); }
    addLayer(l: any, before?: string) {
      const i = before ? this.layers.findIndex(x => x.id === before) : -1;
      if (i >= 0) this.layers.splice(i, 0, l); else this.layers.push(l);
    }
    removeLayer(id: string) { this.layers = this.layers.filter(l => l.id !== id); }
    getLayer(id: string) { return this.layers.find(l => l.id === id); }
    getStyle() { return { layers: this.layers }; }
    setPaintProperty(id: string, k: string, v: unknown) { const l = this.getLayer(id); if (l) l.paint = { ...l.paint, [k]: v }; }
    isSourceLoaded() { return true; }
    fitBounds(b: unknown) { this.fitted = b; }
    getContainer() { return { clientWidth: 800 }; }
      terrain: unknown = null;
      pitch = 0;
      eased: any[] = [];
      repaints = 0;
      setTerrain(t: unknown) { this.terrain = t; }
      triggerRepaint() { this.repaints += 1; }
      getPitch() { return this.pitch; }
      easeTo(o: any) { this.eased.push(o); if (o.pitch !== undefined) this.pitch = o.pitch; }
      getBounds() { return { getSouth: () => 33.9512345678, getWest: () => -117.69, getNorth: () => 33.97, getEast: () => -117.65 }; }
    remove() {}
  }

  class FakeMarker {
    static all: FakeMarker[] = [];
    lngLat: [number, number] = [0, 0];
    handlers = new Map<string, Handler>();
    removed = false;
    constructor(public opts: { element: HTMLElement; draggable?: boolean }) { FakeMarker.all.push(this); }
    setLngLat(ll: [number, number]) { this.lngLat = ll; return this; }
    getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
    addTo() { return this; }
    on(ev: string, h: Handler) { this.handlers.set(ev, h); return this; }
    remove() { this.removed = true; }
  }

  class FakePopup { setLngLat() { return this; } setText() { return this; } addTo() { return this; } }
  return { FakeMap, FakeMarker, FakePopup, dispatch: vi.fn(), mockState: {} as Record<string, any> };
});

vi.mock('maplibre-gl', () => ({
  Map: FakeMap, Marker: FakeMarker, Popup: FakePopup, ScaleControl: class {}, NavigationControl: class {},
}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch }) }));

import MapLibreMap from './MapLibreMap';

const info = {
  name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', latlon_bounds: [-117.68, 33.95, -117.66, 33.97],
  x_values: ['2026-01-01', '2026-01-13'], available_mask_vars: [], unit: 'm',
};

let tile = 0;
beforeEach(() => {
  vi.useFakeTimers();
  dispatch.mockReset();
  FakeMarker.all = [];
  tile = 0;
  Object.assign(mockState, {
    currentDataset: 'displacement', datasetInfo: { displacement: info }, dataMode: 'md', colormap: 'rdbu_r',
    vmin: -0.01, vmax: 0.01, currentTimeIndex: 1, refValues: {}, refMarkerPosition: [33.96, -117.67],
    refEnabled: false, layerMasks: [], customMaskPath: null, wrapEnabled: false, wrapWavelength: null,
    wrapPeriod: 0.0277, complexMode: 'phase', opacity: 0.8, selectedBasemap: 'esriSatellite',
    secondaryBasemap: null, basemapSwapped: false, basemapOpacity: 1, secondaryBasemapOpacity: 0.5,
    timeSeriesPoints: [], selectedPointId: null, refMarkerVisible: true, annotationMode: false,
    pointPickingEnabled: true, showChart: false, pixelInspectEnabled: false, splitScreen: false,
    splitDataset: null, splitPosition: 0.5, splitTimeIndex: 0, refBufferEnabled: false, refBufferRadius: 0,
    viewBounds: null, viewBoundsApplySeq: 0, showColorbar: false, showLosIndicator: false, graticuleMode: 'off',
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/md/')) return new Response(JSON.stringify({ tiles: [`http://h/t/{z}/{x}/{y}.png?v=${++tile}`] }));
    return new Response(JSON.stringify([0, 0.001]));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

async function mount() {
  const view = render(<MapLibreMap />);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  return { view, map: FakeMap.last };
}

describe('MapLibreMap without WebGL', () => {
  it('shows a message instead of crashing the app', () => {
    FakeMap.fail = true;
    try {
      const view = render(<MapLibreMap />);
      expect(view.getByRole('alert').textContent).toContain('needs WebGL');
    } finally {
      FakeMap.fail = false;
    }
  });
});

describe('MapLibreMap', () => {
  it('draws the basemap, fits the data and adds the raster layer on top', async () => {
    const { map } = await mount();
    expect(map.sources.get('basemap-bottom').tiles[0]).toContain('World_Imagery');
    expect(map.fitted).toEqual([[-117.68, 33.95], [-117.66, 33.97]]);
    expect(map.sources.get('data-1').tiles).toEqual(['http://h/t/{z}/{x}/{y}.png?v=1']);
    expect(map.layers.map(l => l.id)).toEqual(['basemap-bottom', 'data-1']);
    expect(map.getLayer('data-1')!.paint['raster-opacity']).toBe(0.8);
  });

  it('keeps the old raster until the new one has loaded, then drops it', async () => {
    const { view, map } = await mount();
    mockState.currentTimeIndex = 0;
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(map.layers.map(l => l.id)).toEqual(['basemap-bottom', 'data-1', 'data-2']);
    act(() => map.fire('sourcedata', { sourceId: 'data-2' }));
    expect(map.layers.map(l => l.id)).toEqual(['basemap-bottom', 'data-2']);
    expect(map.sources.has('data-1')).toBe(false);
  });

  it('a map click picks a point and opens the chart', async () => {
    const { map } = await mount();
    act(() => map.fire('click', { lngLat: { lat: 33.958, lng: -117.674 }, point: { x: 1, y: 1 } }));
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual(['ADD_TIME_SERIES_POINT', 'TOGGLE_CHART']);
    expect(dispatch.mock.calls[0][0].payload.position).toEqual([33.958, -117.674]);
  });

  it('time-series markers: placed at lng/lat, drag moves, double-click removes, click selects', async () => {
    mockState.timeSeriesPoints = [{ id: 'p1', name: 'dam', position: [33.958, -117.674], color: '#f00', visible: true },
      { id: 'p2', name: 'off', position: [33.95, -117.67], color: '#00f', visible: false }];
    await mount();
    const pointMarkers = FakeMarker.all.filter(m => m.opts.element.className === 'custom-colored-marker' && !m.removed);
    expect(pointMarkers).toHaveLength(1);
    const m = pointMarkers[0];
    expect(m.lngLat).toEqual([-117.674, 33.958]);
    m.lngLat = [-117.6, 33.9];
    act(() => m.handlers.get('dragend')!({}));
    m.opts.element.dispatchEvent(new MouseEvent('dblclick'));
    m.opts.element.dispatchEvent(new MouseEvent('click'));
    expect(dispatch.mock.calls.map(c => c[0])).toEqual([
      { type: 'UPDATE_TIME_SERIES_POINT', payload: { id: 'p1', updates: { position: [33.9, -117.6] } } },
      { type: 'REMOVE_TIME_SERIES_POINT', payload: 'p1' },
      { type: 'SET_SELECTED_POINT', payload: 'p1' },
    ]);
  });

  it('dragging the reference marker moves it and reloads the reference series', async () => {
    await mount();
    const ref = FakeMarker.all.find(m => m.opts.element.title === 'Reference Location' && !m.removed)!;
    expect(ref.lngLat).toEqual([-117.67, 33.96]);
    ref.lngLat = [-117.675, 33.955];
    await act(async () => { ref.handlers.get('dragend')!({}); await vi.advanceTimersByTimeAsync(10); });
    expect(dispatch.mock.calls.map(c => c[0])).toEqual([
      { type: 'SET_REF_MARKER_POSITION', payload: [33.955, -117.675] },
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 0.001] } },
    ]);
  });

  it('shows the shared toolbars with the not-yet-ported tools disabled', async () => {
    const { view } = await mount();
    const off = [...view.container.querySelectorAll('[data-unsupported]')].map(e => e.getAttribute('data-unsupported'));
    expect(off.sort()).toEqual(['annotation', 'graticule', 'measure', 'profile', 'split']);
    expect(view.getByTitle('Toggle spatial re-referencing')).toBeTruthy();
    expect(view.getByTitle('3D terrain')).toBeTruthy();
  });

  it('3D terrain: on tilts the camera, the slider sets exaggeration, off flattens; the choice is remembered', async () => {
    const { view, map } = await mount();
    expect(map.terrain).toBeNull();
    fireEvent.click(view.getByTitle('3D terrain'));
    await act(async () => { fireEvent.click(view.getByRole('checkbox')); });
    expect(map.sources.get('terrain-dem').type).toBe('raster-dem');
    expect(map.terrain).toEqual({ source: 'terrain-dem', exaggeration: 2 });
    expect(map.eased[map.eased.length - 1]).toEqual({ pitch: 60 });
    const before = map.repaints;
    await act(async () => { fireEvent.change(view.getByLabelText('Terrain exaggeration'), { target: { value: '4.5' } }); });
    expect(map.terrain).toEqual({ source: 'terrain-dem', exaggeration: 4.5 });
    // a new exaggeration must redraw now, not on the next pan
    expect(map.repaints).toBeGreaterThan(before);
    expect(JSON.parse(localStorage.getItem('bowser.maplibre.terrain')!)).toEqual({ enabled: true, exaggeration: 4.5 });
    await act(async () => { fireEvent.click(view.getByRole('checkbox')); });
    expect(map.terrain).toBeNull();
    expect(map.eased[map.eased.length - 1]).toEqual({ pitch: 0, bearing: 0 });
  });

  it('view sync: "fit to dataset" moves the camera, panning reports the bounds', async () => {
    const { view, map } = await mount();
    mockState.viewBounds = [33.9, -117.7, 34.0, -117.6];
    mockState.viewBoundsApplySeq = 1;
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(map.fitted).toEqual([[-117.7, 33.9], [-117.6, 34.0]]);
    dispatch.mockReset();
    act(() => map.fire('moveend', {}));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_VIEW_BOUNDS', payload: [33.951235, -117.69, 33.97, -117.65] });
  });
});
