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
import { chartedFeatureColors, DRAWINGS_ID, overlayOnMap, overlaySource, vectorLayerSpecs } from '../map/overlays';
import { contextLayerSpec, OFM_ATTRIBUTION, OFM_TILEJSON } from '../map/contextLayers';
import { pmtilesVectorSpecs } from '../map/pmtiles';
import { ensureMarker } from '../map/markers';
import type { Overlay } from '../types';
import { bufferFeatures } from '../map/buffers';

/**
 * Tool overlays (profile, measure, buffer circles) stay on top: data layers are inserted
 * below the first one, and split screen copies them onto the right map.
 */
export const OVERLAY_PREFIX = /^(profile|measure|buffer)-/;
export function firstOverlayId(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers.find((l: { id: string }) => OVERLAY_PREFIX.test(l.id))?.id;
}

/** Data layers go below tool overlays and below user overlays drawn above the data. */
function firstAboveDataId(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers.find((l: { id: string; metadata?: unknown }) =>
    OVERLAY_PREFIX.test(l.id) || (l.metadata as { aboveData?: boolean } | undefined)?.aboveData)?.id;
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
      'raster-fade-duration': 0 } }, firstAboveDataId(map));
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

/** The MapLibre layers of an overlay, to stack together. */
function overlayLayerIds(o: Overlay): string[] {
  if (o.type === 'vector') return vectorLayerSpecs(o).map(l => l.id);
  if (o.pmtilesKind === 'vector') return pmtilesVectorSpecs(o).map(l => l.id);
  return [`overlay-${o.id}`];
}

/** What needs the source and layers rebuilt; paint changes are applied in place. */
function overlayKey(o: Overlay): string {
  const src = o.type === 'vector' || o.type === 'context' ? '' : o.type === 'pmtiles' ? o.url ?? '' : JSON.stringify(overlaySource(o));
  // A marker other than a circle is a symbol layer, so changing it rebuilds the layers.
  return `${src}:${!!o.aboveData}:${o.marker && o.marker !== 'circle' ? 'symbol' : 'circle'}`;
}

/**
 * User overlays in list order (first = bottom), each below or above the data, always under
 * the tools. `which` is the main map or the split-screen right map (see overlayOnMap).
 */
export function useOverlayLayers(map: maplibregl.Map | null, ready: boolean, which: 'main' | 'right') {
  const { state } = useAppContext();
  const builtRef = useRef(new Map<string, { key: string; layers: string[] }>());
  // Features in the chart (areas and points from a layer) are drawn in their chart colour.
  const charted = [...(state.chartAreas ?? []), ...(state.timeSeriesPoints ?? [])];
  const chartedKey = JSON.stringify(charted.map(c => [c.color, c.source, 'geometry' in c && !c.source ? c.geometry : null]));
  useEffect(() => {
    if (!ready || !map) return;
    // While drawing, Geoman draws the shapes itself.
    const want = state.overlays.filter(o => overlayOnMap(o, state.splitScreen, which)
      && !(state.drawingEnabled && o.id === DRAWINGS_ID));
    const built = builtRef.current;
    // Drop overlays that went away or whose source or side changed.
    for (const [source, entry] of [...built]) {
      const o = want.find(x => `overlay-${x.id}` === source);
      if (o && overlayKey(o) === entry.key) continue;
      entry.layers.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(source)) map.removeSource(source);
      built.delete(source);
    }
    const belowData = () => map.getStyle().layers.find((l: { id: string }) => l.id.startsWith('data-'))?.id ?? firstAboveDataId(map);
    // Add the new ones, then stack them in list order just under their anchor.
    for (const o of want) {
      const source = `overlay-${o.id}`;
      const metadata = { aboveData: !!o.aboveData };
      const anchor = () => (o.aboveData ? firstOverlayId(map) : belowData());
      if (!built.has(source)) {
        if (o.type === 'vector') {
          // generateId: a feature's id is its index, so charted features can take their chart colour.
          map.addSource(source, { type: 'geojson', generateId: true, data: (o.data ?? { type: 'FeatureCollection', features: [] }) as never });
          if (o.marker && o.marker !== 'circle') ensureMarker(map, o.marker);
          for (const l of vectorLayerSpecs(o)) {
            map.addLayer({ id: l.id, type: l.type, source, filter: l.filter, paint: l.paint, ...(l.layout ? { layout: l.layout } : {}), metadata } as never, anchor());
          }
        } else if (o.type === 'pmtiles') {
          const url = `pmtiles://${o.url}`;
          if (o.pmtilesKind === 'vector') {
            map.addSource(source, { type: 'vector', url, ...(o.attribution ? { attribution: o.attribution } : {}) });
            if (o.marker && o.marker !== 'circle') ensureMarker(map, o.marker);
            for (const l of pmtilesVectorSpecs(o)) {
              map.addLayer({ id: l.id, type: l.type, source, 'source-layer': l.sourceLayer, filter: l.filter, paint: l.paint,
                ...(l.layout ? { layout: l.layout } : {}), metadata } as never, anchor());
            }
          } else {
            map.addSource(source, { type: 'raster', url, tileSize: 256, ...(o.attribution ? { attribution: o.attribution } : {}) });
            map.addLayer({ id: source, type: 'raster', source, paint: { 'raster-opacity': o.opacity }, metadata }, anchor());
          }
        } else if (o.type === 'context') {
          const l = contextLayerSpec(o);
          map.addSource(source, { type: 'vector', url: OFM_TILEJSON, attribution: OFM_ATTRIBUTION });
          map.addLayer({ id: l.id, type: l.type, source, 'source-layer': l.sourceLayer, paint: l.paint, metadata,
            ...(l.filter ? { filter: l.filter } : {}), ...(l.minzoom ? { minzoom: l.minzoom } : {}) } as never, anchor());
        } else {
          const src = overlaySource(o);
          // With bounds, MapLibre doesn't ask for tiles outside the raster (404s).
          map.addSource(source, { type: 'raster', tileSize: 256, ...src, tiles: src.tiles.map(absolute),
            ...(o.bounds ? { bounds: o.bounds } : {}), ...(o.attribution ? { attribution: o.attribution } : {}) });
          map.addLayer({ id: source, type: 'raster', source, paint: { 'raster-opacity': o.opacity }, metadata }, anchor());
        }
        built.set(source, { key: overlayKey(o), layers: overlayLayerIds(o) });
      }
      if (o.type === 'vector') {
        for (const l of vectorLayerSpecs(o, chartedFeatureColors(o, charted))) {
          for (const [prop, value] of Object.entries(l.paint)) map.setPaintProperty(l.id, prop as never, value as never);
          for (const [prop, value] of Object.entries(l.layout ?? {})) map.setLayoutProperty(l.id, prop as never, value as never);
        }
      } else if (o.pmtilesKind === 'vector') {
        for (const l of pmtilesVectorSpecs(o)) {
          for (const [prop, value] of Object.entries(l.paint)) map.setPaintProperty(l.id, prop as never, value as never);
          for (const [prop, value] of Object.entries(l.layout ?? {})) map.setLayoutProperty(l.id, prop as never, value as never);
        }
      } else if (o.type === 'context') {
        for (const [prop, value] of Object.entries(contextLayerSpec(o).paint)) map.setPaintProperty(source, prop as never, value as never);
      } else {
        map.setPaintProperty(source, 'raster-opacity', o.opacity);
      }
      overlayLayerIds(o).forEach(id => map.moveLayer(id, anchor()));
    }
  }, [ready, map, which, state.overlays, state.splitScreen, state.drawingEnabled, chartedKey]);
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
