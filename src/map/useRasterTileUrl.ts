import { useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { buildTileRequest } from '../utils/tileParams';

export interface RasterOverrides {
  dataset?: string;
  colormap?: string;
  vmin?: number;
  vmax?: number;
  timeIndex?: number;
}

/**
 * The XYZ tile URL template for the raster layer, refreshed (debounced, stale
 * requests aborted) whenever anything that changes the rendered tiles changes.
 * Map-library independent: Leaflet and MapLibre layers both render this URL.
 */
export function useRasterTileUrl(o: RasterOverrides = {}): string | null {
  const { state } = useAppContext();
  const [tileUrl, setTileUrl] = useState<string | null>(null);

  const effectiveDataset = o.dataset ?? state.currentDataset;
  const effectiveColormap = o.colormap ?? state.colormap;
  const effectiveVmin = o.vmin ?? state.vmin;
  const effectiveVmax = o.vmax ?? state.vmax;
  const effectiveTimeIndex = o.timeIndex ?? state.currentTimeIndex;

  useEffect(() => {
    if (!effectiveDataset || !state.datasetInfo[effectiveDataset] || !state.dataMode) return;
    if (state.dataMode !== 'md' && state.dataMode !== 'cog') return;

    const controller = new AbortController();
    const signal = controller.signal;

    const updateTileLayer = async () => {
      const { endpoint } = buildTileRequest({
        dataset: effectiveDataset,
        dsInfo: state.datasetInfo[effectiveDataset],
        timeIndex: effectiveTimeIndex,
        vmin: effectiveVmin,
        vmax: effectiveVmax,
        colormap: effectiveColormap,
        state,
        datasetId: new URLSearchParams(window.location.search).get('dataset'),
      });

      try {
        const response = await fetch(endpoint, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const tileInfo = await response.json();
        if (!signal.aborted) setTileUrl(tileInfo.tiles[0]);
      } catch (err) {
        if ((err as any).name !== 'AbortError') console.error('Error fetching tile info:', err);
      }
    };

    const debounceTimer = setTimeout(() => updateTileLayer(), 80);
    return () => { clearTimeout(debounceTimer); controller.abort(); };
  }, [
    effectiveDataset,
    effectiveTimeIndex,
    state.datasetInfo,
    state.dataMode,
    state.refValues,
    state.refMarkerPosition,
    state.refEnabled,
    effectiveColormap,
    effectiveVmin,
    effectiveVmax,
    state.layerMasks,
    state.customMaskPath,
    state.wrapEnabled,
    state.wrapWavelength,
    state.wrapPeriod,
    state.complexMode,
  ]);

  return tileUrl;
}
