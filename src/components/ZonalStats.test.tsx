/**
 * Zonal stats on a vector layer (Overlays › a layer's chart-column button): the button on point
 * and polygon layers only, off on bowser-lite, one request per polygon a few at a time, points
 * added as clicked points, every feature in its own colour.
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, Overlay, RasterGroup } from '../types';
import OverlayRow from './panel/OverlayRow';
import { AREA_NEEDS_SERVER } from '../hooks/usePolygonStats';
import { runLimited, ZONAL_CONCURRENCY, ZONAL_MAX_FEATURES } from '../utils/zonalStats';
import { SERIES_COLORS } from '../utils/seriesColors';

const RESULT = {
  labels: ['2020-01-01', '2020-02-01'], units: 'meters', polygon_pixels: 9,
  statistics: [
    { count: 9, mean: 0, median: 0, spatial_std: 0.001, minimum: 0, maximum: 0, percentiles: { 10: 0, 90: 0 } },
    { count: 9, mean: 0.01, median: 0.01, spatial_std: 0.002, minimum: 0, maximum: 0.02, percentiles: { 10: 0.005, 90: 0.015 } },
  ],
};

const square = (x: number) => ({
  type: 'Polygon', coordinates: [[[x, 34.75], [x + 0.001, 34.75], [x + 0.001, 34.751], [x, 34.751], [x, 34.75]]],
});
const polygon = (x: number, name?: string) => ({ type: 'Feature', properties: name ? { name } : {}, geometry: square(x) });
const point = (lon: number, lat: number, props: Record<string, unknown> = {}) =>
  ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
const vector = (features: unknown[], name = 'areas.geojson'): Overlay => ({
  id: 'v1', name, type: 'vector', visible: true, opacity: 1, color: '#ff7f0e', data: { type: 'FeatureCollection', features },
});

let config: Record<string, unknown>;
let polygonRequests: any[];
let inFlight = 0;
let maxInFlight = 0;
let hold: Array<() => void> | null;

beforeEach(() => {
  config = { polygon_stats: true };
  polygonRequests = [];
  inFlight = 0; maxInFlight = 0; hold = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/config')) return new Response(JSON.stringify(config));
    if (url.startsWith('/polygon_timeseries')) {
      polygonRequests.push(JSON.parse(init!.body as string));
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      if (hold) await new Promise<void>(resolve => hold!.push(resolve));
      else await Promise.resolve();
      inFlight -= 1;
      return new Response(JSON.stringify(RESULT));
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const layer: RasterGroup = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: RESULT.labels,
  latlon_bounds: [-90.2, 34.7, -90.0, 34.8], available_mask_vars: [],
} as unknown as RasterGroup;

let stateRef: AppState;
function Row({ overlay }: { overlay: Overlay }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const noop = () => undefined;
  return <OverlayRow overlay={overlay} dropSide={null} onDragStart={noop} onDragEnd={noop} onDragOver={noop} onDragLeave={noop} onDrop={noop} />;
}
const renderRow = (overlay: Overlay, setup: AppAction[] = []) => {
  function Seed() {
    const { dispatch } = useAppContext();
    useEffect(() => { setup.forEach(dispatch); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }
  return render(<AppProvider><Seed /><Row overlay={overlay} /></AppProvider>);
};
const zonalButton = () => screen.queryByRole('button', { name: 'Zonal stats' }) as HTMLButtonElement | null;

describe('Zonal stats button', () => {
  it('is on layers with polygons or points, not lines alone', () => {
    renderRow(vector([line]));
    expect(zonalButton()).toBeNull();
    cleanup();
    renderRow(vector([polygon(0)]));
    expect(zonalButton()).toBeTruthy();
    cleanup();
    renderRow(vector([point(0, 0)]));
    expect(zonalButton()).toBeTruthy();
    expect(zonalButton()!.querySelector('i')!.className).toContain('fa-chart-column');
  });

  it('is off, with the reason, for polygons on bowser-lite', async () => {
    config = { polygon_stats: false };
    renderRow(vector([polygon(0)]));
    await waitFor(() => expect(zonalButton()!.disabled).toBe(true));
    expect(zonalButton()!.title).toBe(AREA_NEEDS_SERVER);
  });

  it('adds the points of a mixed layer on bowser-lite and says the polygons were skipped', async () => {
    config = { polygon_stats: false };
    renderRow(vector([polygon(0), point(-90.114, 34.755, { NAME: 'Well 3' })]));
    await waitFor(() => expect(zonalButton()!.title).toMatch(/each point/));
    await waitFor(() => expect(zonalButton()!.disabled).toBe(false));
    await act(async () => { fireEvent.click(zonalButton()!); });
    expect(stateRef.timeSeriesPoints.map(p => p.name)).toEqual(['Well 3']);
    expect(stateRef.chartAreas).toHaveLength(0);
    expect(polygonRequests).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain(AREA_NEEDS_SERVER);
  });
});

describe('Zonal stats on polygons', () => {
  it('asks for every polygon, three at a time, and shows the progress', async () => {
    hold = [];
    renderRow(vector([polygon(0, 'Dam area'), polygon(1), line, polygon(2), polygon(3), polygon(4)]));
    await act(async () => { fireEvent.click(zonalButton()!); });
    expect(stateRef.chartAreas.map(a => a.name)).toEqual(['Dam area', 'areas.geojson 2', 'areas.geojson 3', 'areas.geojson 4', 'areas.geojson 5']);
    expect(stateRef.chartAreas[0].source).toEqual({ overlayId: 'v1', layer: 'areas.geojson', index: 0 });
    expect(stateRef.showChart).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Zonal stats: 0/5 areas');
    expect(polygonRequests).toHaveLength(ZONAL_CONCURRENCY);
    // Every key is pending until its answer comes.
    expect(Object.values(stateRef.areaStats).every(s => s.pending)).toBe(true);
    while (hold.length) {
      const next = hold.splice(0);
      await act(async () => { next.forEach(r => r()); });
    }
    await waitFor(() => expect(polygonRequests).toHaveLength(5));
    expect(maxInFlight).toBe(ZONAL_CONCURRENCY);
    expect(polygonRequests[0]).toMatchObject({ variable: 'displacement', percentiles: [10, 90], geometry: square(0) });
    await waitFor(() => expect(Object.values(stateRef.areaStats).every(s => s.data)).toBe(true));
    expect(Object.keys(stateRef.areaStats)).toHaveLength(5);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it(`stops at ${ZONAL_MAX_FEATURES} polygons and says so`, async () => {
    renderRow(vector(Array.from({ length: ZONAL_MAX_FEATURES + 5 }, (_, i) => polygon(i))));
    await act(async () => { fireEvent.click(zonalButton()!); });
    await waitFor(() => expect(polygonRequests).toHaveLength(ZONAL_MAX_FEATURES));
    expect(stateRef.chartAreas).toHaveLength(ZONAL_MAX_FEATURES);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`Only the first ${ZONAL_MAX_FEATURES} of ${ZONAL_MAX_FEATURES + 5} polygons.`));
  });

  it('does not add the same polygons twice', async () => {
    renderRow(vector([polygon(0), polygon(1)]));
    await act(async () => { fireEvent.click(zonalButton()!); });
    await waitFor(() => expect(zonalButton()!.disabled).toBe(false));
    await act(async () => { fireEvent.click(zonalButton()!); });
    expect(stateRef.chartAreas).toHaveLength(2);
    expect(polygonRequests).toHaveLength(2);
  });
});

describe('Zonal stats on points', () => {
  it('adds each point as a time-series point, named by its property or the layer', async () => {
    renderRow(vector([point(-90.114, 34.755, { name: 'Gauge' }), point(-90.113, 34.756), point(-90.112, 34.757, { title: 'Spillway' })], 'wells.geojson'));
    await act(async () => { fireEvent.click(zonalButton()!); });
    expect(stateRef.timeSeriesPoints.map(p => [p.name, p.position])).toEqual([
      ['Gauge', [34.755, -90.114]], ['wells.geojson 2', [34.756, -90.113]], ['Spillway', [34.757, -90.112]],
    ]);
    expect(stateRef.timeSeriesPoints.every(p => p.visible)).toBe(true);
    expect(stateRef.showChart).toBe(true);
    expect(polygonRequests).toHaveLength(0);
  });

  it('gives every feature its own colour from the point palette', async () => {
    renderRow(vector([polygon(0), polygon(1), point(0, 0), point(1, 1), polygon(2)]),
      [{ type: 'ADD_TIME_SERIES_POINT', payload: { position: [5, 5], name: 'Clicked' } }]);
    await act(async () => { fireEvent.click(zonalButton()!); });
    const colours = [...stateRef.timeSeriesPoints, ...stateRef.chartAreas].map(s => s.color);
    expect(colours).toHaveLength(6);
    expect(new Set(colours).size).toBe(6);
    expect(colours.every(c => (SERIES_COLORS as readonly string[]).includes(c))).toBe(true);
    expect(stateRef.timeSeriesPoints[0].color).toBe(SERIES_COLORS[0]);  // the clicked point keeps its colour
  });
});

describe('runLimited', () => {
  it('never runs more than the limit at once, and runs every item', async () => {
    let running = 0, most = 0;
    const seen: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      running += 1; most = Math.max(most, running);
      await new Promise(r => setTimeout(r, 1));
      seen.push(n); running -= 1;
    });
    expect(most).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
