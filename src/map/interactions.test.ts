/**
 * Map interaction contract (no map library involved): what a click, a marker drag,
 * a double-click or a hover does. The Leaflet layer and its MapLibre replacement both
 * route their events through these functions, so these tests hold for both.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppAction, RasterGroup } from '../types';
import {
  annotationAction, mapClickActions, markerPopupText, pixelInspectRequest, pixelInspectText,
  pointClickActions, pointDoubleClickActions, pointDragEndActions, refDragEnd, viewBoundsAction,
} from './interactions';

const P: [number, number] = [33.95859, -117.67462];   // [lat, lng]
const picking = { annotationMode: false, pointPickingEnabled: true, showChart: false };

describe('map click', () => {
  it('adds a time-series point and opens the chart', () => {
    expect(mapClickActions(picking, P, { toolActive: false, profileActive: false, now: 1760000001234 })).toEqual({
      kind: 'actions',
      actions: [
        { type: 'ADD_TIME_SERIES_POINT', payload: { position: P, name: 'Point 1234' } },
        { type: 'TOGGLE_CHART' },
      ],
    });
  });

  it('does not toggle the chart when it is already open', () => {
    const r = mapClickActions({ ...picking, showChart: true }, P, { toolActive: false, profileActive: false, now: 5 });
    expect(r).toEqual({ kind: 'actions', actions: [{ type: 'ADD_TIME_SERIES_POINT', payload: { position: P, name: 'Point 5' } }] });
  });

  it.each([
    ['a measure tool is active', { toolActive: true, profileActive: false }],
    ['the profile tool is active', { toolActive: false, profileActive: true }],
  ])('is ignored when %s', (_, opts) => {
    expect(mapClickActions(picking, P, opts)).toEqual({ kind: 'ignore' });
  });

  it('is ignored when point picking is off', () => {
    expect(mapClickActions({ ...picking, pointPickingEnabled: false }, P, { toolActive: false, profileActive: false }))
      .toEqual({ kind: 'ignore' });
  });

  it('opens the annotation form in annotation mode (even with picking on)', () => {
    expect(mapClickActions({ ...picking, annotationMode: true }, P, { toolActive: false, profileActive: false }))
      .toEqual({ kind: 'annotate', position: P });
  });
});

describe('annotation form', () => {
  it('trims text and clamps the font size', () => {
    expect(annotationAction(P, '  crest  ', '#ff0000', '200', 42)).toEqual({
      type: 'ADD_ANNOTATION',
      payload: { id: 'ann_42', position: P, text: 'crest', color: '#ff0000', fontSize: 72 },
    });
    expect((annotationAction(P, 'x', '#fff', '2', 1) as Extract<AppAction, { type: 'ADD_ANNOTATION' }>).payload.fontSize).toBe(8);
    expect((annotationAction(P, 'x', '#fff', 'abc', 1) as Extract<AppAction, { type: 'ADD_ANNOTATION' }>).payload.fontSize).toBe(13);
  });

  it('adds nothing for blank text', () => {
    expect(annotationAction(P, '   ', '#fff', '13')).toBeNull();
  });
});

describe('markers', () => {
  it('formats the popup for a named point and for the reference', () => {
    expect(markerPopupText(P, 'dam')).toBe('dam (lon, lat):\n(-117.674620, 33.958590)');
    expect(markerPopupText(P)).toBe('Reference (lon, lat):\n(-117.674620, 33.958590)');
  });

  it('click selects, drag moves, double-click removes', () => {
    expect(pointClickActions('p1')).toEqual([{ type: 'SET_SELECTED_POINT', payload: 'p1' }]);
    expect(pointDragEndActions('p1', P)).toEqual([
      { type: 'UPDATE_TIME_SERIES_POINT', payload: { id: 'p1', updates: { position: P } } },
    ]);
    expect(pointDoubleClickActions('p1')).toEqual([{ type: 'REMOVE_TIME_SERIES_POINT', payload: 'p1' }]);
  });
});

describe('reference marker drag', () => {
  const info = (algorithm: string | null): RasterGroup => ({
    name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
    uses_spatial_ref: true, algorithm, latlon_bounds: [0, 0, 0, 0],
    x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], available_mask_vars: [],
  });
  const st = (algorithm: string | null, buffer = 0) => ({
    currentDataset: 'displacement', datasetInfo: { displacement: info(algorithm) },
    refBufferEnabled: buffer > 0, refBufferRadius: buffer,
  });
  const api = (over: Partial<Parameters<typeof refDragEnd>[2]> = {}) => ({
    fetchPointTimeSeries: vi.fn(async () => [0, 1, 2]),
    fetchBufferTimeSeries: vi.fn(async () => ({ median: [{ x: '2026-01-01', y: 0.5 }, { x: '2026-01-25', y: 2.5 }] })),
    ...over,
  });

  it('moves the marker and reads the reference at the point', async () => {
    const out: AppAction[] = [];
    const a = api();
    await refDragEnd(st('shift'), P, a, x => out.push(x));
    expect(a.fetchPointTimeSeries).toHaveBeenCalledWith(P[1], P[0], 'displacement');
    expect(a.fetchBufferTimeSeries).not.toHaveBeenCalled();
    expect(out).toEqual([
      { type: 'SET_REF_MARKER_POSITION', payload: P },
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 1, 2] } },
    ]);
  });

  it('uses the buffer median aligned to the dataset dates, NaN where missing', async () => {
    const out: AppAction[] = [];
    const a = api();
    await refDragEnd(st('shift', 90), P, a, x => out.push(x));
    expect(a.fetchBufferTimeSeries).toHaveBeenCalledWith(P[1], P[0], 'displacement', 90, 0);
    expect(a.fetchPointTimeSeries).not.toHaveBeenCalled();
    expect(out[1]).toEqual({ type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0.5, NaN, 2.5] } });
  });

  it('falls back to the point when the buffer returns no median', async () => {
    const out: AppAction[] = [];
    const a = api({ fetchBufferTimeSeries: vi.fn(async () => undefined) });
    await refDragEnd(st('shift', 90), P, a, x => out.push(x));
    expect(a.fetchPointTimeSeries).toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });

  it('only moves the marker for datasets without the shift algorithm', async () => {
    const out: AppAction[] = [];
    const a = api();
    await refDragEnd(st(null), P, a, x => out.push(x));
    expect(out).toEqual([{ type: 'SET_REF_MARKER_POSITION', payload: P }]);
    expect(a.fetchPointTimeSeries).not.toHaveBeenCalled();
  });

  it('keeps the moved marker if the fetch fails', async () => {
    const out: AppAction[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refDragEnd(st('shift'), P, api({ fetchPointTimeSeries: vi.fn(async () => { throw new Error('x'); }) }), x => out.push(x));
    expect(out).toEqual([{ type: 'SET_REF_MARKER_POSITION', payload: P }]);
    err.mockRestore();
  });
});

describe('pixel inspect', () => {
  const st = {
    currentDataset: 'displacement', splitScreen: false, splitDataset: null as string | null,
    splitPosition: 0.5, splitTimeIndex: 4, currentTimeIndex: 2,
  };

  it('reads the displayed time step at the cursor', () => {
    expect(pixelInspectRequest(st, P, 100, 800)).toEqual({
      dataset: 'displacement', onRight: false,
      url: '/point?dataset_name=displacement&lon=-117.674620&lat=33.958590&time_idx=2',
    });
  });

  it('reads the right-hand dataset and its time step past the split line', () => {
    const split = { ...st, splitScreen: true, splitDataset: 'velocity' };
    expect(pixelInspectRequest(split, P, 500, 800)).toMatchObject({ dataset: 'velocity', onRight: true });
    expect(pixelInspectRequest(split, P, 500, 800)!.url).toContain('time_idx=4');
    expect(pixelInspectRequest(split, P, 300, 800)).toMatchObject({ dataset: 'displacement', onRight: false });
  });

  it('routes the hover to the catalog dataset like every other request', () => {
    window.history.replaceState({}, '', '/?dataset=prado-034-a-019');
    try {
      expect(pixelInspectRequest(st, P, 100, 800)!.url).toContain('dataset=prado-034-a-019');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('formats values, units, split sides and nodata', () => {
    expect(pixelInspectText(0.0123456, 'm', false, false)).toBe('0.01235 m');
    expect(pixelInspectText(0.0123456, '', true, true)).toBe('R: 0.01235');
    expect(pixelInspectText(NaN, 'm', false, false)).toBe('nodata');
    expect(pixelInspectText(null, 'm', true, false)).toBe('nodata');
  });
});

describe('view bounds', () => {
  it('reports the visible area rounded to 6 decimals, south/west/north/east', () => {
    expect(viewBoundsAction(33.951234567, -117.682345678, 33.97, -117.66)).toEqual({
      type: 'SET_VIEW_BOUNDS', payload: [33.951235, -117.682346, 33.97, -117.66],
    });
  });
});
