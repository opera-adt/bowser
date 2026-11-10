/**
 * The Assistant's context tools on the page: add_context_layer / remove_context_layer dispatch
 * exactly what the Overlays › Services toggles dispatch, list_context_layers says which are on,
 * and the highlight layers (draw_highlight, highlight_infrastructure) are drawn and cleared.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatch, mockState } = vi.hoisted(() => ({ dispatch: vi.fn(), mockState: {} as Record<string, any> }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch }) }));
vi.mock('../hooks/useAddFiles', () => ({ ACCEPT: '', useAddFiles: () => vi.fn() }));
vi.mock('../map/soils', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../map/soils')),
  soilsInView: vi.fn(async () => ({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { class: 'peat' } }],
    notes: [],
  })),
}));

import OverlaysTab from '../components/panel/OverlaysTab';
import { newDone, runPageTool, type PageContext } from './pageTools';
import { HIGHLIGHT_PREFIX } from '../map/contextServices';

const ctx = (): PageContext => ({ getState: () => mockState as never, dispatch, api: {} as never, done: newDone() });
const actions = () => dispatch.mock.calls.map(c => c[0]);

const ZONES = {
  id: 'zone-abc123', kind: 'zones',
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'Z1', geometry: { type: 'Polygon', coordinates: [[[-90.1, 34.7], [-90.0, 34.7], [-90.0, 34.8], [-90.1, 34.7]]] }, properties: { zone: 'Z1' } }] },
};
const ROADS = {
  id: 'infr-xyz789', kind: 'infrastructure',
  features: { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90.1, 34.75], [-90.05, 34.76]] }, properties: { kind: 'roads', name: 'MS 301' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90.08, 34.71], [-90.02, 34.72]] }, properties: { kind: 'roads', name: '' } },
  ] },
};

let posted: unknown[] = [];

beforeEach(() => {
  dispatch.mockReset();
  posted = [];
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  for (const k of Object.keys(mockState)) delete mockState[k];
  Object.assign(mockState, {
    overlays: [], viewBounds: [34.7, -90.2, 34.9, -89.9], chartAreas: [], currentDataset: 'displacement',
    drawingEnabled: false, datasetInfo: {},
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/context/results/zone-abc123')) return new Response(JSON.stringify(ZONES));
    if (url.startsWith('/context/results/infr-xyz789')) return new Response(JSON.stringify(ROADS));
    if (url.startsWith('/context/results/')) return new Response(JSON.stringify({ detail: 'No result.' }), { status: 404 });
    if (url === '/infrastructure') {
      posted.push(JSON.parse(String(init?.body)));
      const empty = JSON.parse(String(init?.body)).zone === 'Z9';
      return new Response(JSON.stringify({
        result_id: 'infr-xyz789', n_features: empty ? 0 : 2, summary: { roads: { count: empty ? 0 : 2 } }, text: 'roads: 6.2 km', attribution: 'OSM',
      }));
    }
    if (url.startsWith('/gnss/stations')) {
      return new Response(JSON.stringify({ stations: [{ id: 'P056', lon: -90, lat: 34.8, first: 2010, last: 2024, ve_mm_yr: 1, vn_mm_yr: 0, vu_mm_yr: -2, sigma_vu_mm_yr: 0.3 }] }));
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** What clicking a Services toggle dispatches. */
async function byToggle(label: string): Promise<unknown[]> {
  const view = render(<OverlaysTab />);
  fireEvent.click(view.getByRole('tab', { name: 'Services' }));
  fireEvent.click(view.getByRole('switch', { name: label }));
  await new Promise(r => setTimeout(r, 20));
  cleanup();
  const out = actions();
  dispatch.mockReset();
  return out;
}

