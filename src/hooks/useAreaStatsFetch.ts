import { useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useApi } from './useApi';
import { areaStatsKey } from '../utils/polygonSeries';
import { areaFetchOptions, fetchAreaStats } from '../utils/zonalStats';
import type { ChartArea } from '../types';

/**
 * Read each area's current-mask summary once per revision, shared across chart/Stats.
 * Mask/source/geometry changes clear the cache synchronously in the reducer.
 */
export function useAreaStatsFetch(datasets: string[], areas: Array<Pick<ChartArea, 'id' | 'geometry'>>, active: boolean): void {
  const { state, dispatch } = useAppContext();
  const { fetchPolygonTimeSeries } = useApi();
  useEffect(() => {
    if (!active) return;
    for (const ds of datasets) {
      const missing = areas.filter(a => {
        const key = areaStatsKey(ds, a.id);
        return !(key in state.areaStats);
      });
      if (missing.length) void fetchAreaStats(missing, [ds], fetchPolygonTimeSeries, dispatch, undefined, areaFetchOptions(state));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, JSON.stringify(datasets), JSON.stringify(areas.map(a => [a.id, a.geometry])),
    state.areaStatsRevision, state.areaStats, fetchPolygonTimeSeries, dispatch]);
}
