import { useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { useApi } from './useApi';
import { AREA_NEEDS_SERVER } from './usePolygonStats';
import { pointChoices, polygonChoices } from '../utils/polygonSeries';
import { chartDatasets, fetchAreaStats, ZONAL_MAX_FEATURES } from '../utils/zonalStats';
import type { Overlay } from '../types';

export interface ZonalProgress {
  done: number;
  total: number;
}

/**
 * Zonal stats for one vector layer: its polygons become chart areas (median, mean and spread
 * per date, also listed in the Stats tab) and its points become time-series points, as if
 * clicked on the map. Features already added from the layer are not added twice. Returns the
 * notes to show under the layer (a cap reached, areas off on bowser-lite).
 */
export function useZonalStats(polygonStats: boolean) {
  const { state, dispatch } = useAppContext();
  const { fetchPolygonTimeSeries } = useApi();

  return useCallback(async (overlay: Overlay, onProgress: (p: ZonalProgress) => void): Promise<string[]> => {
    const notes: string[] = [];
    const capped = (list: unknown[], what: string) => {
      if (list.length > ZONAL_MAX_FEATURES) notes.push(`Only the first ${ZONAL_MAX_FEATURES} of ${list.length} ${what}.`);
      return list.slice(0, ZONAL_MAX_FEATURES);
    };
    let added = false;

    // Points: exactly what a map click adds, named after the feature.
    const allPoints = pointChoices(overlay);
    const points = capped(allPoints, 'points') as typeof allPoints;
    const have = new Set(state.timeSeriesPoints.map(p => `${p.name}|${p.position.join(',')}`));
    for (const p of points) {
      if (have.has(`${p.name}|${p.position.join(',')}`)) continue;
      dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: p.position, name: p.name } });
      added = true;
    }

    // Polygons: one chart area each, requested a few at a time.
    const allPolygons = polygonChoices([overlay]);
    let areas: { id: string; name: string; geometry: (typeof allPolygons)[number]['geometry']; source: (typeof allPolygons)[number]['source'] }[] = [];
    if (allPolygons.length > 0 && !polygonStats) {
      notes.push(`${AREA_NEEDS_SERVER}: the polygons were skipped.`);
    } else if (allPolygons.length > 0) {
      const polygons = capped(allPolygons, 'polygons') as typeof allPolygons;
      const known = new Set(state.chartAreas.flatMap(a => (a.source ? [`${a.source.overlayId}:${a.source.index}`] : [])));
      const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      areas = polygons.filter(p => !known.has(p.key))
        .map((p, i) => ({ id: `area_${stamp}_${i}`, name: p.name, geometry: p.geometry, source: p.source }));
      if (areas.length > 0) {
        dispatch({ type: 'ADD_CHART_AREAS', payload: areas });
        added = true;
      }
    }
    if (added && !state.showChart) dispatch({ type: 'TOGGLE_CHART' });
    await fetchAreaStats(areas, chartDatasets(state), fetchPolygonTimeSeries, dispatch,
      (done, total) => onProgress({ done, total }));
    return notes;
  }, [state, dispatch, fetchPolygonTimeSeries, polygonStats]);
}
