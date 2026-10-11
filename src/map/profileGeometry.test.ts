import L from 'leaflet';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_IDLE, corridorRing, distanceM, dropTrailingDuplicates, pointAtDistance, profileReducer, type LatLng,
} from './profileGeometry';

const A: LatLng = [33.96289, -117.67984];
const B: LatLng = [33.95429, -117.66939];
const C: LatLng = [33.95, -117.66];

describe('profile geometry', () => {
  it('measures great-circle distance like Leaflet (haversine, R = 6371 km)', () => {
    expect(distanceM([0, 0], [0, 1])).toBeCloseTo(111194.93, 1);
    // same numbers as the Leaflet map's distanceTo, so profile distances don't change on MapLibre
    for (const [p, q] of [[A, B], [B, C], [A, C]] as [LatLng, LatLng][]) {
      expect(distanceM(p, q)).toBeCloseTo(L.CRS.Earth.distance(L.latLng(p), L.latLng(q)), 6);
    }
    expect(distanceM(A, A)).toBe(0);
  });

  it('finds the point at a distance along the line and clamps past the end', () => {
    const d = distanceM(A, B);
    const mid = pointAtDistance([A, B], d / 2)!;
    expect(mid[0]).toBeCloseTo((A[0] + B[0]) / 2, 6);
    expect(mid[1]).toBeCloseTo((A[1] + B[1]) / 2, 6);
    expect(pointAtDistance([A, B, C], 0)).toEqual(A);
    expect(pointAtDistance([A, B, C], 1e9)).toEqual(C);
    expect(pointAtDistance([A], 10)).toBeNull();
  });

  it('builds a closed corridor ring of twice the vertex count, offset by about the radius', () => {
    const ring = corridorRing([A, B], 100);
    expect(ring).toHaveLength(4);
    expect(distanceM(ring[0], A)).toBeCloseTo(100, -1);
    expect(distanceM(ring[3], A)).toBeCloseTo(100, -1);
    expect(corridorRing([A, B], 0)).toEqual([]);
    expect(corridorRing([A], 100)).toEqual([]);
  });

  it('drops vertices stacked on the finishing pixel', () => {
    const px = (p: LatLng): [number, number] => [p[1] * 1e5, p[0] * 1e5];
    const near: LatLng = [B[0] + 1e-6, B[1] + 1e-6];
    expect(dropTrailingDuplicates([A, B, near, near], px)).toEqual([A, B]);
    expect(dropTrailingDuplicates([A, B], px)).toEqual([A, B]);
  });
});

describe('profile drawing', () => {
  const px = (p: LatLng): [number, number] => [p[1] * 1e5, p[0] * 1e5];

  it('click, click, double-click: draws then finishes', () => {
    let s = profileReducer(PROFILE_IDLE, { type: 'click', at: A });
    s = profileReducer(s, { type: 'click', at: B });
    s = profileReducer(s, { type: 'click', at: B });          // the double-click's own clicks
    expect(s).toEqual({ mode: 'drawing', pts: [A, B, B] });
    s = profileReducer(s, { type: 'finish', toPixel: px });
    expect(s).toEqual({ mode: 'ready', pts: [A, B] });
  });

  it('needs two vertices to finish', () => {
    const s = profileReducer(profileReducer(PROFILE_IDLE, { type: 'click', at: A }), { type: 'finish', toPixel: px });
    expect(s.mode).toBe('drawing');
  });

  it('a click on a finished line starts a new one; drag moves one vertex; clear resets', () => {
    const ready = { mode: 'ready' as const, pts: [A, B] };
    expect(profileReducer(ready, { type: 'click', at: C })).toEqual({ mode: 'drawing', pts: [C] });
    expect(profileReducer(ready, { type: 'move', index: 1, at: C })).toEqual({ mode: 'ready', pts: [A, C] });
    expect(profileReducer(ready, { type: 'move', index: 5, at: C })).toBe(ready);
    expect(profileReducer(ready, { type: 'clear' })).toEqual(PROFILE_IDLE);
  });
});
