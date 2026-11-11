import { describe, expect, it } from 'vitest';
import type { Overlay } from '../types';
import { DEM_CMAP } from './dem';
import {
  DEM_TERRAIN_MAXZOOM, globalTile, mergeTerrarium, parseTerrainUrl, terrainDem, terrainSourceFor, terrarium, tileBounds,
} from './demTerrain';
import { TERRAIN_SOURCE } from './terrain';

const dem = (terrain: boolean, over: Partial<Overlay> = {}): Overlay => ({
  id: 'd1', name: 'lidar.tif', type: 'geotiff', path: '/cache/k.tif', bandCount: 1, visible: true, opacity: 1,
  aboveData: false, mode: 'cmap', cmap: DEM_CMAP, bounds: [-90.2, 34.7, -90.1, 34.8],
  conversion: { status: 'ready', format: 'cog' },
  dem: { style: 'both', exaggeration: 2, terrain, base: 61.6 }, ...over,
});

describe('terrain from a DEM', () => {
  it('is the global terrain unless a ready, visible DEM is switched to it', () => {
    expect(terrainSourceFor([], 'http://h')).toBe(TERRAIN_SOURCE);
    expect(terrainSourceFor([dem(false)], 'http://h')).toBe(TERRAIN_SOURCE);
    expect(terrainSourceFor([dem(true, { visible: false })], 'http://h')).toBe(TERRAIN_SOURCE);
    expect(terrainDem([dem(true, { conversion: { status: 'converting', format: 'cog' } })])).toBeNull();
  });

  it('merges the DEM into the global terrain through bowserdem://, to zoom 17', () => {
    const src = terrainSourceFor([dem(false, { id: 'x' }), dem(true)], 'http://h');
    expect(src.type).toBe('raster-dem');
    expect(src.encoding).toBe('terrarium');
    expect(src.maxzoom).toBe(DEM_TERRAIN_MAXZOOM);
    const t = parseTerrainUrl(src.tiles[0].replace('{z}', '16').replace('{x}', '16359').replace('{y}', '26013'));
    expect(t).toMatchObject({ z: 16, x: 16359, y: 26013, base: 62, bounds: [-90.2, 34.7, -90.1, 34.8] });
    const q = new URL(t.dem.replace(/\{(\w)\}/g, '$1')).searchParams;
    expect(t.dem.startsWith('http://h/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?')).toBe(true);
    expect(q.get('url')).toBe('/cache/k.tif');
    expect(q.get('algorithm')).toBe('terrarium');
  });

  it('takes global tiles past zoom 15 from their zoom-15 ancestor', () => {
    expect(globalTile(12, 5, 7)).toEqual({ z: 12, x: 5, y: 7, sx: 0, sy: 0, size: 256 });
    expect(globalTile(17, 4 * 100 + 3, 4 * 200 + 1)).toEqual({ z: 15, x: 100, y: 200, sx: 192, sy: 64, size: 64 });
  });

  it('knows where a tile is', () => {
    const [w, s, e, n] = tileBounds(16, 16359, 26013);
    expect(w).toBeLessThan(-90.13);
    expect(e).toBeGreaterThan(-90.135);
    expect(s).toBeLessThan(34.7525);
    expect(n).toBeGreaterThan(34.7525);
  });

  it('uses the DEM where it has data, the global terrain elsewhere, and its low height offline', () => {
    const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());
    const demPx = px([1, 2, 3, 255], [9, 9, 9, 0], [4, 5, 6, 255]);
    const globalPx = px([7, 7, 7, 255], [8, 8, 8, 255], [7, 7, 7, 255]);
    expect([...mergeTerrarium(demPx, globalPx, 0, 3)]).toEqual([1, 2, 3, 255, 8, 8, 8, 255, 4, 5, 6, 255]);
    expect([...mergeTerrarium(null, globalPx, 0, 3)]).toEqual([...globalPx]);
    const [r, g, b] = terrarium(62);
    expect([...mergeTerrarium(demPx, null, 62, 3)].slice(4, 8)).toEqual([r, g, b, 255]);
    // Terrarium decodes back to the height: r * 256 + g + b / 256 - 32768.
    expect(r * 256 + g + b / 256 - 32768).toBe(62);
  });
});
