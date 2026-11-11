import { describe, expect, it } from 'vitest';
import type { Overlay } from '../types';
import { asDem, DEM_CMAP, demTileUrl, newDem } from './dem';
import { geotiffTileUrl, overlayDrawable, overlayOnMap, overlayVizKey } from './overlays';

const raster: Overlay = {
  id: 'd1', name: 'lidar.tif', type: 'geotiff', path: '/cache/abc.tif', bandCount: 1, visible: true, opacity: 1,
  aboveData: true, mode: 'cmap', cmap: 'viridis', vmin: 0, vmax: 1,
  bands: [{ name: 'b1', min: 60, max: 101, p2: 70, p98: 95 }], conversion: { status: 'ready', format: 'cog' },
};
const dem = (over: Partial<Overlay> = {}): Overlay => ({ ...raster, cmap: DEM_CMAP, vmin: 60, vmax: 140, dem: newDem(), ...over });

const params = (url: string) => new URL(url.replace(/\{(\w)\}/g, '$1'), 'http://h').searchParams;

describe('DEM tiles', () => {
  it('come from the COG through /overlay with the dem algorithm and the style settings', () => {
    const o = dem({ dem: { style: 'hillshade', exaggeration: 5 } });
    const url = geotiffTileUrl(o);
    expect(url).toBe(demTileUrl(o));
    expect(url.startsWith('/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?')).toBe(true);
    const q = params(url);
    expect(q.get('url')).toBe('/cache/abc.tif');
    expect(q.get('algorithm')).toBe('dem');
    // one extra pixel each side for the slopes at tile edges; the algorithm crops it
    expect(q.get('buffer')).toBe('1');
    expect(q.get('resampling')).toBe('bilinear');
    expect(JSON.parse(q.get('algorithm_params')!)).toEqual({
      style: 'hillshade', z_exaggeration: 5, colormap_name: 'schwarzwald', vmin: 60, vmax: 140,
    });
  });

  it('change with the style, so Leaflet remounts its layer', () => {
    const a = dem();
    const b = dem({ dem: { ...a.dem!, exaggeration: 4 } });
    expect(overlayVizKey(a)).not.toBe(overlayVizKey(b));
    expect(overlayVizKey(a)).not.toBe(overlayVizKey({ ...a, cmap: 'terrain' }));
  });

  it('are not drawn until the COG is ready', () => {
    const converting = dem({ conversion: { status: 'converting', format: 'cog' } });
    expect(overlayDrawable(converting)).toBe(false);
    expect(overlayOnMap(converting, false, 'main')).toBe(false);
    expect(overlayDrawable({ ...converting, conversion: { status: 'failed', format: 'cog' } })).toBe(false);
    expect(overlayDrawable(dem())).toBe(true);
    expect(overlayOnMap(dem(), true, 'right')).toBe(true);
  });
});

describe('Use as DEM', () => {
  it('styles a raster as a DEM under the data, over its 2–98 % range', () => {
    expect(asDem(raster)).toEqual({
      dem: { style: 'both', exaggeration: 2, base: 70 }, cmap: DEM_CMAP, aboveData: false, vmin: 70, vmax: 95,
    });
  });
});
