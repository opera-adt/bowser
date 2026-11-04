import { describe, expect, it } from 'vitest';
import { geotiffTileUrl, overlayOnMap, overlaySource, overlayVizKey } from './overlays';
import type { Overlay } from '../types';

const tif = (o: Partial<Overlay>): Overlay => ({ id: 'o1', name: 'n', type: 'geotiff', visible: true, opacity: 1,
  path: '/data/up/a b.tif', ...o });
const BASE = '/overlay/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=%2Fdata%2Fup%2Fa%20b.tif';

describe('overlays', () => {
  it('GeoTIFF tile URLs: RGB as is, colormaps on band 1 (2-band files used to 500)', () => {
    expect(geotiffTileUrl(tif({ mode: 'rgb' }))).toBe(BASE);
    expect(geotiffTileUrl(tif({ mode: 'cmap', cmap: 'terrain', vmin: -2, vmax: 5 })))
      .toBe(`${BASE}&bidx=1&colormap_name=terrain&rescale=-2,5`);
    const d = geotiffTileUrl(tif({ mode: 'cmap', discrete: true, nbins: 2, vmin: 0, vmax: 10, binColors: ['#ff0000', '#00ff00'] }));
    expect(d.startsWith(`${BASE}&bidx=1&colormap=`)).toBe(true);
    expect(JSON.parse(decodeURIComponent(d.split('&colormap=')[1])))
      .toEqual([[[0, 5], [255, 0, 0, 255]], [[5, 10 + 5e-3 + 1e-9], [0, 255, 0, 255]]]);
    expect(overlayVizKey(tif({ mode: 'cmap', discrete: true, nbins: 2, binColors: ['#a', '#b'] }))).toBe('d2:#a#b');
    expect(overlayVizKey(tif({ mode: 'rgb' }))).toBe('rgb');
    expect(overlayVizKey(tif({ type: 'wms' }))).toBe('wms');
  });

  it('WMS becomes a GetMap template with the parameters Leaflet sends; maxNativeZoom caps the source', () => {
    const s = overlaySource(tif({ type: 'wms', url: 'https://x/wms?map=a', wmsLayers: 'roads', maxNativeZoom: 15 }));
    expect(s.maxzoom).toBe(15);
    const u = new URL(s.tiles[0].replace('{bbox-epsg-3857}', 'BBOX'));
    expect(Object.fromEntries(u.searchParams)).toEqual({ map: 'a', service: 'WMS', request: 'GetMap', version: '1.1.1',
      layers: 'roads', styles: '', format: 'image/png', transparent: 'true', width: '256', height: '256',
      srs: 'EPSG:3857', bbox: 'BBOX' });
    expect(overlaySource(tif({ type: 'wmts', url: 'https://t/{z}/{x}/{y}.png' }))).toEqual({ tiles: ['https://t/{z}/{x}/{y}.png'], maxzoom: 22 });
  });

  it('split screen: side picks the main (left) map, the right map, or both', () => {
    const on = (side: Overlay['side'], split: boolean) =>
      (['main', 'right'] as const).filter(m => overlayOnMap(tif({ side }), split, m));
    expect(on('right', false)).toEqual(['main']);
    expect(on('left', true)).toEqual(['main']);
    expect(on('right', true)).toEqual(['right']);
    expect(on(undefined, true)).toEqual(['main', 'right']);
    expect(overlayOnMap(tif({ visible: false }), false, 'main')).toBe(false);
  });
});
