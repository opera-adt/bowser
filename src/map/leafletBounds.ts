import type { RasterGroup } from '../types';

/** Leaflet's [[south, west], [north, east]] from a layer's [west, south, east, north]. */
export type LeafletBounds = [[number, number], [number, number]];

/**
 * Where a layer's data is, for Leaflet: the named layer, else the first layer.
 * The Leaflet map opens on these bounds (as the MapLibre map does), and the
 * raster tile layer gets them so it doesn't ask for tiles outside the cube.
 */
export function layerLeafletBounds(
  name: string | undefined, layers: { [key: string]: RasterGroup },
): LeafletBounds | null {
  const info = (name && layers[name]) || Object.values(layers)[0];
  const b = info?.latlon_bounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [west, south, east, north] = b;
  return [[south, west], [north, east]];
}
