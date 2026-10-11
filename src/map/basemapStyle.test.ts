import { describe, expect, it } from 'vitest';
import { baseMaps } from '../basemap';
import { basemapSource, basemapStack, basemapTiles } from './basemapStyle';

describe('basemap sources for MapLibre', () => {
  it('expands {s} subdomains and keeps plain templates as they are', () => {
    expect(basemapTiles('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png')).toEqual([
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ]);
    expect(basemapTiles(baseMaps.esriSatellite.url)).toEqual([baseMaps.esriSatellite.url]);
  });

  it('every configured basemap becomes a valid raster source', () => {
    for (const [key, item] of Object.entries(baseMaps)) {
      const s = basemapSource(item);
      expect(s.type, key).toBe('raster');
      expect(s.tiles.length, key).toBeGreaterThan(0);
      for (const t of s.tiles) {
        expect(t, key).not.toContain('{s}');
        expect(t, key).toMatch(/\{z\}.*\{[xy]\}.*\{[xy]\}/);
      }
    }
  });

  it('swaps bottom/top basemap and their opacities like the Leaflet map', () => {
    const a = baseMaps.esriSatellite;
    const b = baseMaps.esriDark;
    expect(basemapStack(a, b, false, 1, 0.4)).toEqual({ bottom: a, top: b, bottomOpacity: 1, topOpacity: 0.4 });
    expect(basemapStack(a, b, true, 1, 0.4)).toEqual({ bottom: b, top: a, bottomOpacity: 0.4, topOpacity: 1 });
    expect(basemapStack(a, null, false, 1, 0.4)).toEqual({ bottom: a, top: null, bottomOpacity: 1, topOpacity: 0.4 });
  });
});
