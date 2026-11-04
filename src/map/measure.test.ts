import L from 'leaflet';
import { describe, expect, it } from 'vitest';
import { formatDistance, pathLength } from './measure';
import type { LatLng } from './profileGeometry';

const PTS: LatLng[] = [[33.96289, -117.67984], [33.95429, -117.66939], [33.95, -117.66]];

describe('measure tool', () => {
  it('sums the path like the Leaflet tool did', () => {
    const leaflet = PTS.reduce((acc, p, i) => (i === 0 ? 0 : acc + L.latLng(PTS[i - 1]).distanceTo(L.latLng(p))), 0);
    expect(pathLength(PTS)).toBeCloseTo(leaflet, 6);
    expect(pathLength([PTS[0]])).toBe(0);
  });

  it('formats metres below 1 km and kilometres above', () => {
    expect(formatDistance(640.4)).toBe('640 m');
    expect(formatDistance(999.6)).toBe('1000 m');
    expect(formatDistance(1350)).toBe('1.35 km');
  });
});
