import { useEffect, useState } from 'react';
import { MapContainer as LeafletMapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApi } from '../hooks/useApi';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { MousePositionControl } from '../mouse';

// Fix for default markers in React Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const fontAwesomeIcon = L.divIcon({
  html: '<i class="fa-solid fa-location-dot fa-3x"></i>',
  iconSize: [20, 20],
  className: 'myDivIcon'
});

function MapEvents() {
  const { dispatch } = useAppContext();

  useMapEvents({
    click: (e) => {
      // Add new time series point on map click
      dispatch({
        type: 'ADD_TIME_SERIES_POINT',
        payload: {
          position: [e.latlng.lat, e.latlng.lng],
          name: `Point ${Date.now().toString().slice(-4)}` // Short unique name
        }
      });
    },
  });

  return null;
}

function MousePosition() {
  const map = useMap();

  useEffect(() => {
    const mousePositionControl = new MousePositionControl();
    mousePositionControl.addTo(map);

    return () => {
      mousePositionControl.remove();
    };
  }, [map]);

  return null;
}

function RasterTileLayer() {
  const { state } = useAppContext();
  const [tileUrl, setTileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!state.currentDataset || !state.datasetInfo[state.currentDataset]) {
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const updateTileLayer = async () => {
      const currentDatasetInfo = state.datasetInfo[state.currentDataset];

      // Use ONLY state — DO NOT read localStorage here
      const colormap = state.colormap;
      const vmin = state.vmin;
      const vmax = state.vmax;

      // Ensure time index is within bounds
      const maxIdx = currentDatasetInfo.x_values.length - 1;
      const timeIdx = Math.max(0, Math.min(state.currentTimeIndex, maxIdx));

      // Build parameters
      const params: Record<string, string> = {
        variable: state.currentDataset,
        time_idx: timeIdx.toString(),
        rescale: `${vmin},${vmax}`,
        colormap_name: colormap,
      };

      // Add algorithm if needed
      if (currentDatasetInfo.algorithm) {
        params.algorithm = currentDatasetInfo.algorithm;
      }

      // Add shift for reference point if available
      if (state.refValues[state.currentDataset] && currentDatasetInfo.algorithm === 'shift') {
        const shift = state.refValues[state.currentDataset][timeIdx];
        if (shift !== undefined) {
          params.algorithm_params = JSON.stringify({ shift });
        }
      }

      // Add URL parameter for COG mode
      if (state.dataMode === 'cog') {
        const url = currentDatasetInfo.file_list[timeIdx];
        const maskUrl = currentDatasetInfo.mask_file_list[timeIdx];
        const maskMinValue = currentDatasetInfo.mask_min_value;

        params.url = url;
        if (maskUrl) params.mask = encodeURIComponent(maskUrl);
        if (maskMinValue !== undefined) params.mask_min_value = maskMinValue.toString();
      }

      const urlParams = new URLSearchParams(params).toString();
      const endpoint = state.dataMode === 'md'
        ? `/md/WebMercatorQuad/tilejson.json?${urlParams}`
        : `/cog/WebMercatorQuad/tilejson.json?${urlParams}`;

      try {
        const response = await fetch(endpoint, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const tileInfo = await response.json();
        // Only set if not aborted
        if (!signal.aborted) setTileUrl(tileInfo.tiles[0]);
      } catch (err) {
        if ((err as any).name !== 'AbortError') {
          console.error('Error fetching tile info:', err);
        }
      }
    };

    updateTileLayer();
    return () => controller.abort();
  }, [
    state.currentDataset,
    state.currentTimeIndex,
    state.datasetInfo,
    state.dataMode,
    state.refValues,
    state.refMarkerPosition,
    state.colormap,
    state.vmin,
    state.vmax
  ]);

  if (!tileUrl) return null;

  return (
    <TileLayer
      key={tileUrl}  // force refresh if URL changes
      url={tileUrl}
      opacity={state.opacity}
      maxZoom={19}
    />
  );
}

