import { useEffect, useRef, useState } from 'react';
import { useAppFields } from '../../context/AppContext';
import { useViewBounds } from '../../map/viewBounds';
import { activeRefTime } from '../../utils/refDate';
import { applicableMasks } from '../../utils/maskCompatibility';
import { exportFilename } from '../../utils/exportFilename';
import { saveFile } from '../../utils/saveFile';
import { useSpacedEffect } from '../../hooks/useSpacedEffect';

/** First GIF contribution: scalar raster only; no hidden viewer-state changes. */
export default function AnimationExport() {
  const state = useAppFields('colormap', 'currentDataset', 'customMaskPath', 'dataMode', 'datasetInfo', 'layerMasks', 'refBufferEnabled', 'refBufferRadius', 'refEnabled', 'refMarkerPosition', 'refTimeIndex', 'timeSeriesPoints', 'vmax', 'vmin', 'wrapEnabled');
  const viewBounds = useViewBounds();
  const [supported, setSupported] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [fps, setFps] = useState(2);
  const [includePoints, setIncludePoints] = useState(false);
  const [crop, setCrop] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [plan, setPlan] = useState<{ key: string; error?: string; width?: number; height?: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const layer = state.currentDataset;
  const info = layer ? state.datasetInfo?.[layer] : undefined;
  const labels = info?.x_values ?? [];
  useEffect(() => {
    const request = new AbortController();
    fetch('/config', { signal: request.signal }).then(async r => {
      if (r.ok) {
        const capability = await r.json();
        if (!request.signal.aborted) setSupported(capability.raster_animation === true);
      }
    }).catch(() => undefined);
    return () => { request.abort(); controller.current?.abort(); };
  }, []);
  useEffect(() => { setStart(Math.max(0, labels.length - 30)); setEnd(Math.max(0, labels.length - 1)); }, [layer, labels.length]);
  const complex = info?.algorithm === 'phase' || info?.algorithm === 'amplitude';
  const count = end - start + 1;
  const visiblePoints = state.timeSeriesPoints?.filter(p => p.visible) ?? [];
  const invalidPoints = includePoints && (visiblePoints.length < 1 || visiblePoints.length > 5);
  const unsupportedMask = !!state.customMaskPath || (state.dataMode === 'cog' && info?.mask_file_list?.some(Boolean));
  const basicEligible = !invalidPoints && supported && !!layer && labels.length >= 2 && count >= 2 && count <= 90 && !state.wrapEnabled && !complex && !unsupportedMask && Number.isFinite(state.vmin) && Number.isFinite(state.vmax) && state.vmax > state.vmin && (!crop || !!viewBounds);
  const ref = state.refEnabled && info?.uses_spatial_ref && info.algorithm === 'shift';
  const refTime = info ? activeRefTime(info, state.refTimeIndex?.[layer], state.dataMode) : null;
  const b = crop ? viewBounds : null;
  const body = {
    variable: layer, start_index: start, end_index: end, fps,
    vmin: state.vmin, vmax: state.vmax, colormap: state.colormap,
    bounds: b ? [b[1], b[0], b[3], b[2]] : null,
    layer_masks: applicableMasks(info, state.layerMasks).map(({ dataset, threshold, mode }) => ({ dataset, threshold, mode })),
    custom_mask_path: state.customMaskPath,
    ...(includePoints ? { points: visiblePoints.map(p => ({ id: p.id, name: p.name, color: p.color,
      lat: p.position[0], lon: p.position[1] })) } : {}),
    ...(ref ? { ref_lon: state.refMarkerPosition[1], ref_lat: state.refMarkerPosition[0],
      ref_buffer_m: state.refBufferEnabled ? state.refBufferRadius : 0 } : {}),
    ...(refTime === null ? {} : { ref_time_idx: refTime }),
  };
  const catalog = new URLSearchParams(location.search).get('dataset');
  const suffix = catalog ? `?dataset=${encodeURIComponent(catalog)}` : '';
  const bodyKey = JSON.stringify(body);
  const planKey = suffix + bodyKey;
  useSpacedEffect(() => {
    if (!basicEligible || busy) return;
    const request = new AbortController();
    setPlan(null);
    fetch(`/export/animation/plan${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyKey, signal: request.signal,
    }).then(async response => {
      const result = await response.json();
      if (request.signal.aborted) return;
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'The selected GIF settings could not be validated.');
      setPlan({ key: planKey, width: result.output_width, height: result.output_height });
    }).catch(e => { if (!request.signal.aborted) setPlan({ key: planKey, error: (e as Error).message }); });
    return () => request.abort();
  }, [basicEligible, busy, bodyKey, suffix, planKey], 250, () => setPlan(null));
  const eligible = basicEligible && plan?.key === planKey && !plan.error;

  const download = async () => {
    if (!eligible || !info || !layer) return;
    const request = new AbortController();
    controller.current = request;
    const timer = setTimeout(() => request.abort(), 180_000);
    const began = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now()-began)/1000)), 1000);
    setBusy(true); setError(''); setElapsed(0);
    try {
      const response = await fetch(`/export/animation${catalog ? `?dataset=${encodeURIComponent(catalog)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyKey, signal: request.signal,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new Error(typeof problem?.detail === 'string' ? problem.detail : `GIF export failed (HTTP ${response.status})`);
      }
      if (!response.headers.get('Content-Type')?.startsWith('image/gif')) throw new Error('The server did not return a GIF.');
      const blob = await response.blob();
      if (!request.signal.aborted) await saveFile(blob, exportFilename(response.headers.get('Content-Disposition'), layer, 'gif'));
    } catch (e) {
      setError(request.signal.aborted ? 'Download canceled. A bounded render may still finish on the server.' : (e as Error).message);
    } finally {
      clearTimeout(timer); clearInterval(tick); controller.current = null; setBusy(false);
    }
  };

  if (!supported) return null;
  return <div style={{ marginTop: 10 }}>
    <div className="minmax-label">Raster animation (GIF)</div>
    <>
      <div className="row-label" style={{ fontSize: '0.74em' }}>
        Uses the current color limits, named quality masks and reference. Opaque raster only: no basemap, terrain background or imported annotations.
      </div>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: '6px 0', display: 'grid', gap: 6 }}>
        <label className="row-label">From saved epoch
          <select className="sidebar-select" aria-label="GIF first epoch" value={start} onChange={e => setStart(Number(e.target.value))}>
            {labels.map((label, i) => <option key={i} value={i}>{String(label)}</option>)}
          </select>
        </label>
        <label className="row-label">Through saved epoch
          <select className="sidebar-select" aria-label="GIF last epoch" value={end} onChange={e => setEnd(Number(e.target.value))}>
            {labels.map((label, i) => <option key={i} value={i}>{String(label)}</option>)}
          </select>
        </label>
        <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>Frames per second
          <input aria-label="GIF frames per second" style={{ width: 60 }} type="number" min="0.5" max="10" step="0.5" value={fps}
            onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.5 && value <= 10) setFps(value); }} />
        </label>
        <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input aria-label="Crop GIF to current view" type="checkbox" checked={crop} onChange={e => setCrop(e.target.checked)} /> Crop to current view</label>
        <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input aria-label="Include point histories in GIF" type="checkbox" checked={includePoints} onChange={e => setIncludePoints(e.target.checked)} />
          Include point histories
        </label>
        {includePoints && <div className="row-label">Uses 1–5 visible point locations as individual native pixels, not buffer or polygon averages. Missing values stay gaps.</div>}
      </fieldset>
      <button type="button" className="hist-btn" style={{ width: '100%' }} disabled={!eligible || busy} onClick={download}>
        <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-download'}`} style={{ marginRight: 6 }}></i>
        {busy ? 'Rendering GIF…' : 'Download raster GIF'}
      </button>
      {busy && <div className="toggle-row" style={{ gap: 8 }}>
        <span className="row-label">Rendering… {elapsed} s</span>
        <button type="button" className="hist-btn" onClick={() => controller.current?.abort()}>Cancel</button>
      </div>}
      {!busy && basicEligible && plan?.key !== planKey && <div className="row-label">Checking read and display limits…</div>}
      {!busy && plan?.key === planKey && plan.error && <div role="alert" className="row-label">{plan.error}</div>}
      {!busy && eligible && <div className="row-label">{count} frames · {plan?.width} × {plan?.height} output pixels</div>}
      {unsupportedMask && <div className="row-label">Uploaded/configured GeoTIFF masks need a later GIF contribution. Use native GeoTIFF export for these settings.</div>}
      {invalidPoints && <div className="row-label">Point histories need 1–5 visible points: {visiblePoints.length === 0 ? 'click the map to add one, or show one in the Points panel' : `${visiblePoints.length} are visible, hide some in the Points panel`}.</div>}
      {!basicEligible && !invalidPoints && <div className="row-label">Choose 2–90 saved epochs from a real-valued time series, with Rewrap off.</div>}
      {error && <div role="alert" className="row-label" style={{ color: 'var(--sb-red)' }}>{error}</div>}
    </>
  </div>;
}
