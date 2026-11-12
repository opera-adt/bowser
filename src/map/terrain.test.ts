import { describe, expect, it } from 'vitest';
import {
  EXAGGERATION_DEFAULT, EXAGGERATION_MAX, EXAGGERATION_MIN, TERRAIN_SOURCE, TERRAIN_SOURCE_ID,
  clampExaggeration, terrainSpec, terrainOnTilt } from './terrain';

describe('terrain', () => {
  it('uses a key-free Terrarium DEM source', () => {
    expect(TERRAIN_SOURCE.type).toBe('raster-dem');
    expect(TERRAIN_SOURCE.encoding).toBe('terrarium');
    expect(TERRAIN_SOURCE.tiles[0]).toMatch(/^https:\/\/.*\{z\}\/\{x\}\/\{y\}\.png$/);
  });

  it('clamps exaggeration to the slider range and survives bad input', () => {
    expect(clampExaggeration(0.2)).toBe(EXAGGERATION_MIN);
    expect(clampExaggeration(50)).toBe(EXAGGERATION_MAX);
    expect(clampExaggeration(3.5)).toBe(3.5);
    expect(clampExaggeration(NaN)).toBe(EXAGGERATION_DEFAULT);
  });

  it('is flat when off and sourced from the DEM when on', () => {
    expect(terrainSpec(false, 3)).toBeNull();
    expect(terrainSpec(true, 3)).toEqual({ source: TERRAIN_SOURCE_ID, exaggeration: 3 });
    expect(terrainSpec(true, 99)).toEqual({ source: TERRAIN_SOURCE_ID, exaggeration: EXAGGERATION_MAX });
  });
});

describe('terrainOnTilt', () => {
  it('turns terrain on when a flat map is tilted', () => {
    expect(terrainOnTilt(true, 45, false)).toBe(true);
  });
  it('leaves it alone otherwise: still flat, already tilted (turned off by hand), or already on', () => {
    expect(terrainOnTilt(true, 5, false)).toBe(false);
    expect(terrainOnTilt(false, 45, false)).toBe(false);
    expect(terrainOnTilt(true, 45, true)).toBe(false);
  });
  it('leaves it off while the GPU renderer is chosen (its layer is flat; tiles would take over)', () => {
    expect(terrainOnTilt(true, 45, false, true)).toBe(false);
    expect(terrainOnTilt(true, 45, false, false)).toBe(true);
  });
});
