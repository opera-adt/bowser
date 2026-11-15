import { useEffect, useState } from 'react';
import { useAppDispatch, useAppFields, useGetAppState } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { applicableMasks } from '../utils/maskCompatibility';
import { candidateRadius, chooseCandidate, fetchReferenceCandidates } from '../map/referenceCandidates';

/**
 * Why a chart of points is empty while masks are on. Usually the masks hide the points. But a
 * series is taken relative to the reference point, so when the masks hide *that* on every date,
 * every point's series is empty wherever the point is: a cube that records no reference starts
 * with it in the middle of the data, which may be water. Then the way out is to move the
 * reference, not to remove the masks.
 */
export default function MaskedReferenceNotice({ datasets }: { datasets: string[] }) {
  const state = useAppFields('datasetInfo', 'layerMasks', 'refBufferEnabled', 'refEnabled', 'refMarkerPosition');
  const dispatch = useAppDispatch();
  const getState = useGetAppState();
  const { fetchMultiPointTimeSeries, fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  // The layer whose series are referenced, if any; a reference circle is not judged by its centre.
  const layer = state.refEnabled && !state.refBufferEnabled
    ? datasets.find(ds => state.datasetInfo[ds]?.uses_spatial_ref) ?? null : null;
  const [lat, lon] = state.refMarkerPosition;
  const masks = layer ? applicableMasks(state.datasetInfo[layer], state.layerMasks) : [];
  const masksKey = JSON.stringify(masks.map(m => [m.dataset, m.threshold, m.mode]));
  const [referenceMasked, setReferenceMasked] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReferenceMasked(false);
    if (!layer || masks.length === 0) return;
    let stale = false;
    // The reference's own series under the masks, not referenced to anything.
    void fetchMultiPointTimeSeries([{ id: 'reference', lat, lon, color: '#000000', name: 'reference' }], layer,
      undefined, undefined, false, masks).then(reply => {
      if (!stale && reply) setReferenceMasked(reply.datasets.every(series => series.data.length === 0));
    });
    return () => { stale = true; };
  }, [layer, lat, lon, masksKey, fetchMultiPointTimeSeries]);  // eslint-disable-line react-hooks/exhaustive-deps

  const moveReference = async () => {
    setMoving(true);
    setError(null);
    try {
      const now = getState();
      const [best] = await fetchReferenceCandidates(candidateRadius(now), 1);
      if (!best) throw new Error('No stable place was found for the reference point.');
      await chooseCandidate(now, best, { fetchPointTimeSeries, fetchBufferTimeSeries }, dispatch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  };
  const removeMasks = () => state.layerMasks.forEach(m => dispatch({ type: 'REMOVE_LAYER_MASK', payload: m.id }));
  const masksOn = <p><small>Masks on: {state.layerMasks.map(m => m.dataset).join(', ')} (Main › Masking).</small></p>;

  if (!referenceMasked) {
    return (
      <>
        <p>Masking hides every date at the selected points.</p>
        {masksOn}
        <button type="button" className="hist-btn" style={{ flex: 'none', marginTop: 6 }} onClick={removeMasks}>Remove the masks</button>
      </>
    );
  }
  return (
    <>
      <p>The reference point is masked on every date, so no series can be taken relative to it.</p>
      {masksOn}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 6 }}>
        <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={moving} onClick={() => void moveReference()}
          title="Find a coherent, stable place and move the reference point there">
          {moving ? 'Finding a stable place…' : 'Move the reference point'}
        </button>
        <button type="button" className="hist-btn" style={{ flex: 'none' }} onClick={removeMasks}>Remove the masks</button>
      </div>
      {error && <p><small style={{ color: 'var(--sb-red)' }}>{error}</small></p>}
    </>
  );
}