describe('context layers', () => {
  it.each([
    ['roads', 'Roads'], ['boundaries', 'Admin boundaries'], ['buildings', 'Buildings (3D)'],
    ['land_cover', 'Land cover'], ['geology', 'Geology'], ['soils', 'Soils'],
  ])('add_context_layer %s dispatches what the %s toggle dispatches', async (id, label) => {
    const toggled = await byToggle(label);
    expect(toggled.some(a => (a as { type: string }).type === 'ADD_OVERLAY')).toBe(true);
    const out = await runPageTool('add_context_layer', { id }, ctx()) as any;
    expect(actions()).toEqual(toggled);
    expect(out).toMatchObject({ ok: true, id, on: true });
  });

  it('remove_context_layer dispatches what switching the toggle off dispatches', async () => {
    for (const [id, label, row] of [
      ['roads', 'Roads', { id: 'ctx_roads_1', type: 'context', contextKey: 'roads', name: 'Roads' }],
      ['geology', 'Geology', { id: 'geology_1', type: 'wms', serviceKey: 'geology', name: 'Geology' }],
      ['land_cover', 'Land cover', { id: 'landcover_1', type: 'wmts', landCoverYear: 2024, name: 'Land cover 2024' }],
    ] as const) {
      mockState.overlays = [{ visible: true, opacity: 1, ...row }];
      const toggled = await byToggle(label);
      expect(toggled).toEqual([{ type: 'REMOVE_OVERLAY', payload: row.id }]);
      const out = await runPageTool('remove_context_layer', { id }, ctx()) as any;
      expect(actions()).toEqual(toggled);
      expect(out).toMatchObject({ ok: true, on: false });
      dispatch.mockReset();
    }
  });

  it('opacity and year are applied; an unknown id names the layers', async () => {
    await runPageTool('add_context_layer', { id: 'land_cover', year: 2020, opacity: 0.4 }, ctx());
    expect(actions()[0]).toMatchObject({ type: 'ADD_OVERLAY', payload: { landCoverYear: 2020, opacity: 0.4, name: 'Land cover 2020' } });
    mockState.overlays = [{ id: 'ctx_roads_1', type: 'context', contextKey: 'roads', name: 'Roads', visible: true, opacity: 0.85 }];
    dispatch.mockReset();
    const out = await runPageTool('add_context_layer', { id: 'roads', opacity: 0.3 }, ctx()) as any;
    expect(actions()).toEqual([{ type: 'UPDATE_OVERLAY', payload: { id: 'ctx_roads_1', updates: { opacity: 0.3 } } }]);
    expect(out.message).toBe('Already on.');
    await expect(runPageTool('add_context_layer', { id: 'railways' }, ctx())).rejects.toThrow('Context layers: roads, boundaries');
  });

  it('gnss loads the stations in the view, as the GNSS tab shows them', async () => {
    const out = await runPageTool('add_context_layer', { id: 'gnss' }, ctx()) as any;
    expect(out).toMatchObject({ on: true, name: 'GNSS stations (UNR)' });
    expect(actions()[1]).toMatchObject({ type: 'ADD_OVERLAY', payload: { id: 'gnss_stations', color: '#e11d48' } });
  });

  it('list_context_layers says which are on', async () => {
    mockState.overlays = [
      { id: 'ctx_roads_1', type: 'context', contextKey: 'roads', name: 'Roads', visible: true, opacity: 0.85 },
      { id: `${HIGHLIGHT_PREFIX}x`, type: 'vector', name: 'Roads in zone Z1', visible: true, opacity: 1, data: ROADS.features },
    ];
    const out = await runPageTool('list_context_layers', {}, ctx()) as any;
    const byId = Object.fromEntries(out.layers.map((l: any) => [l.id, l]));
    expect(Object.keys(byId)).toEqual(['roads', 'boundaries', 'buildings', 'land_cover', 'geology', 'soils', 'gnss']);
    expect(byId.roads).toMatchObject({ on: true, opacity: 0.85 });
    expect(byId.buildings.on).toBe(false);
    expect(out.highlights).toEqual([{ name: 'Roads in zone Z1', features: 2 }]);
  });
});

