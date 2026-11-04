/**
 * Profile-line geometry and drawing state, independent of the map library.
 * Points are [lat, lng]. Pinned by profileGeometry.test.ts.
 */

export type LatLng = [number, number];

/** Great-circle distance in metres (haversine, R = 6371 km: identical to Leaflet's distanceTo). */
export function distanceM([lat1, lng1]: LatLng, [lat2, lng2]: LatLng): number {
  const rad = Math.PI / 180;
  const sinDLat = Math.sin(((lat2 - lat1) * rad) / 2);
  const sinDLon = Math.sin(((lng2 - lng1) * rad) / 2);
  const a = sinDLat * sinDLat + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * sinDLon * sinDLon;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Position ``target`` metres along the polyline (linear within a segment; clamps to the end). */
export function pointAtDistance(pts: LatLng[], target: number): LatLng | null {
  if (pts.length < 2) return null;
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = distanceM(pts[i], pts[i + 1]);
    if (cum + seg >= target) {
      const f = seg > 0 ? (target - cum) / seg : 0;
      return [pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), pts[i][1] + f * (pts[i + 1][1] - pts[i][1])];
    }
    cum += seg;
  }
  return pts[pts.length - 1];
}

/** Closed ring of the ±``radius`` m corridor around the line (as drawn on the Leaflet map). */
export function corridorRing(pts: LatLng[], radius: number): LatLng[] {
  if (pts.length < 2 || radius <= 0) return [];
  const left: LatLng[] = [];
  const right: LatLng[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = i < pts.length - 1 ? [pts[i], pts[i + 1]] : [pts[i - 1], pts[i]];
    const bearing = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const lat = pts[i][0];
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
    const perp = bearing + Math.PI / 2;
    const dLat = (radius / mPerDegLat) * Math.cos(perp);
    const dLng = (radius / mPerDegLng) * Math.sin(perp);
    left.push([pts[i][0] + dLat, pts[i][1] + dLng]);
    right.push([pts[i][0] - dLat, pts[i][1] - dLng]);
  }
  return [...left, ...right.reverse()];
}

/**
 * A double-click fires click, click, dblclick, so up to two extra vertices land on
 * the finishing pixel: drop trailing vertices within ``tolPx`` screen pixels of the one before.
 */
export function dropTrailingDuplicates(
  pts: LatLng[], toPixel: (p: LatLng) => [number, number], tolPx = 5,
): LatLng[] {
  const out = [...pts];
  while (out.length >= 2) {
    const [ax, ay] = toPixel(out[out.length - 1]);
    const [bx, by] = toPixel(out[out.length - 2]);
    if (Math.hypot(ax - bx, ay - by) <= tolPx) out.pop();
    else break;
  }
  return out;
}

// ── drawing state ────────────────────────────────────────────────────────────

export type ProfileMode = 'idle' | 'drawing' | 'ready';
export interface ProfileDraw { mode: ProfileMode; pts: LatLng[] }
export type ProfileEvent =
  | { type: 'click'; at: LatLng }
  | { type: 'finish'; toPixel: (p: LatLng) => [number, number] }
  | { type: 'move'; index: number; at: LatLng }
  | { type: 'clear' };

export const PROFILE_IDLE: ProfileDraw = { mode: 'idle', pts: [] };

/** Click adds a vertex (a click on a finished line starts a new one); double-click finishes with >= 2 vertices. */
export function profileReducer(s: ProfileDraw, e: ProfileEvent): ProfileDraw {
  switch (e.type) {
    case 'click':
      return s.mode === 'ready' ? { mode: 'drawing', pts: [e.at] } : { mode: 'drawing', pts: [...s.pts, e.at] };
    case 'finish': {
      const pts = dropTrailingDuplicates(s.pts, e.toPixel);
      if (s.mode !== 'drawing' || pts.length < 2) return { ...s, pts };
      return { mode: 'ready', pts };
    }
    case 'move':
      if (e.index < 0 || e.index >= s.pts.length) return s;
      return { ...s, pts: s.pts.map((p, i) => (i === e.index ? e.at : p)) };
    case 'clear':
      return PROFILE_IDLE;
  }
}
