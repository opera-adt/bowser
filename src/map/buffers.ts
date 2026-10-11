/** Buffer circles (time-series points and the reference point) as GeoJSON. Pinned by buffers.test.ts. */
import type { AppState } from '../types';
import type { LatLng } from './profileGeometry';

const R = 6371000;   // m, as distanceM
export const REF_BUFFER_COLOR = '#e05d6a';

/** Ring of `n` points `radius` metres (great-circle) from `center`, closed, as [lng, lat]. */
export function circleRing([lat, lng]: LatLng, radius: number, n = 64): [number, number][] {
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180, δ = radius / R;
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const θ = (i % n) / n * 2 * Math.PI;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    ring.push([λ2 * 180 / Math.PI, φ2 * 180 / Math.PI]);
  }
  return ring;
}

type BufferState = Pick<AppState, 'bufferEnabled' | 'bufferRadius' | 'timeSeriesPoints' | 'refEnabled'
  | 'refBufferEnabled' | 'refBufferRadius' | 'refMarkerPosition'>;

/** The circles the Leaflet map draws: one per visible point, plus the reference buffer. */
export function bufferFeatures(s: BufferState): GeoJSON.FeatureCollection<GeoJSON.Polygon, { color: string }> {
  const circle = (c: LatLng, r: number, color: string) => ({
    type: 'Feature' as const, properties: { color }, geometry: { type: 'Polygon' as const, coordinates: [circleRing(c, r)] },
  });
  const features = [];
  if (s.bufferEnabled && s.bufferRadius > 0) {
    for (const p of s.timeSeriesPoints) if (p.visible) features.push(circle(p.position, s.bufferRadius, p.color));
  }
  if (s.refEnabled && s.refBufferEnabled && s.refBufferRadius > 0) {
    features.push(circle(s.refMarkerPosition, s.refBufferRadius, REF_BUFFER_COLOR));
  }
  return { type: 'FeatureCollection', features };
}