describe('highlights', () => {
  it('draw_highlight draws a kept result; drawing it again replaces it', async () => {
    const out = await runPageTool('draw_highlight', { result_id: 'zone-abc123', name: 'Zones' }, ctx()) as any;
    expect(out).toMatchObject({ ok: true, name: 'Zones', n_features: 1, layer_id: `${HIGHLIGHT_PREFIX}zone-abc123` });
    expect(actions()).toEqual([
      { type: 'REMOVE_OVERLAY', payload: `${HIGHLIGHT_PREFIX}zone-abc123` },
      { type: 'ADD_OVERLAY', payload: expect.objectContaining({ type: 'vector', color: '#c026d3', aboveData: true, data: ZONES.features }) },
    ]);
    await expect(runPageTool('draw_highlight', { result_id: 'zone-gone99' }, ctx())).rejects.toThrow('No result.');
    await expect(runPageTool('draw_highlight', { result_id: '../etc' }, ctx())).rejects.toThrow('result_id');
  });

  it('highlight_infrastructure asks the server for a zone and draws the features', async () => {
    const out = await runPageTool('highlight_infrastructure', { kinds: ['roads'], zone: 'Z1', color: '#00ff00' }, ctx()) as any;
    expect(posted).toEqual([{ kinds: ['roads'], zone: 'Z1' }]);
    expect(out).toMatchObject({ ok: true, name: 'Roads in zone Z1', n_features: 2, counts: { roads: 2 } });
    expect(actions()[1]).toMatchObject({ type: 'ADD_OVERLAY', payload: { name: 'Roads in zone Z1', color: '#00ff00', data: ROADS.features } });
  });

  it('highlight_infrastructure draws nothing when nothing is found', async () => {
    const out = await runPageTool('highlight_infrastructure', { kinds: ['roads'], zone: 'Z9' }, ctx()) as any;
    expect(out).toMatchObject({ ok: true, n_features: 0, counts: { roads: 0 } });
    expect(actions()).toEqual([]);
  });

  it('highlight_infrastructure takes a drawn shape by name (get_areas)', async () => {
    const poly = { type: 'Polygon', coordinates: [[[-90.1, 34.7], [-90.0, 34.7], [-90.0, 34.8], [-90.1, 34.7]]] };
    mockState.overlays = [{ id: 'drawings', type: 'vector', name: 'Drawings', visible: true, opacity: 1,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly, properties: { name: 'Spillway' } }] } }];
    mockState.chartAreas = [{ id: 'a1', name: 'AI area', color: '#f00', visible: true, geometry: poly }];
    expect(await runPageTool('get_areas', {}, ctx())).toMatchObject({
      areas: [{ name: 'Spillway', kind: 'drawn Polygon' }, { name: 'AI area', kind: 'chart area' }],
    });
    await expect(runPageTool('get_areas', { name: 'spilway' }, ctx())).rejects.toThrow('did you mean Spillway');
    await runPageTool('highlight_infrastructure', { kinds: ['roads', 'buildings'], area: 'Spillway' }, ctx());
    expect(posted).toEqual([{ kinds: ['roads', 'buildings'], geometry: poly }]);
  });

  it('clear_highlights removes them all, or one by name, and leaves other layers', async () => {
    mockState.overlays = [
      { id: 'ctx_roads_1', type: 'context', contextKey: 'roads', name: 'Roads', visible: true, opacity: 0.85 },
      { id: `${HIGHLIGHT_PREFIX}a`, type: 'vector', name: 'Zones', visible: true, opacity: 1 },
      { id: `${HIGHLIGHT_PREFIX}b`, type: 'vector', name: 'Roads in zone Z1', visible: true, opacity: 1 },
    ];
    expect(await runPageTool('clear_highlights', { name: 'Zones' }, ctx())).toEqual({ ok: true, removed: ['Zones'] });
    expect(actions()).toEqual([{ type: 'REMOVE_OVERLAY', payload: `${HIGHLIGHT_PREFIX}a` }]);
    dispatch.mockReset();
    await runPageTool('clear_highlights', {}, ctx());
    expect(actions()).toEqual([
      { type: 'REMOVE_OVERLAY', payload: `${HIGHLIGHT_PREFIX}a` },
      { type: 'REMOVE_OVERLAY', payload: `${HIGHLIGHT_PREFIX}b` },
    ]);
    await expect(runPageTool('clear_highlights', { name: 'Nope' }, ctx())).rejects.toThrow('Highlights: Zones, Roads in zone Z1');
  });
});
