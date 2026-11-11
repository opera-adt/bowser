/**
 * Elevation models (DEMs) as overlays: a single-band GeoTIFF drawn as a hillshade and/or
 * colour relief, by the /overlay tiler's ``dem`` algorithm, above the basemap and below
 * the data. It is added like any raster (map/addData.ts), from the COG the server makes;
 * one the server takes for elevation starts as a DEM, and any single-band raster can be
 * made one ("Use as DEM"). Shared by the MapLibre and Leaflet maps; pinned by dem.test.ts.
 */
import type { Overlay, OverlayDem } from '../types';

export type DemStyle = OverlayDem['style'];

export const DEM_STYLES: { value: DemStyle; label: string }[] = [
  { value: 'both', label: 'Hillshade and colour' },
  { value: 'hillshade', label: 'Hillshade' },
  { value: 'relief', label: 'Colour relief' },
];

/** Elevation colours: rio-tiler's Schwarzwald runs green, brown, grey, white (no sea blue). */
export const DEM_CMAP = 'schwarzwald';
export const EXAGGERATION_MIN = 0.5;
export const EXAGGERATION_MAX = 20;
/** Lidar of flat ground shows little at 1×; 2× brings out levees, ditches and terraces. */
export const DEM_EXAGGERATION = 2;
/** A new DEM's settings; ``base`` is a low height of it (its 2nd percentile). */
export function newDem(base?: number): OverlayDem {
  return { style: 'both', exaggeration: DEM_EXAGGERATION, ...(base !== undefined ? { base } : {}) };
}

/**
 * The updates that make a single-band raster a DEM ("Use as DEM", or one the server
 * recognised): DEM settings, elevation colours over its 2–98 % range, under the data.
 */
export function asDem(o: Overlay): Partial<Overlay> {
  const b = o.bands?.[0];
  const lo = b?.p2 ?? b?.min, hi = b?.p98 ?? b?.max;
  return {
    dem: newDem(lo), cmap: DEM_CMAP, aboveData: false,
    ...(lo !== undefined && hi !== undefined ? { vmin: lo, vmax: hi } : {}),
  };
}

/** The ``algorithm_params`` of a DEM tile (TiTiler reads them as JSON). */
export function demParams(o: Overlay): Record<string, unknown> {
  const d = o.dem!;
  return {
    style: d.style, z_exaggeration: d.exaggeration, colormap_name: o.cmap ?? DEM_CMAP,
    ...(o.vmin !== undefined ? { vmin: o.vmin } : {}), ...(o.vmax !== undefined ? { vmax: o.vmax } : {}),
  };
}

/**
 * XYZ template of a DEM's tiles: its COG through /overlay with ``algorithm=dem``, read one
 * pixel wider on each side (``buffer``, cropped by the algorithm) so slopes at tile edges
 * are right, and resampled bilinearly so zooming past 1 m shows no steps.
 */
export function demTileUrl(o: Overlay): string {
  const q = new URLSearchParams({
    url: o.path ?? '', bidx: '1', buffer: '1', resampling: 'bilinear', reproject: 'bilinear',
    algorithm: 'dem', algorithm_params: JSON.stringify(demParams(o)),
  });
  return `/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${q.toString()}`;
}
