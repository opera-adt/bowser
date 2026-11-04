/**
 * Basemaps as MapLibre raster sources.
 *
 * basemap.ts keeps the Leaflet-style URL templates (one place for both maps).
 * MapLibre has no ``{s}`` subdomain placeholder, so those templates expand to one
 * URL per subdomain. Pinned by basemapStyle.test.ts.
 */
import type { BaseMapItem } from '../types';

const SUBDOMAINS = ['a', 'b', 'c'];

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

export function basemapSource(item: BaseMapItem): RasterSource {
  return { type: 'raster', tiles: basemapTiles(item.url), tileSize: 256, attribution: item.attribution, maxzoom: 19 };
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