function MarkerEventHandlers() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries } = useApi();
  const map = useMap();

  const handleMarkerClick = (position: [number, number], pointName?: string) => {
    const [lat, lng] = position;
    const content = pointName
      ? `${pointName} (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`
      : `Reference (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`;
    L.popup()
      .setLatLng([lat, lng])
      .setContent(content)
      .openOn(map);
  };

  const handleTsMarkerDragEnd = (pointId: string) => (e: L.DragEndEvent) => {
    const marker = e.target;
    const position = marker.getLatLng();
    dispatch({
      type: 'UPDATE_TIME_SERIES_POINT',
      payload: {
        id: pointId,
        updates: { position: [position.lat, position.lng] }
      }
    });
  };

  const handleRefMarkerDragEnd = async (e: L.DragEndEvent) => {
    const marker = e.target;
    const position = marker.getLatLng();
    const lat = position.lat;
    const lng = position.lng;
    // 1) update position in state
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lng] });

    // 2) if current dataset uses the "shift" algo, recompute ref values
    const ds = state.currentDataset;
    const info = ds ? state.datasetInfo[ds] : null;
    if (ds && info?.algorithm === 'shift') {
      try {
        const values = await fetchPointTimeSeries(lng, lat, ds);
        if (values) {
          dispatch({
            type: 'SET_REF_VALUES',
            payload: { dataset: ds, values },
          });
        }
      } catch (err) {
        console.error('Error updating reference values after drag:', err);
      }
    }
  };

  const handleTsMarkerDoubleClick = (pointId: string) => () => {
    // Double-click to remove point
    dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: pointId });
  };

  // Create custom colored icons for each point
  const createColoredIcon = (color: string, isSelected: boolean = false) => {
    const iconSize = isSelected ? 25 : 20;
    return L.divIcon({
      html: `<div style="
        width: ${iconSize}px;
        height: ${iconSize}px;
        background-color: ${color};
        border: ${isSelected ? '3px solid white' : '2px solid white'};
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>`,
      iconSize: [iconSize, iconSize],
      className: 'custom-colored-marker'
    });
  };

  return (
    <>
      {/* Time Series Points */}
      {state.timeSeriesPoints.filter(p => p.visible).map((point) => (
        <Marker
          key={point.id}
          position={point.position}
          icon={createColoredIcon(point.color, state.selectedPointId === point.id)}
          draggable
          title={`${point.name} - Double-click to remove`}
          eventHandlers={{
            click: () => {
              handleMarkerClick(point.position, point.name);
              dispatch({ type: 'SET_SELECTED_POINT', payload: point.id });
            },
            dragend: handleTsMarkerDragEnd(point.id),
            dblclick: handleTsMarkerDoubleClick(point.id),
          }}
        />
      ))}

      {/* Reference Marker */}
      <Marker
        position={state.refMarkerPosition}
        icon={fontAwesomeIcon}
        draggable
        title="Reference Location"
        eventHandlers={{
          click: () => handleMarkerClick(state.refMarkerPosition),
          dragend: handleRefMarkerDragEnd,
        }}
      />
    </>
  );
}

export default function MapContainer() {
  const { state } = useAppContext();

  // Calculate initial center from first dataset bounds
  const getInitialCenter = (): [number, number] => {
    if (state.currentDataset && state.datasetInfo[state.currentDataset]) {
      const bounds = state.datasetInfo[state.currentDataset].latlon_bounds;
      const centerLat = (bounds[1] + bounds[3]) / 2;
      const centerLng = (bounds[0] + bounds[2]) / 2;
      return [centerLat, centerLng];
    }

    // If no current dataset, try to get bounds from any available dataset
    const datasets = Object.values(state.datasetInfo);
    if (datasets.length > 0) {
      const bounds = datasets[0].latlon_bounds;
      const centerLat = (bounds[1] + bounds[3]) / 2;
      const centerLng = (bounds[0] + bounds[2]) / 2;
      return [centerLat, centerLng];
    }

    return [0, 0];
  };

  const selectedBasemap = baseMaps[state.selectedBasemap] || baseMaps.esriSatellite;

  const center = getInitialCenter();
  const hasDatasets = Object.keys(state.datasetInfo).length > 0;

  return (
    <LeafletMapContainer
      key={hasDatasets ? 'with-data' : 'no-data'} // Force re-render when data loads
      center={center}
      zoom={9}
      style={{ height: '100%', width: '100%' }}
      doubleClickZoom={false}
    >
      <TileLayer
        url={selectedBasemap.url}
        attribution={selectedBasemap.attribution}
        maxZoom={19}
      />
      <RasterTileLayer />
      <MarkerEventHandlers />
      <MapEvents />
      <MousePosition />
    </LeafletMapContainer>
  );
}
