import { useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useApi } from '../../hooks/useApi';
import type { RefCandidate } from '../../types';
import {
  DEFAULT_CANDIDATE_COUNT, candidateRadius, chooseCandidate, distanceM, fetchReferenceCandidates,
  formatDistance, isCurrentReference,
} from '../../map/referenceCandidates';

const fmt = (v: number | null, digits = 2) => (v === null || v === undefined ? '–' : v.toFixed(digits));

/**
 * Main › Reference Point: "Find a stable reference". Asks the server for the most
 * coherent, stable places (GET /reference_candidates), lists them and numbers them on
 * the map; choosing one moves the reference there and samples around it.
 */
export default function ReferenceCandidates() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = state.refCandidates ?? [];
  const radius = candidateRadius(state);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await fetchReferenceCandidates(radius, DEFAULT_CANDIDATE_COUNT);
      dispatch({ type: 'SET_REF_CANDIDATES', payload: found });
      if (!found.length) setError('No stable place found: every pixel is below the coherence thresholds.');
    } catch (e) {
      setError(`Could not find a reference: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const choose = (c: RefCandidate) =>
    void chooseCandidate(state, c, { fetchPointTimeSeries, fetchBufferTimeSeries }, dispatch);

  return (
    <div className="ref-cand">
      <button type="button" className="hist-btn" style={{ width: '100%', marginTop: 6 }} disabled={busy}
        title={`Rank the most coherent places, judged over ${radius} m circles, as reference points`}
        onClick={find}>
        <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-crosshairs'}`} style={{ marginRight: 6 }}></i>
        {busy ? 'Finding a stable reference…' : 'Find a stable reference'}
      </button>
      {error && (
        <div className="row-label" role="alert" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{error}</div>
      )}
      {candidates.length > 0 && (
        <>
          <div className="toggle-row" style={{ marginTop: 6, gap: 6 }}>
            <span className="row-label" style={{ fontSize: '0.72em' }}>
              Best {candidates.length} · {candidates[0].radius_m} m circles
            </span>
            <button type="button" className="hist-btn" style={{ flex: 'none' }}
              title={candidates[0].reason} onClick={() => choose(candidates[0])}>Use recommended</button>
            <button type="button" className="ov-icon-btn" aria-label="Clear the candidates"
              title="Clear the candidates" onClick={() => dispatch({ type: 'SET_REF_CANDIDATES', payload: [] })}>
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
          <ul className="ov-list ref-cand-list" aria-label="Reference candidates">
            {candidates.map(c => {
              const current = isCurrentReference(state.refMarkerPosition, c);
              const scatter = c.displacement_scatter_m;
              return (
                <li key={c.rank}>
                  <button type="button" className={`ov-row ref-cand-row${current ? ' current' : ''}`}
                    aria-current={current || undefined} title={`${c.reason}. Click to use it.`}
                    onClick={() => choose(c)}>
                    <span className="ov-row-head">
                      <span className={`ref-cand-marker${c.rank === 1 ? ' recommended' : ''}`}>{c.rank}</span>
                      <span className="ov-name">{c.rank === 1 ? 'Recommended' : `Candidate ${c.rank}`}</span>
                      <span className="ov-type">
                        {current ? 'reference' : `${formatDistance(distanceM(state.refMarkerPosition, [c.lat, c.lon]))} away`}
                      </span>
                    </span>
                    <span className="ov-type ref-cand-stats">
                      coh {fmt(c.temporal_coherence_median)} · sim {fmt(c.phase_similarity_median)}
                      {scatter !== null && ` · scatter ${(scatter * 1000).toFixed(1)} mm`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="row-label" style={{ fontSize: '0.7em', marginTop: 4 }}>
            Coherent is not the same as stable: check the velocity and what is on the ground.
          </div>
        </>
      )}
    </div>
  );
}
