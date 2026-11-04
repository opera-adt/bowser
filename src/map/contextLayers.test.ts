import { describe, expect, it } from 'vitest';
import { contextLayerSpec, contextOverlay, landCoverOverlay } from './contextLayers';

describe('context layers', () => {
  it('colours roads by class until one colour is chosen', () => {
    const roads = contextOverlay('roads', 'r');
    expect(contextLayerSpec(roads).paint['line-color']).toEqual(expect.arrayContaining(['match']));
    expect(contextLayerSpec({ ...roads, color: '#ff0000' }).paint['line-color']).toBe('#ff0000');
    expect(contextLayerSpec(roads).sourceLayer).toBe('transportation');
  });

  it('scales widths and building heights, and follows the opacity', () => {
    const roads = contextLayerSpec({ ...contextOverlay('roads', 'r'), scale: 2, opacity: 0.4 });
    expect(roads.paint['line-width']).toEqual(['interpolate', ['linear'], ['zoom'], 6, 1, 12, 3.2, 16, 10]);
    expect(roads.paint['line-opacity']).toBe(0.4);
    const buildings = contextLayerSpec({ ...contextOverlay('buildings', 'b'), scale: 3 });
    expect(buildings.type).toBe('fill-extrusion');
    expect(buildings.minzoom).toBe(13);
    expect(buildings.paint['fill-extrusion-height']).toEqual(['*', ['coalesce', ['get', 'render_height'], 6], 3]);
  });

  it('draws boundaries from the boundary source layer, down to counties', () => {
    const spec = contextLayerSpec(contextOverlay('boundaries', 'a'));
    expect(spec.sourceLayer).toBe('boundary');
    expect(spec.filter).toEqual(['<=', ['get', 'admin_level'], 6]);
  });

  it('starts above the data, with its id as the layer id', () => {
    const o = contextOverlay('buildings', 'x');
    expect(o.aboveData).toBe(true);
    expect(contextLayerSpec(o).id).toBe('overlay-x');
  });
});

describe('land cover', () => {
  it('asks the service for one year, in Web Mercator tiles MapLibre fills in', () => {
    const o = landCoverOverlay(2023, 'lc');
    expect(o).toMatchObject({ type: 'wmts', name: 'Land cover 2023', landCoverYear: 2023, aboveData: false });
    expect(o.url).toContain('bbox={bbox-epsg-3857}');
    const time = new URL(o.url!.replace('{bbox-epsg-3857}', '0')).searchParams.get('time');
    expect(time).toBe(`${Date.UTC(2023, 0, 1)},${Date.UTC(2023, 11, 31, 23, 59, 59)}`);
    expect(o.legend?.map(([name]) => name)).toContain('Built area');
  });
});
