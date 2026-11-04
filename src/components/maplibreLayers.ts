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
import { overlayOnMap, overlaySource } from '../map/overlays';
import { bufferFeatures } from '../map/buffers';

/**
 * Tool overlays (profile, measure, buffer circles) stay on top: data layers are inserted
 * below the first one, and split screen copies them onto the right map.
 */
export const OVERLAY_PREFIX = /^(profile|measure|buffer)-/;
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
    // Drop *every* older data layer, not just the last one: a change made before the
    // previous swap happened (scrubbing time, toggling a mask) must not leave a layer
    // behind, or it shows through the new layer's transparent (masked / nodata) pixels.
    const swap = () => {
      if (!map.getSource(id) || !map.isSourceLoaded(id)) return;
      map.off('sourcedata', swap);
      map.off('idle', swap);
      map.getStyle().layers.filter((l: { id: string }) => l.id.startsWith('data-') && l.id !== id).forEach(l => {
        map.removeLayer(l.id);
        if (map.getSource(l.id)) map.removeSource(l.id);
      });
    };
    map.on('sourcedata', swap);
    map.on('idle', swap);   // sourcedata can arrive before the source counts as loaded
    return () => { map.off('sourcedata', swap); map.off('idle', swap); };
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

/** MapLibre fetches tiles from a worker, so same-origin paths (/overlay/...) need the origin. */
function absolute(url: string): string {
  return url.startsWith('/') ? `${window.location.origin}${url}` : url;
}

/**
 * User raster overlays between the basemap and the data, in list order (first = bottom).
 * `which` is the main map or the split-screen right map (see overlayOnMap).
 */
export function useOverlayLayers(map: maplibregl.Map | null, ready: boolean, which: 'main' | 'right') {
  const { state } = useAppContext();
  const keysRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!ready || !map) return;
    const want = state.overlays.filter(o => overlayOnMap(o, state.splitScreen, which)).map(o => {
      const src = overlaySource(o);
      return { id: `overlay-${o.id}`, src: { ...src, tiles: src.tiles.map(absolute) }, opacity: o.opacity };
    });
    const keys = keysRef.current;
    // Drop overlays that went away or whose tiles changed.
    for (const [id, key] of [...keys]) {
      const w = want.find(x => x.id === id);
      if (w && JSON.stringify(w.src) === key) continue;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
      keys.delete(id);
    }
    // Add the new ones, then stack them in list order just under the data / tools.
    const anchor = () => map.getStyle().layers.find((l: { id: string }) => l.id.startsWith('data-') || OVERLAY_PREFIX.test(l.id))?.id;
    for (const w of want) {
      if (!keys.has(w.id)) {
        map.addSource(w.id, { type: 'raster', tileSize: 256, ...w.src });
        map.addLayer({ id: w.id, type: 'raster', source: w.id, paint: { 'raster-opacity': w.opacity } }, anchor());
        keys.set(w.id, JSON.stringify(w.src));
      }
      map.setPaintProperty(w.id, 'raster-opacity', w.opacity);
      map.moveLayer(w.id, anchor());
    }
  }, [ready, map, which, state.overlays, state.splitScreen]);
}

/** Buffer circles around time-series points and the reference point (dashed, faint fill). */
export function useBufferCircles(map: maplibregl.Map | null, ready: boolean) {
  const { state } = useAppContext();
  useEffect(() => {
    if (!ready || !map || map.getSource('buffer-circles')) return;
    map.addSource('buffer-circles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'buffer-fill', type: 'fill', source: 'buffer-circles',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 } });
    // Leaflet's dashArray '4 3' at weight 1.5, in line widths.
    map.addLayer({ id: 'buffer-line', type: 'line', source: 'buffer-circles',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [4 / 1.5, 3 / 1.5] } });
  }, [ready, map]);
  const data = bufferFeatures(state);
  const key = JSON.stringify(data);
  useEffect(() => {
    const src = map?.getSource('buffer-circles') as maplibregl.GeoJSONSource | undefined;
    if (ready && src) src.setData(data);
  }, [ready, map, key]);  // eslint-disable-line react-hooks/exhaustive-deps
}
