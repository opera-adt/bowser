/**
 * 3D terrain for the MapLibre map: elevation source and exaggeration limits.
 *
 * Elevation comes from the public AWS Terrain Tiles (Terrarium encoding, no API key,
 * global, ~30 m where SRTM exists), the same tiles MapLibre's own examples use. Like
 * the basemaps it needs a network connection. Pinned by terrain.test.ts.
 */

export const TERRAIN_SOURCE_ID = 'terrain-dem';

export const TERRAIN_SOURCE = {
  type: 'raster-dem' as const,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (Mapzen)',
};

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 10;
export const EXAGGERATION_DEFAULT = 2;
/** Camera tilt used when terrain is switched on from a flat view. */
export const TERRAIN_PITCH = 60;

export function clampExaggeration(x: number): number {
  if (!Number.isFinite(x)) return EXAGGERATION_DEFAULT;
  return Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, x));
}

/** ``map.setTerrain`` argument for the current toggle state (``null`` = flat). */
export function terrainSpec(enabled: boolean, exaggeration: number): { source: string; exaggeration: number } | null {
  return enabled ? { source: TERRAIN_SOURCE_ID, exaggeration: clampExaggeration(exaggeration) } : null;
}

/** Tilting past this (degrees) counts as going 3D. */
export const TILT_ON = 10;

/** Turn terrain on when a flat map is tilted, unless it is already on. */
export function terrainOnTilt(wasFlat: boolean, pitch: number, enabled: boolean): boolean {
  return wasFlat && pitch >= TILT_ON && !enabled;
}

/**
 * When the GPU renderer gets chosen, turn off a 3D terrain left on from an earlier visit
 * (remembered, often from a tilt), so the page opens flat and the GPU draws. A DEM overlay
 * used for terrain keeps it; tilting or the terrain button turn it on again.
 */
export function terrainOffForGpu(gpuChosen: boolean, enabled: boolean, demTerrain: boolean): boolean {
  return gpuChosen && enabled && !demTerrain;
}
