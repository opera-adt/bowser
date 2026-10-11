/**
 * MapLibre layer plumbing shared by the main map and the split-screen right map:
 * basemaps, the double-buffered data raster, terrain, and where tool overlays sit.
 */
import { useEffect, useRef } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { basemapSource, basemapStack } from '../map/basemapStyle';
import { TERRAIN_SOURCE, TERRAIN_SOURCE_ID, terrainSpec } from '../map/terrain';

/** Tool overlays (profile, measure) stay on top: data layers are inserted below the first one. */
export const OVERLAY_PREFIX = /^(profile|measure)-/;
export function firstOverlayId(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers.find((l: { id: string }) => OVERLAY_PREFIX.test(l.id))?.id;
}

const BASEMAP_IDS = ['basemap-bottom', 'basemap-top'] as const;

/** Primary/secondary basemaps (swap, opacities) at the bottom of the layer stack. */
export function useBasemapLayers(map: maplibregl.Map | null, ready: boolean) {
  const { state } = useAppContext();
  useEffect(() => {
    if (!ready || !map) return;
    const primary = baseMaps[state.selectedBasemap] || baseMaps.esriSatellite;
    const secondary = state.secondaryBasemap ? baseMaps[state.secondaryBasemap] : null;
    const stack = basemapStack(primary, secondary, state.basemapSwapped, state.basemapOpacity,
      state.secondaryBasemapOpacity);
    const firstOther = map.getStyle().layers.find((l: { id: string }) => !BASEMAP_IDS.includes(l.id as typeof BASEMAP_IDS[number]))?.id;
    ([['basemap-bottom', stack.bottom, stack.bottomOpacity], ['basemap-top', stack.top, stack.topOpacity]] as const)
      .forEach(([id, item, opacity]) => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        if (!item) return;
        map.addSource(id, basemapSource(item));
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } }, firstOther);
      });
  }, [ready, map, state.selectedBasemap, state.secondaryBasemap, state.basemapSwapped, state.basemapOpacity,
    state.secondaryBasemapOpacity]);
}

/**
 * The data raster, double-buffered so a new time step never flashes blank: the previous
 * layer stays underneath until the new one has drawn. Bounds keep MapLibre from asking
 * for tiles outside the data (404s, worst when tilted).
 */
export function useDataRaster(
  map: maplibregl.Map | null, ready: boolean, tileUrl: string | null, opacity: number,
  bounds: [number, number, number, number] | null,
) {
  const layerRef = useRef<string | null>(null);
  const nextIdRef = useRef(0);
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    if (!ready || !map) return;
    const previous = layerRef.current;
    if (!tileUrl) {
      if (previous) { map.removeLayer(previous); map.removeSource(previous); layerRef.current = null; }
      return;
    }
    const id = `data-${++nextIdRef.current}`;
    const b = boundsRef.current;
    map.addSource(id, { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 22, ...(b ? { bounds: b } : {}) });
    // Data stays below the tool overlays (profile line etc.).
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacityRef.current,
      'raster-fade-duration': 0 } }, firstOverlayId(map));
    layerRef.current = id;
    if (!previous) return;
    const swap = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId !== id || !map.isSourceLoaded(id)) return;
      map.off('sourcedata', swap);
      if (map.getLayer(previous)) map.removeLayer(previous);
      if (map.getSource(previous)) map.removeSource(previous);
    };
    map.on('sourcedata', swap);
    return () => { map.off('sourcedata', swap); };
  }, [ready, map, tileUrl]);

  useEffect(() => {
    const id = layerRef.current;
    if (ready && map && id && map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', opacity);
  }, [ready, map, opacity, tileUrl]);
}

/** Terrain on/off and exaggeration. */
export function applyTerrain(map: maplibregl.Map, enabled: boolean, exaggeration: number) {
  if (enabled && !map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
  map.setTerrain(terrainSpec(enabled, exaggeration));
  // MapLibre 6 rebuilds the terrain (reading the new exaggeration) but schedules no
  // frame, so without this the slider only shows after the next pan or zoom.
  map.triggerRepaint();
}
