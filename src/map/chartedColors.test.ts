/** Features in the time-series chart take their chart colour on the map. */
import { describe, expect, it } from 'vitest';
import { chartedFeatureColors, DRAWINGS_ID, linkedColor, vectorLayerSpecs } from './overlays';
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

  it('wrap the layer colour in a match on the feature id, or leave it alone', () => {
    expect(linkedColor('#5bc0be', new Map())).toBe('#5bc0be');
    expect(linkedColor('#5bc0be', new Map([[3, '#ff0000'], [0, '#00ff00']]))).toEqual(['match', ['id'], 0, '#00ff00', 3, '#ff0000', '#5bc0be']);
    const specs = vectorLayerSpecs(layer('v', []), new Map([[0, '#ff0000']]));
    expect(specs.map(s => Object.values(s.paint)[0])).toEqual(Array(3).fill(['match', ['id'], 0, '#ff0000', '#5bc0be']));
  });
});
