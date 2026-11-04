/**
 * User raster overlays (uploaded GeoTIFF tiled by our /overlay titiler, or an external
 * WMS / WMTS / XYZ service): their tile URLs and which map shows them. Shared by the
 * Leaflet and MapLibre maps; pinned by overlays.test.ts.
 */
import type { Overlay, OverlayFeatures } from '../types';
import { featureBounds } from './fileParsers';
import { classColorExpression } from './soilClasses';
import { MARKER_IMAGE_RADIUS, markerImageId } from './markers';

export function hexToRgba(hex: string): [number, number, number, number] {
  const h = (hex || '#000000').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
}

/** XYZ template for an uploaded GeoTIFF: RGB, continuous colormap, or discrete bins. */
export function geotiffTileUrl(o: Overlay): string {
  const vmin = o.vmin ?? 0, vmax = o.vmax ?? 1, nbins = o.nbins ?? 5;
  const binColors = o.binColors ?? [];
  // Force PNG so areas outside the raster footprint are transparent.
  // Without an extension titiler may emit JPEG (no alpha) → opaque black
  // covering the whole map.
  const base = `/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(o.path ?? '')}`;
  // A colormap needs one band: always read band 1 (whose stats set vmin/vmax), so a
  // 2-band file (e.g. value + weights) doesn't fail with "Source data must be 1 band".
  const cmapBase = `${base}&bidx=1`;
  if (o.mode === 'cmap' && o.discrete) {
    const step = (vmax - vmin) / nbins;
    const intervals = Array.from({ length: nbins }, (_, k) => {
      const lo = vmin + k * step;
      const hi = k === nbins - 1 ? vmax + Math.abs(step) * 1e-3 + 1e-9 : vmin + (k + 1) * step;
      return [[lo, hi], hexToRgba(binColors[k])];
    });
    return `${cmapBase}&colormap=${encodeURIComponent(JSON.stringify(intervals))}`;
  }
  if (o.mode === 'cmap') return `${cmapBase}&colormap_name=${encodeURIComponent(o.cmap ?? 'viridis')}&rescale=${vmin},${vmax}`;
  return base;
}

/** What changes the rendered tiles (beyond the URL itself): a change remounts the layer. */
export function overlayVizKey(o: Overlay): string {
  if (o.type !== 'geotiff') return o.type;
  const nbins = o.nbins ?? 5;
  return o.mode === 'cmap' ? (o.discrete ? `d${nbins}:${(o.binColors ?? []).join('')}` : (o.cmap ?? '')) : 'rgb';
}

/**
 * WMS GetMap as an XYZ template (MapLibre fills in {bbox-epsg-3857}), with the same
 * parameters Leaflet's WMS layer sends by default.
 */
