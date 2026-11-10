import { useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { useApi } from './useApi';
import { referenceValues } from '../map/interactions';

/**
 * The reference to take off an area's statistics, per layer. The server summarises the cube's
 * stored values; with the viewer's reference on, the values the map subtracts (one per date)
 * are taken off too, as /multi_point does for points: the map's own (state.refValues) for the
 * layer on the map, else fetched the same way. Returns, per layer, null when the reference is
 * off for it and undefined while it is fetched.
 */
export function useAreaReference(datasets: string[], active: boolean): (ds: string) => number[] | null | undefined {
  const { state } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const refBufferM = state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0;
  const refKey = (ds: string) => `${ds}|${state.refMarkerPosition.join(',')}|${refBufferM}`;
  const [fetchedRef, setFetchedRef] = useState<Record<string, number[]>>({});
  const usesRef = (ds: string) => !!state.datasetInfo[ds]?.uses_spatial_ref && state.refEnabled;
  const mapRef = (ds: string) => (ds === state.currentDataset ? state.refValues[ds] : undefined);
  useEffect(() => {
    if (!active) return;
    for (const ds of datasets) {
      if (!usesRef(ds) || mapRef(ds) || fetchedRef[refKey(ds)]) continue;
      const key = refKey(ds);
      referenceValues(state, ds, state.refMarkerPosition, { fetchPointTimeSeries, fetchBufferTimeSeries })
        .then(values => { if (values) setFetchedRef(prev => ({ ...prev, [key]: values })); })
        .catch(err => console.error('Error fetching reference values for an area:', err));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, JSON.stringify(datasets), state.refEnabled, state.refMarkerPosition,
      refBufferM, state.currentDataset, state.refValues, state.datasetInfo]);
  return (ds: string) => (!usesRef(ds) ? null : (mapRef(ds) ?? fetchedRef[refKey(ds)]));
}
