import { describe, expect, it } from 'vitest';
import type { Overlay } from '../types';
import { DATA_ROW, DRAWINGS_ID, overlayRows, reorderOverlays, vectorLayerSpecs, withDrawings } from './overlays';

const ov = (id: string, aboveData = false) => ({ id, name: id, type: 'geotiff', visible: true, opacity: 1, aboveData }) as Overlay;
// bottom of the map first: a, b under the data; c, d over it
const LIST = [ov('a'), ov('b'), ov('c', true), ov('d', true)];

describe('overlayRows', () => {
  it('lists the top of the map first, with the data between', () => {
    expect(overlayRows(LIST)).toEqual(['d', 'c', DATA_ROW, 'b', 'a']);
    expect(overlayRows([])).toEqual([DATA_ROW]);
  });
});

describe('reorderOverlays', () => {
  const rows = (dragged: string, target: string, below: boolean) => overlayRows(reorderOverlays(LIST, dragged, target, below));

  it('moves a row within its side of the data', () => {
    expect(rows('a', 'b', false)).toEqual(['d', 'c', DATA_ROW, 'a', 'b']);
    expect(rows('d', 'c', true)).toEqual(['c', 'd', DATA_ROW, 'b', 'a']);
  });

  it('crossing the data row changes the side the overlay is drawn on', () => {
    const moved = reorderOverlays(LIST, 'a', DATA_ROW, false);
    expect(overlayRows(moved)).toEqual(['d', 'c', 'a', DATA_ROW, 'b']);
    expect(moved.find(o => o.id === 'a')?.aboveData).toBe(true);
    const back = reorderOverlays(LIST, 'c', DATA_ROW, true);
    expect(overlayRows(back)).toEqual(['d', DATA_ROW, 'c', 'b', 'a']);
    expect(back.find(o => o.id === 'c')?.aboveData).toBe(false);
  });

  it('keeps the other overlay fields', () => {
    const list = [{ ...ov('a'), opacity: 0.3 }, ov('b')];
    expect(reorderOverlays(list, 'a', 'b', false).find(o => o.id === 'a')?.opacity).toBe(0.3);
  });

  it('ignores a drop on itself, an unknown row, or dragging the data', () => {
    expect(reorderOverlays(LIST, 'a', 'a', true)).toBe(LIST);
    expect(reorderOverlays(LIST, 'a', 'nope', true)).toBe(LIST);
    expect(reorderOverlays(LIST, 'nope', 'a', true)).toBe(LIST);
    expect(reorderOverlays(LIST, DATA_ROW, 'a', true)).toBe(LIST);
  });
});

describe('vectorLayerSpecs', () => {
  it('draws multi-part geometry and follows the style and opacity', () => {
    const [fill, line, point] = vectorLayerSpecs({ ...ov('v'), type: 'vector', opacity: 0.5, color: '#ff0000', lineWidth: 3, pointRadius: 7 });
    expect(JSON.stringify(fill.filter)).toContain('MultiPolygon');
    expect(JSON.stringify(line.filter)).toContain('MultiLineString');
    expect(JSON.stringify(point.filter)).toContain('MultiPoint');
    expect(fill.id).toBe('overlay-v-fill');
    expect(fill.paint['fill-opacity']).toBe(0.125);
    expect(line.paint).toMatchObject({ 'line-color': '#ff0000', 'line-width': 3, 'line-opacity': 0.5 });
    expect(point.paint).toMatchObject({ 'circle-radius': 7 });
  });
});

describe('withDrawings', () => {
  const shape = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-90, 35] } };
  const fc = (n: number) => ({ type: 'FeatureCollection' as const, features: Array(n).fill(shape) });

  it('adds the Drawings overlay with the first shape, above the data', () => {
    const out = withDrawings([ov('a')], fc(1));
    expect(out.map(o => o.id)).toEqual(['a', DRAWINGS_ID]);
    expect(out[1]).toMatchObject({ type: 'vector', aboveData: true, bounds: [-90, 35, -90, 35] });
  });

  it('updates it in place, keeping its style and position', () => {
    const first = withDrawings([ov('a')], fc(1)).map(o => (o.id === DRAWINGS_ID ? { ...o, color: '#123456' } : o));
    const moved = [first[1], first[0]];
    const out = withDrawings(moved, fc(2));
    expect(out.map(o => o.id)).toEqual([DRAWINGS_ID, 'a']);
    expect(out[0].color).toBe('#123456');
    expect(out[0].data?.features).toHaveLength(2);
  });

  it('removes it with the last shape', () => {
    expect(withDrawings(withDrawings([ov('a')], fc(1)), fc(0)).map(o => o.id)).toEqual(['a']);
    const list = [ov('a')];
    expect(withDrawings(list, fc(0))).toBe(list);
  });
});

describe('vector colour by class', () => {
  it('matches the class attribute, with the layer colour for the rest', () => {
    const [fill] = vectorLayerSpecs({ ...ov('s'), type: 'vector', color: '#999999', classColors: { property: 'class', classes: [['Expansive clay', '#ea580c']] } });
    expect(fill.paint['fill-color']).toEqual(['match', ['to-string', ['get', 'class']], 'Expansive clay', '#ea580c', '#999999']);
  });
});

describe('point markers', () => {
  it('draws circles unless a shape is chosen, then a recoloured icon sized to the point size', () => {
    const v = { ...ov('v'), type: 'vector' as const, color: '#ff0000', pointRadius: 8.64 };
    expect(vectorLayerSpecs(v)[2].type).toBe('circle');
    const star = vectorLayerSpecs({ ...v, marker: 'star' })[2];
    expect(star.type).toBe('symbol');
    expect(star.layout).toMatchObject({ 'icon-image': 'bowser-marker-star', 'icon-allow-overlap': true });
    expect(star.layout?.['icon-size']).toBeCloseTo(1, 6);
    expect(star.paint['icon-color']).toBe('#ff0000');
    expect(vectorLayerSpecs({ ...v, marker: 'pin' })[2].layout).toMatchObject({ 'icon-anchor': 'bottom' });
  });
});
