import { describe, expect, it } from 'vitest';
import { chooseMap } from './mapChoice';

describe('map choice', () => {
  it('MapLibre by default, Leaflet on request or without WebGL2', () => {
    expect(chooseMap('?dataset=x', () => true)).toBe('maplibre');
    expect(chooseMap('?map=maplibre', () => true)).toBe('maplibre');
    expect(chooseMap('?dataset=x&map=leaflet', () => true)).toBe('leaflet');
    expect(chooseMap('?dataset=x', () => false)).toBe('leaflet');
    expect(chooseMap('?map=maplibre', () => false)).toBe('leaflet');
  });
});
