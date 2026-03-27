import { useEffect, useState, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';
import { useAppContext } from '../context/AppContext';
import { usePointsApi, PointData } from '../hooks/usePointsApi';
import { valueToColor } from '../colorscales';
import { parseUrlState } from '../hooks/useUrlState';

const BASEMAPS: Record<string, { url: string; maxZoom: number }> = {
  satellite: {
    url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    maxZoom: 21,
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
  },
  dark: {
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    maxZoom: 20,
  },
};

export default function MapContainer() {
  const { state, dispatch } = useAppContext();
  const { fetchPoints, fetchPointTimeseries } = usePointsApi();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);

  const [pointData, setPointData] = useState<PointData | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<number | null>(null);
  const [pointCount, setPointCount] = useState<number>(0);

  // Read point viz state from global state (controlled by PointControlsPanel)
  const colorBy = state.pointColorBy;
  const pointVmin = state.pointVmin;
  const pointVmax = state.pointVmax;
  const pointFilter = state.pointFilter;
  const pointBasemap = state.pointBasemap;
  const pointColormap = state.pointColormap;

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          'basemap': {
            type: 'raster',
            tiles: [BASEMAPS.satellite.url],
            tileSize: 256,
            maxzoom: BASEMAPS.satellite.maxZoom,
          }
        },
        layers: [{
          id: 'basemap',
          type: 'raster',
          source: 'basemap',
        }],
      },
      center: (() => {
        const url = parseUrlState();
        if (url.lon && url.lat) return [parseFloat(url.lon), parseFloat(url.lat)] as [number, number];
        return [-99.077, 19.315] as [number, number];
      })(),
      zoom: (() => {
        const url = parseUrlState();
        return url.zoom ? parseFloat(url.zoom) : 12;
      })(),
      maxZoom: 22,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    // Sync viewport to URL
    map.on('moveend', () => {
      const center = map.getCenter();
      const z = map.getZoom();
      const params = new URLSearchParams(window.location.search);
      params.set('lat', center.lat.toFixed(4));
      params.set('lon', center.lng.toFixed(4));
      params.set('zoom', z.toFixed(1));
      window.history.replaceState(null, '', `?${params}`);
    });

    // Add deck.gl overlay
    const deckOverlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });
    map.addControl(deckOverlay as unknown as maplibregl.IControl);
    deckOverlayRef.current = deckOverlay;
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      deckOverlayRef.current = null;
    };
  }, []);

  // Switch basemap tiles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const basemap = BASEMAPS[pointBasemap];
    const source = map.getSource('basemap') as maplibregl.RasterTileSource | undefined;
    if (source) {
      source.setTiles([basemap.url]);
    }
  }, [pointBasemap]);

  // Fit map to data bounds from point layer or raster dataset
  // Skip if URL already specifies a viewport (shared link)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const url = parseUrlState();
    if (url.lat && url.lon && url.zoom) return; // URL has viewport, skip fitBounds

    // Try point layers first (from manifest loaded via state)
    if (state.pointLayerBounds) {
      const [west, south, east, north] = state.pointLayerBounds;
      map.fitBounds([[west, south], [east, north]], { padding: 50 });
      return;
    }

    // Fallback to raster dataset bounds
    if (state.currentDataset && state.datasetInfo[state.currentDataset]) {
      const bounds = state.datasetInfo[state.currentDataset].latlon_bounds;
      map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 50 });
    }
  }, [state.pointLayerBounds, state.currentDataset, state.datasetInfo]);

  // Load points when point layer is available
  useEffect(() => {
    if (!state.activePointLayer) return;

    const loadPoints = async () => {
      try {
        const data = await fetchPoints(state.activePointLayer!, {
          colorBy,
          filter: pointFilter || undefined,
          maxPoints: 200000,
        });
        setPointData(data);
        setPointCount(data.count);

        // Compute histogram for controls panel
        if (data.count > 0) {
          const vals = data.colorValues;
          const min = vals.reduce((a, b) => Math.min(a, b), Infinity);
          const max = vals.reduce((a, b) => Math.max(a, b), -Infinity);
          const nBins = 40;
          const binWidth = (max - min) / nBins || 1;
          const counts = new Array(nBins).fill(0);
          const edges = Array.from({ length: nBins + 1 }, (_, i) => min + i * binWidth);
          for (const v of vals) {
            const idx = Math.min(Math.floor((v - min) / binWidth), nBins - 1);
            counts[idx]++;
          }
          dispatch({ type: 'SET_POINT_HISTOGRAM', payload: { edges, counts } });
        }
      } catch (err) {
        console.error('Error loading points:', err);
      }
    };

    loadPoints();
  }, [state.activePointLayer, colorBy, pointFilter, fetchPoints]);

  // Track which point IDs are currently displayed in the chart
  const clickedPointIds = new Set(state.clickedPoints.map(p => p.pointId));

  // Handle point click → fetch timeseries
  // shiftKey=true adds to selection, ctrlKey=true sets reference point
  const onPointClick = useCallback(async (pointId: number, shiftKey: boolean, ctrlKey: boolean) => {
    if (!state.activePointLayer) return;
    setSelectedPointId(pointId);

    try {
      const ts = await fetchPointTimeseries(state.activePointLayer, pointId);

      if (ctrlKey) {
        // Ctrl+click → set as reference point
        dispatch({ type: 'SET_REFERENCE_POINT', payload: { pointId, timeseries: ts } });
        return;
      }

      // If not shift-clicking, clear previous selections first
      if (!shiftKey) {
        dispatch({ type: 'CLEAR_CLICKED_POINTS' });
      }

      dispatch({
        type: 'SET_CLICKED_POINT_TIMESERIES',
        payload: { pointId, timeseries: ts },
      });
    } catch (err) {
      console.error('Error fetching timeseries:', err);
    }
  }, [state.activePointLayer, fetchPointTimeseries, dispatch]);

  // Update deck.gl layers whenever point data changes
  useEffect(() => {
    const overlay = deckOverlayRef.current;
    if (!overlay) return;

    // If no point data or points layer hidden, clear deck.gl layers
    if (!pointData || !state.pointLayerVisible) {
      overlay.setProps({ layers: [] });
      return;
    }

    const positions = new Float64Array(pointData.count * 2);
    for (let i = 0; i < pointData.count; i++) {
      positions[i * 2] = pointData.lon[i];
      positions[i * 2 + 1] = pointData.lat[i];
    }

    const layer = new ScatterplotLayer({
      id: 'point-cloud',
      data: {
        length: pointData.count,
        attributes: {
          getPosition: { value: positions, size: 2 },
        },
      },
      getPosition: (_, { index }) => [pointData.lon[index], pointData.lat[index]],
      opacity: state.pointOpacity,
      getFillColor: (_, { index }) => {
        const pid = pointData.point_id[index];
        if (pid === state.referencePointId) {
          return [0, 255, 128, 255]; // Green for reference point
        }
        if (clickedPointIds.has(pid)) {
          return [255, 255, 0, 255]; // Yellow for selected/clicked
        }
        const v = pointData.colorValues[index];
        return valueToColor(v, pointVmin, pointVmax, pointColormap);
      },
      getRadius: (_, { index }) => {
        const pid = pointData.point_id[index];
        if (pid === state.referencePointId) return 7;
        if (clickedPointIds.has(pid)) return 5;
        return 3;
      },
      radiusMinPixels: 2,
      radiusMaxPixels: 14,
      pickable: true,
      onClick: (info, event) => {
        if (info.index >= 0) {
          const srcEvent = (event as unknown as { srcEvent?: MouseEvent }).srcEvent;
          const shiftKey = srcEvent?.shiftKey ?? false;
          const ctrlKey = srcEvent?.ctrlKey ?? srcEvent?.metaKey ?? false;
          onPointClick(pointData.point_id[info.index], shiftKey, ctrlKey);
        }
      },
      updateTriggers: {
        getFillColor: [pointVmin, pointVmax, pointColormap, state.referencePointId, ...clickedPointIds],
        getRadius: [state.referencePointId, ...clickedPointIds],
      },
    });

    overlay.setProps({ layers: [layer] });
  }, [pointData, pointVmin, pointVmax, pointColormap, selectedPointId, onPointClick,
      state.pointLayerVisible, state.pointOpacity]);

  // Raster tile layer visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = map.getLayer('raster-layer');
    if (layer) {
      map.setLayoutProperty('raster-layer', 'visibility',
        state.rasterLayerVisible ? 'visible' : 'none');
    }
  }, [state.rasterLayerVisible]);

  // Raster tile layer for V1 datasets
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !state.currentDataset || !state.datasetInfo[state.currentDataset]) return;

    const currentDatasetInfo = state.datasetInfo[state.currentDataset];
    const maxIdx = currentDatasetInfo.x_values.length - 1;
    const timeIdx = Math.max(0, Math.min(state.currentTimeIndex, maxIdx));

    const params: Record<string, string> = {
      variable: state.currentDataset,
      time_idx: timeIdx.toString(),
      rescale: `${state.vmin},${state.vmax}`,
      colormap_name: state.colormap,
    };

    if (currentDatasetInfo.algorithm) {
      params.algorithm = currentDatasetInfo.algorithm;
    }

    if (state.refValues[state.currentDataset] && currentDatasetInfo.algorithm === 'shift') {
      const shift = state.refValues[state.currentDataset][timeIdx];
      if (shift !== undefined) {
        params.algorithm_params = JSON.stringify({ shift });
      }
    }

    if (state.dataMode === 'cog') {
      params.url = currentDatasetInfo.file_list[timeIdx];
      const maskUrl = currentDatasetInfo.mask_file_list[timeIdx];
      if (maskUrl) params.mask = encodeURIComponent(maskUrl);
      if (currentDatasetInfo.mask_min_value !== undefined) {
        params.mask_min_value = currentDatasetInfo.mask_min_value.toString();
      }
    }

    const urlParams = new URLSearchParams(params).toString();
    const endpoint = state.dataMode === 'md' ? 'md' : 'cog';
    const tileUrl = `/${endpoint}/WebMercatorQuad/tiles/{z}/{x}/{y}.png?${urlParams}`;

    // Add or update raster source
    if (map.getSource('raster-tiles')) {
      (map.getSource('raster-tiles') as maplibregl.RasterTileSource).setTiles([tileUrl]);
    } else {
      map.addSource('raster-tiles', {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
      });
      map.addLayer({
        id: 'raster-layer',
        type: 'raster',
        source: 'raster-tiles',
        paint: { 'raster-opacity': state.opacity },
      }, map.getLayer('basemap') ? undefined : undefined);
    }

    // Update opacity
    if (map.getLayer('raster-layer')) {
      map.setPaintProperty('raster-layer', 'raster-opacity', state.opacity);
    }
  }, [state.currentDataset, state.currentTimeIndex, state.datasetInfo, state.dataMode,
      state.refValues, state.colormap, state.vmin, state.vmax, state.opacity]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      {/* Stats overlay */}
      {pointCount > 0 && (
        <div style={{
          position: 'absolute', bottom: 30, left: 10,
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '6px 10px', borderRadius: 4, fontSize: 12,
          zIndex: 10, fontFamily: 'monospace',
        }}>
          {pointCount.toLocaleString()} points | color: {colorBy}
          | [{pointVmin.toFixed(1)}, {pointVmax.toFixed(1)}]
          {state.clickedPoints.length > 0 && ` | ${state.clickedPoints.length} selected`}
          {state.referencePointId != null && ` | ref: ${state.referencePointId}`}
          {state.clickedPoints.length === 0 && ' | click: TS, shift: compare, ctrl: ref'}
        </div>
      )}
    </div>
  );
}
