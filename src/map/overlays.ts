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

type Charted = { color: string; geometry?: { coordinates: unknown }; source?: { overlayId: string; index: number } };

/**
 * The chart colour of each of a vector layer's features that is in the time-series chart (an
 * area or a point taken from it), by feature index. A shape drawn for + Area has no source; it
 * is found among the Drawings by its geometry (drawn shapes can be reordered by the editor).
 */
export function chartedFeatureColors(o: Overlay, charted: Charted[]): Map<number, string> {
  const out = new Map<number, string>();
  if (o.type !== 'vector' || !o.data) return out;
  const features = o.data.features as Array<{ geometry?: { coordinates?: unknown } | null }>;
  for (const c of charted) {
    if (c.source?.overlayId === o.id && o.id !== DRAWINGS_ID) {
      if (c.source.index < features.length) out.set(c.source.index, c.color);
    } else if (o.id === DRAWINGS_ID) {
      const i = drawingIndexOf(c, o.data);
      if (i >= 0) out.set(i, c.color);
    }
  }
  return out;
}

type DrawingFeature = { id?: unknown; geometry?: { coordinates?: unknown } | null; properties?: Record<string, unknown> | null };

type Position = number[];

/** A closed ring with its vertices from the smallest one, counter-clockwise (by the shoelace sign). */
function canonicalRing(ring: Position[]): Position[] {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  let pts = closed ? ring.slice(0, -1) : ring.slice();
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) pts = pts.reverse();
  let start = 0;
  pts.forEach((p, i) => { if (p[0] < pts[start][0] || (p[0] === pts[start][0] && p[1] < pts[start][1])) start = i; });
  return [...pts.slice(start), ...pts.slice(0, start)];
}

/**
 * A key that is the same for the same shape however its rings are written: the editor hands
 * shapes back with their rings reversed (and may start them at another vertex), and a polygon
 * may come back as a one-part MultiPolygon.
 */
export function shapeKey(geometry: { type?: string; coordinates?: unknown } | null | undefined): string {
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return JSON.stringify(c ?? null);
  const isRing = (r: unknown) => Array.isArray(r) && Array.isArray(r[0]) && typeof (r[0] as unknown[])[0] === 'number';
  const isPolygon = (p: unknown) => Array.isArray(p) && p.length > 0 && p.every(isRing);
  const polygons: unknown[] | null = isPolygon(c) ? [c] : (c.length > 0 && c.every(isPolygon) ? c : null);
  if (!polygons) return JSON.stringify(c);
  return JSON.stringify(polygons.map(p => (p as Position[][]).map(canonicalRing)));
}

/**
 * The drawn shape an area stands for (one drawn for + Area, or picked from the Drawings): found
 * by its shape (shapeKey), since the editor may reorder shapes and rewrite their rings; -1 when
 * it is not a drawing.
 */
export function drawingIndexOf(
  area: { geometry?: { coordinates: unknown }; source?: { overlayId: string } },
  drawings: OverlayFeatures | undefined,
): number {
  if (!drawings || !area.geometry || (area.source && area.source.overlayId !== DRAWINGS_ID)) return -1;
  const shape = shapeKey(area.geometry);
  return (drawings.features as DrawingFeature[]).findIndex(f => shapeKey(f?.geometry) === shape);
}

/** A drawn shape's name (its ``name`` property), or "" when it has none. */
export function drawingName(f: unknown): string {
  const name = (f as DrawingFeature)?.properties?.name;
  return typeof name === 'string' ? name : '';
}

/** The drawings with shape ``index`` named ``name`` (an empty name clears it). */
export function renameDrawing(data: OverlayFeatures, index: number, name: string): OverlayFeatures {
  return {
    ...data,
    features: (data.features as DrawingFeature[]).map((f, i) => {
      if (i !== index) return f;
      const { name: _old, ...rest } = f.properties ?? {};
      return { ...f, properties: name ? { ...rest, name } : rest };
    }),
  };
}

/**
 * Names carried over to the editor's new feature collection: the editor keeps a shape's id
 * (and its geometry when it only moved in the list), not always the properties we added.
 */
function carryNames(old: OverlayFeatures | undefined, next: OverlayFeatures): OverlayFeatures {
  if (!old) return next;
  const before = old.features as DrawingFeature[];
  const key = (f: DrawingFeature) => (f.id !== undefined && f.id !== null ? `id:${String(f.id)}` : null);
  const byId = new Map(before.flatMap(f => (key(f) && drawingName(f) ? [[key(f)!, drawingName(f)]] : [])));
  const byShape = new Map(before.flatMap(f => (drawingName(f) ? [[shapeKey(f.geometry), drawingName(f)]] : [])));
  return {
    ...next,
    features: (next.features as DrawingFeature[]).map(f => {
      if (drawingName(f)) return f;
      const name = (key(f) && byId.get(key(f)!)) || byShape.get(shapeKey(f.geometry));
      return name ? { ...f, properties: { ...(f.properties ?? {}), name } } : f;
    }),
  };
}

/** The layer colour, with each charted feature (by its generated id, the feature index) in its chart colour. */
export function linkedColor(base: unknown, charted: Map<number, string>): unknown {
  if (charted.size === 0) return base;
  return ['match', ['id'], ...[...charted].sort((a, b) => a[0] - b[0]).flat(), base];
}

/**
 * The MapLibre layers of a vector overlay: polygons get a fill and an outline. ``charted`` (from
 * chartedFeatureColors) draws the features in the chart in their chart colour; the source needs
 * ``generateId`` so a feature's id is its index.
 */
export function vectorLayerSpecs(o: Overlay, charted: Map<number, string> = new Map()): VectorLayerSpec[] {
  const id = `overlay-${o.id}`;
  const base: unknown = o.classColors ? classColorExpression(o.classColors, o.color ?? '#a3a3a3') : o.color ?? '#5bc0be';
  const color = linkedColor(base, charted);
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
export function withDrawings(overlays: Overlay[], incoming: OverlayFeatures): Overlay[] {
  const existing = overlays.find(o => o.id === DRAWINGS_ID);
  const data = carryNames(existing?.data, incoming);
  if (!data.features.length) return existing ? overlays.filter(o => o.id !== DRAWINGS_ID) : overlays;
  if (existing) return overlays.map(o => (o.id === DRAWINGS_ID ? { ...o, data, bounds: featureBounds(data) } : o));
  return [...overlays, {
    id: DRAWINGS_ID, name: 'Drawings', type: 'vector', visible: true, opacity: 1, aboveData: true,
    data, bounds: featureBounds(data), color: '#f59e0b', lineWidth: 2, pointRadius: 5,
  }];
}
