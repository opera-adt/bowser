import { useEffect, useRef } from 'react';
import { AppProvider, useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { usePointsApi } from '../hooks/usePointsApi';
import { parseUrlState, applyUrlState, useUrlStateSync } from '../hooks/useUrlState';
import MapContainer from './MapContainer';
import TimeSeriesChart from './TimeSeriesChart';
import PointControlsPanel from './PointControlsPanel';
import '../style.css';

function AppContent() {
  const { state, dispatch } = useAppContext();
  const { fetchDatasets, fetchDataMode } = useApi();
  const { fetchPointLayers, fetchPointAttributes } = usePointsApi();
  const urlStateRef = useRef(parseUrlState());

  // Sync state → URL params
  useUrlStateSync();

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Try to load BOTH raster datasets and point layers.
        // They can coexist — the manifest may define both.

        // 1) Try point layers
        let hasPointLayers = false;
        try {
          const pointLayers = await fetchPointLayers();
          const layerNames = Object.keys(pointLayers);
          if (layerNames.length > 0) {
            hasPointLayers = true;
            const firstLayer = layerNames[0];
            dispatch({ type: 'SET_ACTIVE_POINT_LAYER', payload: firstLayer });

            const attrs = await fetchPointAttributes(firstLayer);
            dispatch({ type: 'SET_POINT_ATTRIBUTES', payload: attrs.attributes });

            // Set bounds from lon/lat ranges
            const lonAttr = attrs.attributes.longitude;
            const latAttr = attrs.attributes.latitude;
            if (lonAttr?.min != null && lonAttr?.max != null &&
                latAttr?.min != null && latAttr?.max != null) {
              dispatch({
                type: 'SET_POINT_LAYER_BOUNDS',
                payload: [lonAttr.min, latAttr.min, lonAttr.max, latAttr.max],
              });
            }

            // Auto-set vmin/vmax from default color-by attribute
            const defaultColorBy = pointLayers[firstLayer].default_color_by || 'velocity';
            dispatch({ type: 'SET_POINT_COLOR_BY', payload: defaultColorBy });
            const colorAttr = attrs.attributes[defaultColorBy];
            if (colorAttr?.min != null && colorAttr?.max != null) {
              if (defaultColorBy.includes('velocity')) {
                const absMax = Math.max(Math.abs(colorAttr.min), Math.abs(colorAttr.max));
                dispatch({ type: 'SET_POINT_VMIN', payload: -absMax });
                dispatch({ type: 'SET_POINT_VMAX', payload: absMax });
              } else {
                dispatch({ type: 'SET_POINT_VMIN', payload: colorAttr.min });
                dispatch({ type: 'SET_POINT_VMAX', payload: colorAttr.max });
              }
            }
          }
        } catch {
          // No point layers endpoint — that's fine
        }

        // 2) Try raster datasets (always, regardless of point layers)
        let hasRasterLayers = false;
        try {
          const mode = await fetchDataMode();
          const datasets = await fetchDatasets();
          const datasetNames = Object.keys(datasets);
          if (datasetNames.length > 0) {
            hasRasterLayers = true;
            dispatch({ type: 'SET_DATA_MODE', payload: mode });
            dispatch({ type: 'SET_DATASETS', payload: datasets });

            const firstDataset = datasetNames[0];
            dispatch({ type: 'SET_CURRENT_DATASET', payload: firstDataset });

            const bounds = datasets[firstDataset].latlon_bounds;
            const centerLat = (bounds[1] + bounds[3]) / 2;
            const centerLng = (bounds[0] + bounds[2]) / 2;
            dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [centerLat, centerLng] });
          }
        } catch {
          // No raster datasets — that's fine if we have points
        }

        // Set data mode based on what's available
        if (hasPointLayers && !hasRasterLayers) {
          dispatch({ type: 'SET_DATA_MODE', payload: 'points' });
        }

        // Apply URL state overrides (shareable links)
        applyUrlState(dispatch, urlStateRef.current);
      } catch (error) {
        console.error('Error initializing app:', error);
      }
    };

    initializeApp();
  }, [fetchDatasets, fetchDataMode, fetchPointLayers, fetchPointAttributes, dispatch]);

  return (
    <div className="app-container">
      <div className="map-container" style={{ gridColumn: '1 / -1' }}>
        <MapContainer />
        <PointControlsPanel />
        {state.showChart && <TimeSeriesChart />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
