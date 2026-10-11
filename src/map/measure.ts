/** Measure tool maths, shared by both maps. Pinned by measure.test.ts. */
import { distanceM, type LatLng } from './profileGeometry';

/** Total length (m) of the clicked path. */
export function pathLength(pts: LatLng[]): number {
  return pts.reduce((acc, p, i) => (i === 0 ? 0 : acc + distanceM(pts[i - 1], p)), 0);
}

/** "640 m" below 1 km, "1.35 km" above. */
export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}
