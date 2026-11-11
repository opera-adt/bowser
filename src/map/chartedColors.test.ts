/** Features in the time-series chart take their chart colour on the map. */
import { describe, expect, it } from 'vitest';
import { chartedFeatureColors, drawingIndexOf, drawingName, DRAWINGS_ID, linkedColor, vectorLayerSpecs, withDrawings } from './overlays';
import type { Overlay } from '../types';

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });
const layer = (id: string, features: unknown[]): Overlay =>
  ({ id, name: id, type: 'vector', visible: true, opacity: 1, color: '#5bc0be', data: { type: 'FeatureCollection', features } });

describe('charted feature colours', () => {
  it('match areas and points to their layer feature by index', () => {
    const o = layer('v', [{ geometry: square(0) }, { geometry: square(2) }, { geometry: { type: 'Point', coordinates: [0, 0] } }]);
    const colors = chartedFeatureColors(o, [
      { color: '#111111', source: { overlayId: 'v', index: 1 } },
      { color: '#222222', source: { overlayId: 'v', index: 2 } },
      { color: '#333333', source: { overlayId: 'other', index: 0 } },
      { color: '#444444', source: { overlayId: 'v', index: 9 } },  // gone from the layer
    ]);
    expect([...colors]).toEqual([[1, '#111111'], [2, '#222222']]);
  });

  it('find a shape drawn for + Area among the drawings by its geometry', () => {
    const o = layer(DRAWINGS_ID, [{ geometry: square(0) }, { geometry: square(5) }]);
    const colors = chartedFeatureColors(o, [{ color: '#abcdef', geometry: square(5) }, { color: '#000000', geometry: square(9) }]);
    expect([...colors]).toEqual([[1, '#abcdef']]);
  });

  it('still find a drawn area after the editor rewrites its ring (reversed, as a MultiPolygon)', () => {
    // The Draw tools hand back a shape with its ring reversed when they are switched on and
    // off: the area must keep its link (chart colour on the map, renames both ways).
    const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const area = { color: '#abcdef', geometry: { type: 'MultiPolygon', coordinates: [[ring]] } };
    const reversed = { type: 'MultiPolygon', coordinates: [[[...ring].reverse()]] };
    const shifted = { type: 'Polygon', coordinates: [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 1]]] };
    const o = layer(DRAWINGS_ID, [{ geometry: square(5) }, { geometry: reversed }]);
    expect([...chartedFeatureColors(o, [area])]).toEqual([[1, '#abcdef']]);
    expect(drawingIndexOf(area, { type: 'FeatureCollection', features: [{ geometry: shifted }] } as never)).toBe(0);
    // A different shape with the same vertices in another order is not the same shape.
    const bowtie = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] };
    expect(drawingIndexOf(area, { type: 'FeatureCollection', features: [{ geometry: bowtie }] } as never)).toBe(-1);
  });

  it('carry a drawn shape name over when the editor rewrites its ring', () => {
    const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const named = layer(DRAWINGS_ID, [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { name: 'Bowl' } }]);
    const next = withDrawings([named], { type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon', coordinates: [[...ring].reverse()] }, properties: {} }] } as never);
    expect(drawingName(next[0].data!.features[0])).toBe('Bowl');
  });

  it('wrap the layer colour in a match on the feature id, or leave it alone', () => {
    expect(linkedColor('#5bc0be', new Map())).toBe('#5bc0be');
    expect(linkedColor('#5bc0be', new Map([[3, '#ff0000'], [0, '#00ff00']]))).toEqual(['match', ['id'], 0, '#00ff00', 3, '#ff0000', '#5bc0be']);
    const specs = vectorLayerSpecs(layer('v', []), new Map([[0, '#ff0000']]));
    expect(specs.map(s => Object.values(s.paint)[0])).toEqual(Array(3).fill(['match', ['id'], 0, '#ff0000', '#5bc0be']));
  });
});
