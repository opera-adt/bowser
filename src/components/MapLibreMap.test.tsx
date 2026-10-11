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
    controls: [any, string][] = [];
    addControl(c: any, pos: string) { this.controls.push([c, pos]); return this; }
    addSource(id: string, s: any) {
      this.sources.set(id, s.type === 'geojson' ? { ...s, setData(d: unknown) { this.data = d; } } : s);
    }
    canvas = { style: {} as Record<string, string> };
    getCanvas() { return this.canvas; }
    project([lng, lat]: [number, number]) { return { x: lng * 1e5, y: -lat * 1e5 }; }
    removeSource(id: string) { this.sources.delete(id); }
    getSource(id: string) { return this.sources.get(id); }
    addLayer(l: any, before?: string) {
      const i = before ? this.layers.findIndex(x => x.id === before) : -1;
      if (i >= 0) this.layers.splice(i, 0, l); else this.layers.push(l);
    }
    removeLayer(id: string) { this.layers = this.layers.filter(l => l.id !== id); }
    getLayer(id: string) { return this.layers.find(l => l.id === id); }
    getStyle() { return { layers: this.layers, sources: Object.fromEntries(this.sources) }; }
    camera: any = null;
    jumpTo(o: any) { this.camera = o; }
    getCenter() { return { lng: -117.67, lat: 33.96 }; }
    getZoom() { return 12; }
    getBearing() { return 0; }
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

  class FakePopup {
    static html: string[] = [];
    setLngLat() { return this; } setText() { return this; } addTo() { return this; }
    setHTML(h: string) { FakePopup.html.push(h); return this; }
    static dom: HTMLElement[] = [];
    removed = false;
    remove() { this.removed = true; }
    setDOMContent(el: HTMLElement) { FakePopup.dom.push(el); return this; }
  }
  return { FakeMap, FakeMarker, FakePopup, dispatch: vi.fn(), mockState: {} as Record<string, any> };
});