export function wmsTileUrl(o: Overlay): string {
  const base = o.url ?? '';
  const q = new URLSearchParams({
    service: 'WMS', request: 'GetMap', version: '1.1.1', layers: o.wmsLayers ?? '', styles: '',
    format: 'image/png', transparent: 'true', width: '256', height: '256', srs: 'EPSG:3857',
  }).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${q}&bbox={bbox-epsg-3857}`;
}

/** The tile source for MapLibre: past `maxzoom` it upsamples instead of requesting missing tiles. */
export function overlaySource(o: Overlay): { tiles: string[]; maxzoom: number } {
  if (o.type === 'wms') return { tiles: [wmsTileUrl(o)], maxzoom: o.maxNativeZoom ?? 22 };
  if (o.type === 'wmts') return { tiles: [o.url ?? ''], maxzoom: o.maxNativeZoom ?? 22 };
  return { tiles: [geotiffTileUrl(o)], maxzoom: 22 };
}

/**
 * Whether an overlay is drawn on a map. Without split screen only the main map exists;
 * in split screen the main map is what shows left of the divider and the right map what
 * shows right of it, so `side` picks one or both.
 */
export function overlayOnMap(o: Overlay, splitScreen: boolean, map: 'main' | 'right'): boolean {
  if (!o.visible) return false;
  const side = o.side ?? 'both';
  if (!splitScreen) return map === 'main';
  return side === 'both' || (side === 'left' ? map === 'main' : map === 'right');
}

/** The fixed row in the layer list that stands for the data layer. */
export const DATA_ROW = '__data__';

/** The layer list, top of the map first: overlays above the data, the data, overlays below it. */
export function overlayRows(overlays: Overlay[]): string[] {
  const top = (above: boolean) => overlays.filter(o => !!o.aboveData === above).map(o => o.id).reverse();
  return [...top(true), DATA_ROW, ...top(false)];
}

/**
 * The overlays after dragging one onto a row of the list (above or below it). Passing the
 * data row decides which side of the data the overlay is drawn on.
 */
export function reorderOverlays(overlays: Overlay[], dragged: string, target: string, below: boolean): Overlay[] {
  if (dragged === DATA_ROW || dragged === target) return overlays;
  const rows = overlayRows(overlays).filter(id => id !== dragged);
  const at = rows.indexOf(target);
  if (at < 0 || !overlays.some(o => o.id === dragged)) return overlays;
  rows.splice(at + (below ? 1 : 0), 0, dragged);
  const dataAt = rows.indexOf(DATA_ROW);
  return rows
    .map((id, i) => ({ id, aboveData: i < dataAt }))
    .filter(r => r.id !== DATA_ROW)
    .reverse()
    .map(r => ({ ...overlays.find(o => o.id === r.id)!, aboveData: r.aboveData }));
}

const POLYGONS = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const LINES = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]];
const POINTS = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];

export interface VectorLayerSpec {
  id: string;
  type: 'fill' | 'line' | 'circle' | 'symbol';
  filter: unknown[];
  paint: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

/** The MapLibre layers of a vector overlay: polygons get a fill and an outline. */
export function vectorLayerSpecs(o: Overlay): VectorLayerSpec[] {
  const id = `overlay-${o.id}`;
  const color: unknown = o.classColors ? classColorExpression(o.classColors, o.color ?? '#a3a3a3') : o.color ?? '#5bc0be';
  return [
    { id: `${id}-fill`, type: 'fill', filter: POLYGONS, paint: { 'fill-color': color, 'fill-opacity': o.opacity * 0.25 } },
    { id: `${id}-line`, type: 'line', filter: LINES, paint: { 'line-color': color, 'line-opacity': o.opacity, 'line-width': o.lineWidth ?? 2 } },
    pointSpec(`${id}-point`, o, color),
  ];
}

/**
 * Points as circles (the default), or as a marker shape: an icon (markers.ts) recoloured with
 * the layer colour, sized so its radius matches the point size, with a white edge like the circles.
 */
function pointSpec(id: string, o: Overlay, color: unknown): VectorLayerSpec {
  const radius = o.pointRadius ?? 5;
  if (!o.marker || o.marker === 'circle') {
    return { id, type: 'circle', filter: POINTS, paint: {
      'circle-color': color, 'circle-opacity': o.opacity, 'circle-radius': radius,
      'circle-stroke-color': '#ffffff', 'circle-stroke-opacity': o.opacity, 'circle-stroke-width': 1,
    } };
  }
  return {
    id, type: 'symbol', filter: POINTS,
    layout: {
      'icon-image': markerImageId(o.marker), 'icon-size': radius / MARKER_IMAGE_RADIUS,
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      ...(o.marker === 'pin' ? { 'icon-anchor': 'bottom' } : {}),
    },
    paint: { 'icon-color': color, 'icon-opacity': o.opacity, 'icon-halo-color': '#ffffff', 'icon-halo-width': 1 },
  };
}

/** The overlay that holds what was drawn with the drawing tools. */
export const DRAWINGS_ID = 'drawings';

/** The overlays with the drawings replaced: added on the first shape, removed with the last. */
export function withDrawings(overlays: Overlay[], data: OverlayFeatures): Overlay[] {
  const existing = overlays.find(o => o.id === DRAWINGS_ID);
  if (!data.features.length) return existing ? overlays.filter(o => o.id !== DRAWINGS_ID) : overlays;
  if (existing) return overlays.map(o => (o.id === DRAWINGS_ID ? { ...o, data, bounds: featureBounds(data) } : o));
  return [...overlays, {
    id: DRAWINGS_ID, name: 'Drawings', type: 'vector', visible: true, opacity: 1, aboveData: true,
    data, bounds: featureBounds(data), color: '#f59e0b', lineWidth: 2, pointRadius: 5,
  }];
}
