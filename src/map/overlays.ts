/**
 * User raster overlays (uploaded GeoTIFF tiled by our /overlay titiler, or an external
 * WMS / WMTS / XYZ service): their tile URLs and which map shows them. Shared by the
 * Leaflet and MapLibre maps; pinned by overlays.test.ts.
 */
import type { Overlay } from '../types';

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
