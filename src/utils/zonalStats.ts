/**
 * Zonal stats for a vector layer (Overlays › a layer's chart button): each polygon becomes a
 * chart area summarised by POST /polygon_timeseries, each point a time-series point as if
 * clicked on the map. Requests run a few at a time so a file of many polygons can't flood the
 * server.
 */
import type { AppAction, AppState, AreaStats, ChartArea } from '../types';
import { chartLayerFor, timeSeriesLayers } from './chartLayers';
import { areaStatsKey, polygonEmptyMessage, type PolygonTimeSeries } from './polygonSeries';

/** At most this many polygons, and this many points, from one layer per run. */
export const ZONAL_MAX_FEATURES = 50;
/** Polygon requests in flight at once. */
export const ZONAL_CONCURRENCY = 3;

type FetchPolygon = (dataset: string, geometry: ChartArea['geometry']) =>
  Promise<{ data: PolygonTimeSeries } | { error: string }>;

/** Run ``worker`` on every item, at most ``limit`` at a time, in order of start. */
export async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
}

/** The layers the chart shows: every chart window's chosen layers, else the one it follows. */
export function chartDatasets(state: Pick<AppState, 'chartWindows' | 'currentDataset' | 'datasetInfo'>): string[] {
  const all = timeSeriesLayers(state.datasetInfo);
  const chosen = state.chartWindows.flatMap(w => w.dsNames).filter(ds => all.includes(ds));
  const followed = chartLayerFor(state.currentDataset, state.datasetInfo);
  const followers = state.chartWindows.length === 0 || state.chartWindows.some(w => w.dsNames.length === 0);
  return [...new Set([...(followers && followed ? [followed] : []), ...chosen])];
}

/** An answer as kept in AppState.areaStats: no valid pixel is an error too. */
export function toAreaStats(res: { data: PolygonTimeSeries } | { error: string }): AreaStats {
  if ('error' in res) return { error: res.error };
  const empty = polygonEmptyMessage(res.data);
  return empty ? { error: empty } : { data: res.data };
}

/**
 * Fetch each area's statistics for each layer, ``ZONAL_CONCURRENCY`` areas at a time. Every
 * key is marked pending first (so the chart doesn't ask again), then filled as answers come.
 * ``onProgress`` gets (areas done, areas in all).
 */
export async function fetchAreaStats(
  areas: Array<Pick<ChartArea, 'id' | 'geometry'>>,
  datasets: string[],
  fetchPolygon: FetchPolygon,
  dispatch: (a: AppAction) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (areas.length === 0 || datasets.length === 0) return;
  const pending: Record<string, AreaStats> = {};
  for (const a of areas) for (const ds of datasets) pending[areaStatsKey(ds, a.id)] = { pending: true };
  dispatch({ type: 'SET_AREA_STATS', payload: pending });
  let done = 0;
  onProgress?.(0, areas.length);
  await runLimited(areas, ZONAL_CONCURRENCY, async area => {
    for (const ds of datasets) {
      const res = await fetchPolygon(ds, area.geometry);
      dispatch({ type: 'SET_AREA_STATS', payload: { [areaStatsKey(ds, area.id)]: toAreaStats(res) } });
    }
    done += 1;
    onProgress?.(done, areas.length);
  });
}
