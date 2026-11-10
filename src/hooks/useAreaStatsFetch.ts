import { useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useApi } from './useApi';
import { areaStatsKey } from '../utils/polygonSeries';
import { fetchAreaStats } from '../utils/zonalStats';
import type { ChartArea } from '../types';

/** Keys asked for in this page, so the chart and the Stats tab never ask twice for the same one. */
const requested = new Set<string>();

/**
 * Ask for each area's statistics on each layer that has none yet (an area's polygon never
 * changes, so once is enough), a few at a time. Zonal stats marks its own as pending first.
 */
export function useAreaStatsFetch(datasets: string[], areas: Array<Pick<ChartArea, 'id' | 'geometry'>>, active: boolean): void {
  const { state, dispatch } = useAppContext();
  const { fetchPolygonTimeSeries } = useApi();
  useEffect(() => {
    if (!active) return;
    for (const ds of datasets) {
      const missing = areas.filter(a => {
        const key = areaStatsKey(ds, a.id);
        if (requested.has(key) || key in state.areaStats) return false;
        requested.add(key);
        return true;
      });
      if (missing.length) void fetchAreaStats(missing, [ds], fetchPolygonTimeSeries, dispatch);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, JSON.stringify(datasets), JSON.stringify(areas.map(a => a.id)), fetchPolygonTimeSeries]);
}
