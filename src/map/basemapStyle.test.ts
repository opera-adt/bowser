import { describe, expect, it } from 'vitest';
import { baseMaps } from '../basemap';
import { basemapLeafletZoom, basemapSource, basemapStack, basemapTiles, MAP_MAX_ZOOM } from './basemapStyle';

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

  // Past these zooms Esri serves a grey "Map data not yet available" tile, so the
  // sources stop there and MapLibre / Leaflet upscale the last real tiles.
  const NATIVE = { esriDark: 16, esriLight: 16, esriHillshade: 16, shadedRelief: 13 } as const;

  it('asks Esri for 404 instead of its "Map data not yet available" tile', () => {
    const esri = Object.entries(baseMaps).filter(([, item]) => item.url.includes('arcgisonline.com'));
    expect(esri.length).toBeGreaterThanOrEqual(6);
    for (const [key, item] of esri) {
      expect(item.url, key).toMatch(/\/tile\/\{z\}\/\{y\}\/\{x\}\?blankTile=false$/);
      expect(basemapSource(item).tiles[0], key).toContain('blankTile=false');
    }
  });

  it('draws Relief from Esri World Shaded Relief, not a copy of Hillshade', () => {
    expect(baseMaps.shadedRelief.url).toContain('World_Shaded_Relief');
    expect(baseMaps.shadedRelief.url).not.toBe(baseMaps.esriHillshade.url);
  });

  it('caps each basemap source at the provider\'s native zoom (MapLibre overzooms past it)', () => {
    for (const [key, z] of Object.entries(NATIVE)) {
      expect(basemapSource(baseMaps[key]).maxzoom, key).toBe(z);
    }
    expect(basemapSource(baseMaps.esriSatellite).maxzoom).toBe(19);
  });

  it('gives Leaflet layers maxNativeZoom while the map still zooms to the data\'s max', () => {
    expect(MAP_MAX_ZOOM).toBe(22);
    for (const [key, z] of Object.entries(NATIVE)) {
      expect(basemapLeafletZoom(baseMaps[key]), key).toEqual({ maxZoom: 22, maxNativeZoom: z });
    }
    expect(basemapLeafletZoom(baseMaps.esriSatellite)).toEqual({ maxZoom: 22 });
  });
});
