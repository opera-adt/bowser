/**
 * Basemaps as MapLibre raster sources.
 *
 * basemap.ts keeps the Leaflet-style URL templates (one place for both maps).
 * MapLibre has no ``{s}`` subdomain placeholder, so those templates expand to one
 * URL per subdomain. Pinned by basemapStyle.test.ts.
 */
import type { BaseMapItem } from '../types';
import { esriTileUrl } from './esriTiles';

const SUBDOMAINS = ['a', 'b', 'c'];

/** How far either map lets the user zoom in (the data raster serves tiles this deep). */
export const MAP_MAX_ZOOM = 22;
/** Native zoom for basemaps that do not set ``maxNativeZoom``. */
export const DEFAULT_BASEMAP_NATIVE_ZOOM = 19;

export function basemapNativeZoom(item: BaseMapItem): number {
  return item.maxNativeZoom ?? DEFAULT_BASEMAP_NATIVE_ZOOM;
}

export function basemapTiles(url: string): string[] {
  return url.includes('{s}') ? SUBDOMAINS.map(s => url.replace('{s}', s)) : [url];
}

export interface RasterSource {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  attribution: string;
  maxzoom: number;
}

/**
 * ``maxzoom`` is the provider's native max, so MapLibre overzooms past it. Esri's
 * tiles go through ``esritiles://`` (esriTiles.ts), so a place where they end
 * sooner shows the last real tiles, not Esri's "Map data not yet available" image.
 */
export function basemapSource(item: BaseMapItem): RasterSource {
  return {
    type: 'raster', tiles: basemapTiles(item.url).map(esriTileUrl), tileSize: 256, attribution: item.attribution,
    maxzoom: basemapNativeZoom(item),
  };
}

/**
 * Leaflet TileLayer zoom props: request tiles up to the native max, upscale them beyond.
 * Basemaps without a ``maxNativeZoom`` keep requesting every zoom, as before.
 */
export function basemapLeafletZoom(item: BaseMapItem): { maxZoom: number; maxNativeZoom?: number } {
  return item.maxNativeZoom === undefined
    ? { maxZoom: MAP_MAX_ZOOM }
    : { maxZoom: MAP_MAX_ZOOM, maxNativeZoom: item.maxNativeZoom };
}

/** Bottom/top basemap and their opacities, honouring the "swapped" toggle (as in the Leaflet map). */
export function basemapStack(
  primary: BaseMapItem,
  secondary: BaseMapItem | null,
  swapped: boolean,
  primaryOpacity: number,
  secondaryOpacity: number,
): { bottom: BaseMapItem | null; top: BaseMapItem | null; bottomOpacity: number; topOpacity: number } {
  return swapped
    ? { bottom: secondary, top: primary, bottomOpacity: secondaryOpacity, topOpacity: primaryOpacity }
    : { bottom: primary, top: secondary, bottomOpacity: primaryOpacity, topOpacity: secondaryOpacity };
}