vi.mock('maplibre-gl', () => ({
  Map: FakeMap, Marker: FakeMarker, Popup: FakePopup, ScaleControl: class { constructor(public opts: any) {} }, NavigationControl: class {},
  setWorkerUrl: (u: string) => { (globalThis as any).__maplibreWorkerUrl = u; },
}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/maplibre-worker.js' }));

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
    timeSeriesPoints: [], selectedPointId: null, refMarkerVisible: true, annotationMode: false, annotations: [],
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
    // limited to the data so MapLibre doesn't request (404) tiles beyond it
    expect(map.sources.get('data-1').bounds).toEqual([-117.68, 33.95, -117.66, 33.97]);
    // the worker URL comes from Vite, not MapLibre's own relative lookup
    expect((globalThis as any).__maplibreWorkerUrl).toBe('/assets/maplibre-worker.js');
    // basemap at the bottom, data above it, tool overlays (profile, measure) on top
    expect(map.layers.map(l => l.id)).toEqual([
      'basemap-bottom', 'data-1', 'profile-corridor', 'profile-preview', 'profile-line', 'profile-hover',
      'measure-line', 'measure-points',
    ]);
    expect(map.getLayer('data-1')!.paint['raster-opacity']).toBe(0.8);
  });

  it('keeps the old raster until the new one has loaded, then drops it', async () => {
    const { view, map } = await mount();
    mockState.currentTimeIndex = 0;
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const ids = () => map.layers.map(l => l.id).filter(id => !/^(profile|measure)-/.test(id));
    expect(ids()).toEqual(['basemap-bottom', 'data-1', 'data-2']);
    act(() => map.fire('sourcedata', { sourceId: 'data-2' }));
    expect(ids()).toEqual(['basemap-bottom', 'data-2']);
    expect(map.sources.has('data-1')).toBe(false);
  });

  it('changes made before the swap leave no layer behind (masked pixels must not show the old data)', async () => {
    const { view, map } = await mount();
    mockState.currentTimeIndex = 0;
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    mockState.layerMasks = [{ dataset: 'temporal_coherence', threshold: 0.9, mode: 'min' }];
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const ids = () => map.layers.map(l => l.id).filter(id => id.startsWith('data-'));
    expect(ids()).toEqual(['data-1', 'data-2', 'data-3']);
    expect(map.sources.get('data-3').tiles[0]).toBe('http://h/t/{z}/{x}/{y}.png?v=3');
    const maskRequest = (fetch as any).mock.calls.map((c: any[]) => c[0]).filter((u: string) => u.startsWith('/md/')).pop();
    expect(decodeURIComponent(maskRequest)).toContain('"dataset":"temporal_coherence"');
    act(() => map.fire('idle', {}));
    expect(ids()).toEqual(['data-3']);
    expect([...map.sources.keys()].filter(k => k.startsWith('data-'))).toEqual(['data-3']);
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
    expect(off).toEqual([]);
    expect(view.getByTitle(/Draw profile line/).hasAttribute('disabled')).toBe(false);
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

  it('measure: clicks add points with a running total instead of picking, double-click ends it', async () => {
    const { view, map } = await mount();
    await act(async () => { fireEvent.click(view.getByTitle(/Measure distance/)); });
    dispatch.mockReset();
    act(() => map.fire('click', { lngLat: { lat: 33.96289, lng: -117.67984 }, point: { x: 1, y: 1 } }));
    act(() => map.fire('click', { lngLat: { lat: 33.95429, lng: -117.66939 }, point: { x: 2, y: 2 } }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(map.sources.get('measure-tool').data.features).toHaveLength(3);   // 2 points + the path
    expect(FakePopup.html[FakePopup.html.length - 1]).toMatch(/^<b>1\.\d\d km<\/b>$/);
    await act(async () => { map.fire('dblclick', { preventDefault() {}, lngLat: { lat: 0, lng: 0 } }); });
    expect(map.sources.get('measure-tool').data.features).toHaveLength(0);
    act(() => map.fire('click', { lngLat: { lat: 33.958, lng: -117.674 }, point: { x: 1, y: 1 } }));
    expect(dispatch.mock.calls.map(c => c[0].type)).toContain('ADD_TIME_SERIES_POINT');   // picking is back
  });

  it('split screen: a passive right-hand map, clipped at the divider, follows the camera and mirrors the tools', async () => {
    const { view, map } = await mount();
    Object.assign(mockState, { splitScreen: true, splitDataset: 'displacement', splitColormap: 'viridis',
      splitVmin: 0, splitVmax: 1, splitOpacity: 0.6, splitTimeIndex: 0, splitPosition: 0.3 });
    view.rerender(<MapLibreMap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const right = FakeMap.last;
    expect(right).not.toBe(map);
    expect(right.opts.interactive).toBe(false);
    expect(view.getByTestId('maplibre-split').style.clipPath).toBe('inset(0 0 0 30.00%)');
    expect(view.container.querySelector('.map-container')!.classList.contains('split-active')).toBe(true);

    // its own basemap and the right-panel dataset (own colormap/time step), the tool overlays on top
    const rightData = right.layers.find(l => l.id.startsWith('data-'))!;
    expect(right.sources.get(rightData.id).tiles[0]).toMatch(/^http:\/\/h\/t\//);
    expect(right.sources.get(rightData.id).tiles[0]).not.toBe(map.sources.get(map.layers[1].id).tiles[0]);
    expect(rightData.paint['raster-opacity']).toBe(0.6);
    expect(right.layers.map(l => l.id)).toEqual([
      'basemap-bottom', rightData.id, 'profile-corridor', 'profile-preview', 'profile-line', 'profile-hover',
      'measure-line', 'measure-points',
    ]);
    const tileRequests = (fetch as any).mock.calls.map((c: any[]) => c[0]).filter((u: string) => u.startsWith('/md/'));
    expect(tileRequests.some((u: string) => u.includes('viridis'))).toBe(true);

    act(() => map.fire('move', {}));
    expect(right.camera).toEqual({ center: { lng: -117.67, lat: 33.96 }, zoom: 12, bearing: 0, pitch: 0 });

    await act(async () => { fireEvent.click(view.getByTitle(/Measure distance/)); });
    act(() => map.fire('click', { lngLat: { lat: 33.96289, lng: -117.67984 }, point: { x: 1, y: 1 } }));
    act(() => map.fire('data', { dataType: 'source', sourceId: 'measure-tool' }));
    expect(right.sources.get('measure-tool').data.features).toHaveLength(1);

    mockState.splitScreen = false;
    view.rerender(<MapLibreMap />);
    expect(view.queryByTestId('maplibre-split')).toBeNull();
  });

  it('graticule: drawn over the map in screen pixels, redrawn as the camera moves, gone when off', async () => {
    const { view, map } = await mount();
    expect(view.queryByTestId('maplibre-graticule')).toBeNull();
    // an 800 x 600 view of the current bounds
    map.getContainer = () => ({ clientWidth: 800, clientHeight: 600 });
    map.project = ([lng, lat]: [number, number]) => {
      const b = map.getBounds();
      return { x: (lng - b.getWest()) / (b.getEast() - b.getWest()) * 800, y: (b.getNorth() - lat) / (b.getNorth() - b.getSouth()) * 600 };
    };
    mockState.graticuleMode = 'plain';
    view.rerender(<MapLibreMap />);
    await act(async () => {});
    const svg = view.getByTestId('maplibre-graticule');
    const labels = () => [...svg.querySelectorAll('text')].map(t => t.textContent);
    expect(labels()).toContain('117.665°W');
    expect(labels()).toContain('33.960°N');
    const before = svg.innerHTML;
    map.getBounds = () => ({ getSouth: () => 34.1, getWest: () => -117.5, getNorth: () => 34.2, getEast: () => -117.4 });
    act(() => map.fire('move', {}));
    expect(svg.innerHTML).not.toBe(before);
    expect(labels().filter(l => l!.endsWith('N')).every(l => l!.startsWith('34.1'))).toBe(true);
    mockState.graticuleMode = 'zebra';
    view.rerender(<MapLibreMap />);
    await act(async () => {});
    expect(view.getByTestId('maplibre-graticule').querySelectorAll('rect').length).toBeGreaterThan(4);
    mockState.graticuleMode = 'off';
    view.rerender(<MapLibreMap />);
    expect(view.queryByTestId('maplibre-graticule')).toBeNull();
  });

  it('annotations: annotation-mode click opens the shared form, labels open the edit form', async () => {
    const { view, map } = await mount();
    mockState.annotationMode = true;
    mockState.annotations = [];
    view.rerender(<MapLibreMap />);
    dispatch.mockReset();
    act(() => map.fire('click', { lngLat: { lat: 33.958, lng: -117.674 }, point: { x: 1, y: 1 } }));
    const create = FakePopup.dom[FakePopup.dom.length - 1];
    (create.querySelector('input[type=text]') as HTMLInputElement).value = 'Spillway';
    [...create.querySelectorAll('button')].find(b => b.textContent === 'Add')!.click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'ADD_ANNOTATION',
      payload: { position: [33.958, -117.674], text: 'Spillway', fontSize: 13 } });

    mockState.annotations = [{ id: 'a1', position: [33.958, -117.674], text: 'Spillway', color: '#ffffff', fontSize: 13 }];
    view.rerender(<MapLibreMap />);
    await act(async () => {});
    const label = FakeMarker.all.filter(m => !m.removed).find(m => m.opts.element.className === 'bowser-annotation')!;
    expect(label.lngLat).toEqual([-117.674, 33.958]);
    expect(label.opts.element.textContent).toBe('Spillway');
    dispatch.mockReset();
    act(() => label.opts.element.click());
    const edit = FakePopup.dom[FakePopup.dom.length - 1];
    (edit.querySelector('button[title="Delete annotation"]') as HTMLButtonElement).click();
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_ANNOTATION', payload: 'a1' });
    // a click on the label is not a map click (no new annotation form, no picking)
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('bottom-left, as on Leaflet: metric and imperial scale over a readable cursor position', async () => {
    const { map } = await mount();
    const bl = map.controls.filter(([, pos]) => pos === 'bottom-left').map(([c]) => c);
    // bottom corners stack the last-added control on top: metric, imperial, then the cursor
    expect(bl.slice(1).map(c => c.opts.unit)).toEqual(['imperial', 'metric']);
    const cursor: HTMLElement = bl[0].onAdd();
    expect(cursor.className).toBe('maplibregl-ctrl leaflet-control-mouseposition');
    expect(cursor.getAttribute('style')).toBeNull();   // themed by style.css, not a fixed white box
    expect(cursor.textContent).toBe('Unavailable');
    act(() => map.fire('mousemove', { lngLat: { lat: 33.9581, lng: -117.674 }, point: { x: 1, y: 1 } }));
    expect(cursor.textContent).toBe('33.9581 : -117.674');
    act(() => map.fire('mouseout', {}));
    expect(cursor.textContent).toBe('Unavailable');
  });
});
