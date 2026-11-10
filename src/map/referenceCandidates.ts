/**
 * Stable reference candidates (GET /reference_candidates), independent of the map library:
 * the request, choosing a candidate as the reference, and the list's numbers.
 * Used by Main › Reference Point and by the candidate markers on both maps.
 */
import { withDataset } from '../hooks/useApi';
import type { AppAction, AppState, RefCandidate } from '../types';
import { referenceValues, type RefApi } from './interactions';

/** The circle the search judges when the reference buffer is off: about the viewer's default sample. */
export const DEFAULT_CANDIDATE_RADIUS_M = 100;
export const DEFAULT_CANDIDATE_COUNT = 5;

/** The radius to search with: the reference buffer's when it is on, else the default. */
export function candidateRadius(state: Pick<AppState, 'refBufferEnabled' | 'refBufferRadius'>): number {
  return state.refBufferEnabled && state.refBufferRadius > 0
    ? Math.min(state.refBufferRadius, 5000)
    : DEFAULT_CANDIDATE_RADIUS_M;
}

export function referenceCandidatesUrl(radiusM: number, n = DEFAULT_CANDIDATE_COUNT): string {
  const params = withDataset(new URLSearchParams({ radius_m: String(radiusM), n: String(n) }));
  return `/reference_candidates?${params}`;
}

export interface CandidatesStatus {
  state: 'idle' | 'running' | 'ready' | 'unavailable';
  progress: number;
}

/** How far the server is in preparing the per-pixel statistics; null if it cannot say. */
export async function fetchCandidatesStatus(): Promise<CandidatesStatus | null> {
  try {
    const res = await fetch(`/reference_candidates/status?${withDataset(new URLSearchParams())}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The busy button's label: the preparation's progress while it runs. */
export function busyLabel(status: CandidatesStatus | null): string {
  if (status?.state === 'running') {
    return `Preparing… ${Math.min(99, Math.round(status.progress * 100))}%`;
  }
  return 'Finding a stable reference…';
}

/** Ask the server for candidates; throws with the server's message on failure. */
export async function fetchReferenceCandidates(radiusM: number, n = DEFAULT_CANDIDATE_COUNT): Promise<RefCandidate[]> {
  const res = await fetch(referenceCandidatesUrl(radiusM, n));
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return (await res.json()).candidates ?? [];
}

/**
 * Make ``c`` the reference: move the marker there and, when it was judged on a circle,
 * sample around the marker with that radius.
 */
export function candidateActions(c: RefCandidate): AppAction[] {
  const actions: AppAction[] = [{ type: 'SET_REF_MARKER_POSITION', payload: [c.lat, c.lon] }];
  if (c.radius_m > 0) {
    actions.push({ type: 'SET_REF_BUFFER_ENABLED', payload: true });
    actions.push({ type: 'SET_REF_BUFFER_RADIUS', payload: Math.round(c.radius_m) });
  }
  return actions;
}

/** Choose ``c``: dispatch candidateActions, then the new reference values for the layer. */
export async function chooseCandidate(
  state: Pick<AppState, 'currentDataset' | 'datasetInfo' | 'refBufferEnabled' | 'refBufferRadius'>,
  c: RefCandidate,
  api: RefApi,
  dispatch: (a: AppAction) => void,
): Promise<void> {
  candidateActions(c).forEach(dispatch);
  const ds = state.currentDataset;
  if (!ds || !state.datasetInfo[ds]?.uses_spatial_ref) return;
  const buffer = c.radius_m > 0
    ? { refBufferEnabled: true, refBufferRadius: Math.round(c.radius_m) }
    : { refBufferEnabled: state.refBufferEnabled, refBufferRadius: state.refBufferRadius };
  try {
    const values = await referenceValues({ ...state, ...buffer }, ds, [c.lat, c.lon], api);
    if (values) dispatch({ type: 'SET_REF_VALUES', payload: { dataset: ds, values } });
  } catch (err) {
    console.error('Error setting the reference values of a candidate:', err);
  }
}

/** Great-circle distance in metres between two [lat, lon] positions. */
export function distanceM([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Whether the reference marker sits on ``c`` (within a metre). */
export function isCurrentReference(position: [number, number], c: RefCandidate): boolean {
  return distanceM(position, [c.lat, c.lon]) < 1;
}

/** The candidate's map marker: its rank in a disc, the recommended one filled. */
export function candidateMarkerHtml(c: RefCandidate): string {
  const cls = c.rank === 1 ? 'ref-cand-marker recommended' : 'ref-cand-marker';
  return `<div class="${cls}">${c.rank}</div>`;
}

export function candidateMarkerTitle(c: RefCandidate): string {
  return `${c.rank === 1 ? 'Recommended reference' : `Reference candidate ${c.rank}`}: ${c.reason}. Click to use it.`;
}
