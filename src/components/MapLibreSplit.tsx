/**
 * Split screen on the MapLibre map. MapLibre can't clip a single layer, so (as
 * maplibre-gl-compare does) a second, passive map sits on top of the main one, clipped
 * to the right of the divider: the same basemaps and terrain, the right-panel dataset,
 * the user overlays set to show on the right, and a copy of the tool overlays (profile,
 * measure, buffer circles). It follows the main map's camera
 * and takes no input, so clicks, drags and pixel inspect stay on the main map (which
 * already knows which side the cursor is on). Main-map markers and popups are raised
 * above it in CSS (.split-active).
 */
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../context/AppContext';
import { useRasterTileUrl } from '../map/useRasterTileUrl';
import { OVERLAY_PREFIX, applyTerrain, useBasemapLayers, useDataRaster, useOverlayLayers } from './maplibreLayers';
import SplitDivider from './SplitDivider';

const EMPTY_STYLE: maplibregl.StyleSpecification = { version: 8, sources: {}, layers: [] };

function follow(main: maplibregl.Map, right: maplibregl.Map) {
  right.jumpTo({ center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch() });
}

/** Copy the main map's tool-overlay sources and layers onto the right map. */
export function mirrorOverlays(main: maplibregl.Map, right: maplibregl.Map) {
  const style = main.getStyle();
  style.layers.forEach(l => {
    if (!OVERLAY_PREFIX.test(l.id) || !('source' in l) || typeof l.source !== 'string') return;
    const spec = style.sources[l.source];
    const src = right.getSource(l.source) as maplibregl.GeoJSONSource | undefined;
    if (!src) right.addSource(l.source, spec);
    else if (spec.type === 'geojson' && typeof spec.data !== 'string') src.setData(spec.data);
    if (!right.getLayer(l.id)) right.addLayer(l);
  });
}

export default function MapLibreSplit({ main, mainReady, terrain }: {
  main: maplibregl.Map | null;
  mainReady: boolean;
  terrain: { enabled: boolean; exaggeration: number };
}) {
  const { state } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!mainReady || !main || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current, style: EMPTY_STYLE, interactive: false, attributionControl: false,
      center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch(),
    });
    map.on('load', () => setReady(true));
    setRight(map);
    return () => { map.remove(); setRight(null); setReady(false); };
  }, [main, mainReady]);

  // Follow the main camera; copy the tool overlays whenever they change.
  useEffect(() => {
    if (!ready || !right || !main) return;
    follow(main, right);
    mirrorOverlays(main, right);
    const onMove = () => follow(main, right);
    // Style changes (a layer added) and overlay source updates; not tile loads.
    const onData = (e: maplibregl.MapSourceDataEvent | maplibregl.MapStyleDataEvent) => {
      if (e.dataType === 'style' || (!e.tile && e.sourceId && !/^(data|basemap)-/.test(e.sourceId))) mirrorOverlays(main, right);
    };
    main.on('move', onMove);
    main.on('data', onData);
    return () => { main.off('move', onMove); main.off('data', onData); };
  }, [ready, right, main]);

  useEffect(() => {
    if (ready && right) applyTerrain(right, terrain.enabled, terrain.exaggeration);
  }, [ready, right, terrain.enabled, terrain.exaggeration]);

  useBasemapLayers(right, ready);
  useOverlayLayers(right, ready, 'right');
  const tileUrl = useRasterTileUrl({
    dataset: state.splitDataset ?? undefined, colormap: state.splitColormap, vmin: state.splitVmin,
    vmax: state.splitVmax, timeIndex: state.splitTimeIndex,
  });
  const info = state.splitDataset ? state.datasetInfo[state.splitDataset] : undefined;
  // Like the Leaflet map: no right-panel dataset chosen = basemap only on the right.
  useDataRaster(right, ready, state.splitDataset ? tileUrl : null, state.splitOpacity, info?.latlon_bounds ?? null);

  return (
    <>
      <div data-testid="maplibre-split" style={{
        position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        clipPath: `inset(0 0 0 ${(state.splitPosition * 100).toFixed(2)}%)`,
      }}>
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      </div>
      <SplitDivider />
    </>
  );
}
