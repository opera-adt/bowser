import { describe, expect, it } from 'vitest';
import { hasPolygonLayers, pmtilesOverlay, pmtilesVectorSpecs, type PmtilesInfo } from './pmtiles';
import { overlayIdOfLayer } from './identify';

const vector: PmtilesInfo = { kind: 'vector', layers: ['roads', 'buildings'], bounds: [11, 43, 12, 44], minzoom: 0, maxzoom: 14, name: null, attribution: 'OSM', polygons: null };

describe('pmtiles overlays', () => {
  it('names the overlay after the archive and keeps its layers', () => {
    const o = pmtilesOverlay('https://x.org/data/firenze%20city.pmtiles?v=2', vector, 'p1');
    expect(o).toMatchObject({ name: 'firenze city', type: 'pmtiles', pmtilesKind: 'vector', aboveData: true, sourceLayers: ['roads', 'buildings'], maxNativeZoom: 14, attribution: 'OSM' });
    expect(pmtilesOverlay('https://x.org/a.pmtiles', { ...vector, kind: 'raster', layers: [], name: 'Toner' }, 'p2'))
      .toMatchObject({ name: 'Toner', aboveData: false, opacity: 0.85 });
  });

  it('draws fill, line and points for each vector layer, and identify finds the overlay', () => {
    const specs = pmtilesVectorSpecs(pmtilesOverlay('https://x.org/a.pmtiles', vector, 'p1'));
    expect(specs.map(s => [s.id, s.sourceLayer])).toEqual([
      ['overlay-p1__0-fill', 'roads'], ['overlay-p1__0-line', 'roads'], ['overlay-p1__0-point', 'roads'],
      ['overlay-p1__1-fill', 'buildings'], ['overlay-p1__1-line', 'buildings'], ['overlay-p1__1-point', 'buildings'],
    ]);
    expect(overlayIdOfLayer('overlay-p1__1-line')).toBe('p1');
  });
});

describe('polygons in a vector archive', () => {
  it('come from the tilestats GDAL and tippecanoe write, else are unknown', () => {
    expect(hasPolygonLayers({ layers: [{ geometry: 'LineString' }, { geometry: 'Polygon' }] })).toBe(true);
    expect(hasPolygonLayers({ layers: [{ geometry: 'LineString' }, { geometry: 'Point' }] })).toBe(false);
    expect(hasPolygonLayers(undefined)).toBeNull();
    expect(hasPolygonLayers({ layers: [{}] })).toBeNull();
  });
  it('are kept on the overlay only when known', () => {
    expect(pmtilesOverlay('https://x.org/a.pmtiles', { ...vector, polygons: false }, 'p1').hasPolygons).toBe(false);
    expect('hasPolygons' in pmtilesOverlay('https://x.org/a.pmtiles', vector, 'p1')).toBe(false);
  });
});
