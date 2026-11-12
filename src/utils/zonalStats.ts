/**
 * Zonal stats for a vector layer (Overlays › a layer's chart button): each polygon becomes a
 * chart area summarised by POST /polygon_timeseries, each point a time-series point as if
 * clicked on the map. Requests run a few at a time so a file of many polygons can't flood the
 * server.
 */
import type { AppAction, AppState, AreaStats, ChartArea, LayerMask, RasterGroup } from '../types';
import { chartLayerFor, timeSeriesLayers } from './chartLayers';
import { areaStatsKey, polygonEmptyMessage, type PolygonTimeSeries } from './polygonSeries';

/** At most this many polygons, and this many points, from one layer per run. */
export const ZONAL_MAX_FEATURES = 50;
/** Polygon requests in flight at once. */
export const ZONAL_CONCURRENCY = 3;

type FetchPolygon = (dataset: string, geometry: ChartArea['geometry'], masks: LayerMask[], signal: AbortSignal) =>
  Promise<{ data: PolygonTimeSeries } | { error: string }>;

export interface AreaFetchOptions {
  revision: number;
  layerMasks: LayerMask[];
  customMaskPath: string | null;
  dataMode: string;
  datasetInfo: Record<string, RasterGroup>;
}

/** Keep numerical request settings separate from references and display options. */
export function areaFetchOptions(state: Pick<AppState,
  'areaStatsRevision' | 'layerMasks' | 'customMaskPath' | 'dataMode' | 'datasetInfo'
>): AreaFetchOptions {
  return { revision: state.areaStatsRevision, layerMasks: state.layerMasks,
    customMaskPath: state.customMaskPath, dataMode: state.dataMode, datasetInfo: state.datasetInfo };
}

type Dispatch = (a: AppAction) => void;
interface Request {
  id: number;
  geometry: string;
  controller: AbortController;
  promise?: Promise<AreaStats>;
}
interface Requests { revision: number; entries: Map<string, Request> }
// Share work between chart windows/Stats, never between independent providers.
const requests = new WeakMap<Dispatch, Requests>();
let nextRequestId = 0;

function maskError(dataset: string, options: AreaFetchOptions): string | null {
  if (options.customMaskPath) return 'Area statistics do not yet support uploaded masks. Clear the uploaded mask to plot this area.';
  if (options.dataMode === 'cog' && options.datasetInfo[dataset]?.mask_file_list?.some(Boolean)) {
    return 'Area statistics do not yet support configured GeoTIFF masks. No unmasked curve is shown.';
  }
  if (options.layerMasks.some(m => !Number.isFinite(m.threshold))) return 'Area mask thresholds must be finite numbers.';
  return null;
}

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
  options: AreaFetchOptions = { revision: 0, layerMasks: [], customMaskPath: null, dataMode: 'md', datasetInfo: {} },
): Promise<void> {
  if (areas.length === 0 || datasets.length === 0) return;
  let store = requests.get(dispatch);
  if (!store) {
    store = { revision: options.revision, entries: new Map() };
    requests.set(dispatch, store);
  }
  if (options.revision < store.revision) return;
  if (options.revision !== store.revision) {
    for (const record of store.entries.values()) record.controller.abort();
    store.entries.clear();
    store.revision = options.revision;
  }
  const current = store;
  const pending: Record<string, AreaStats> = {};
  const jobs = areas.map(area => datasets.map(ds => {
    const key = areaStatsKey(ds, area.id);
    const geometry = JSON.stringify(area.geometry);
    let record = current.entries.get(key);
    if (!record || record.geometry !== geometry) {
      record?.controller.abort();
      record = { id: ++nextRequestId, geometry, controller: new AbortController() };
      current.entries.set(key, record);
    }
    pending[key] = { pending: true, requestId: record.id };
    return { key, ds, area, record };
  }));
  dispatch({ type: 'START_AREA_STATS', payload: { revision: options.revision, entries: pending } });
  let done = 0;
  onProgress?.(0, areas.length);
  await runLimited(jobs, ZONAL_CONCURRENCY, async batch => {
    for (const { key, ds, area, record } of batch) {
      const live = () => current.revision === options.revision && current.entries.get(key) === record && !record.controller.signal.aborted;
      if (!live()) continue; // Superseded queued work must not start another request.
      if (!record.promise) {
        record.promise = (async () => {
          const error = maskError(ds, options);
          if (error) return { error };
          try {
            return toAreaStats(await fetchPolygon(ds, area.geometry, options.layerMasks, record.controller.signal));
          } catch {
            return { error: 'could not reach the server' };
          }
        })();
      }
      const result = await record.promise;
      if (live()) dispatch({ type: 'FINISH_AREA_STATS', payload: { revision: options.revision,
        entries: { [key]: { ...result, requestId: record.id } } } });
    }
    done += 1;
    if (current.revision === options.revision) onProgress?.(done, areas.length);
  });
}
