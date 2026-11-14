/** Request sharing, bounded queues and obsolete-generation cancellation. */
import { describe, expect, it, vi } from 'vitest';
import type { AppAction, ChartArea } from '../types';
import type { PolygonTimeSeries } from './polygonSeries';
import { fetchAreaStats, ZONAL_CONCURRENCY, type AreaFetchOptions } from './zonalStats';

const geometry: ChartArea['geometry'] = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const data: PolygonTimeSeries = { labels: ['2026-01-01'], units: 'meters', statistics: [
  { count: 1, mean: 0, median: 0, spatial_std: 0, minimum: 0, maximum: 0, percentiles: { 10: 0, 90: 0 } },
] };
const options = (revision: number): AreaFetchOptions => ({ revision, layerMasks: [], customMaskPath: null, dataMode: 'md', datasetInfo: {} });

describe('polygon request coordination', () => {
  it('never starts superseded queued jobs and never dispatches their answers', async () => {
    const areas = Array.from({ length: 5 }, (_, i) => ({ id: String(i), geometry }));
    const calls: Array<{ signal: AbortSignal; resolve: (value: { data: PolygonTimeSeries }) => void }> = [];
    const fetchPolygon = vi.fn((_ds, _geometry, _masks, signal: AbortSignal) =>
      new Promise<{ data: PolygonTimeSeries }>(resolve => calls.push({ signal, resolve })));
    const actions: AppAction[] = [];
    const dispatch = (action: AppAction) => { actions.push(action); };
    const original = fetchAreaStats(areas, ['displacement'], fetchPolygon, dispatch, undefined, options(0));
    expect(calls).toHaveLength(ZONAL_CONCURRENCY);
    const newer = fetchAreaStats(areas, ['displacement'], fetchPolygon, dispatch, undefined, options(1));
    expect(calls).toHaveLength(2 * ZONAL_CONCURRENCY);
    expect(calls.slice(0, 3).every(call => call.signal.aborted)).toBe(true);
    calls.slice(3).forEach(call => call.resolve({ data }));
    await vi.waitFor(() => expect(calls).toHaveLength(8));
    calls.slice(6).forEach(call => call.resolve({ data }));
    await newer;
    calls.slice(0, 3).forEach(call => call.resolve({ data }));
    await original;
    expect(calls).toHaveLength(8); // Two old queued jobs never reached the network.
    const finished = actions.filter(a => a.type === 'FINISH_AREA_STATS');
    expect(finished).toHaveLength(5);
    expect(finished.every(a => a.type === 'FINISH_AREA_STATS' && a.payload.revision === 1)).toBe(true);
  });

  it('shares a pending request within one provider but isolates separate providers', async () => {
    let resolve: (value: { data: PolygonTimeSeries }) => void = () => {};
    const fetchPolygon = vi.fn(() => new Promise<{ data: PolygonTimeSeries }>(done => { resolve = done; }));
    const dispatch = vi.fn();
    const areas = [{ id: 'a', geometry }];
    const chart = fetchAreaStats(areas, ['displacement'], fetchPolygon, dispatch);
    const stats = fetchAreaStats(areas, ['displacement'], fetchPolygon, dispatch);
    expect(fetchPolygon).toHaveBeenCalledTimes(1);
    resolve({ data });
    await Promise.all([chart, stats]);
    const other = fetchAreaStats(areas, ['displacement'], fetchPolygon, vi.fn());
    expect(fetchPolygon).toHaveBeenCalledTimes(2);
    resolve({ data });
    await other;
  });
});
