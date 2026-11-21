import { captureAnimationContext } from '../../map/animationContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppFields, useGetAppState } from '../../context/AppContext';
import { useViewBounds } from '../../map/viewBounds';
import { activeRefTime } from '../../utils/refDate';
import { applicableMasks } from '../../utils/maskCompatibility';
import { exportFilename } from '../../utils/exportFilename';
import { saveFile } from '../../utils/saveFile';
import { useSpacedEffect } from '../../hooks/useSpacedEffect';
import { errorDetail } from '../../utils/errorDetail';
import type { Overlay } from '../../types';

// The server's outline limits (src/bowser/animation_vectors.py and animation.py), checked
// here first so an oversized layer is named and never sent.
const MAX_OUTLINE_LAYERS = 5;
const MAX_OUTLINE_GEOMETRIES = 100;
const MAX_OUTLINE_VERTICES = 5000;

function countVertices(coordinates: unknown): number {
  if (!Array.isArray(coordinates)) return 0;
  if (typeof coordinates[0] === 'number') return 1;
  let total = 0;
  for (const part of coordinates) total += countVertices(part);
  return total;
}

/**
 * Visible vector layers as GIF outlines: the request JSON when they fit the server's
 * limits, otherwise the reason naming the layer. Server-tiled layers are listed apart:
 * their features are not in the page.
 */
function outlineSelection(overlays: Overlay[] | undefined) {
  const shown = overlays?.filter(o => o.visible && o.opacity > 0) ?? [];
  const tiled = shown.filter(o => o.type === 'pmtiles' && o.pmtilesKind === 'vector').map(o => o.name);
  const layers = shown.filter(o => o.type === 'vector' && (!o.conversion || o.conversion.status === 'ready')
    && o.data?.features.length);
  if (layers.length < 1 || layers.length > MAX_OUTLINE_LAYERS) return { count: layers.length, tiled, problem: null, json: null };
  const payload = [];
  let total = 0;
  const vertices: string[] = [];
  for (const o of layers) {
    const geometries = o.data!.features.map(f => (f as GeoJSON.Feature)?.geometry).filter(g => g != null);
    if (geometries.length > MAX_OUTLINE_GEOMETRIES) {
      return { count: layers.length, tiled, json: null,
        problem: `“${o.name}” has ${geometries.length.toLocaleString('en-US')} features; outlines take at most ${MAX_OUTLINE_GEOMETRIES} per layer.` };
    }
    const n = geometries.reduce((sum, g) => sum + countVertices('coordinates' in g ? g.coordinates : null), 0);
    if (n > MAX_OUTLINE_VERTICES) {
      return { count: layers.length, tiled, json: null,
        problem: `“${o.name}” has ${n.toLocaleString('en-US')} vertices; outlines take at most ${MAX_OUTLINE_VERTICES.toLocaleString('en-US')} in total.` };
    }
    total += n;
    vertices.push(`“${o.name}” ${n.toLocaleString('en-US')}`);
    payload.push({ name: o.name.slice(0, 80),
      geometries: geometries.map(g => ({ type: g.type, ...('coordinates' in g ? { coordinates: g.coordinates } : {}) })) });
  }
  if (total > MAX_OUTLINE_VERTICES) {
    return { count: layers.length, tiled, json: null,
      problem: `Outlines have ${total.toLocaleString('en-US')} vertices (${vertices.join(', ')}); at most ${MAX_OUTLINE_VERTICES.toLocaleString('en-US')} in total.` };
  }
  return { count: layers.length, tiled, problem: null, json: JSON.stringify(payload) };
}

/** Name the offending annotation before any export request is sent. */
export function animationLabelProblem(annotations: { text: string }[]): string | null {
  if (annotations.length > 20) return `Text annotations: ${annotations.length} labels; at most 20 can be exported. Hide or remove extra labels.`;
  for (const [i, a] of annotations.entries()) {
    if (!a.text || a.text.length > 80) return `Annotation ${i + 1} (“${a.text.slice(0, 40)}”): use 1–80 characters before exporting.`;
  }
  return null;
}

/** First GIF contribution: scalar raster only; no hidden viewer-state changes. */
export default function AnimationExport() {
  const state = useAppFields('annotations', 'colormap', 'currentDataset', 'customMaskPath', 'dataMode', 'datasetInfo', 'layerMasks', 'overlays', 'refBufferEnabled', 'refBufferRadius', 'refEnabled', 'refMarkerPosition', 'refTimeIndex', 'timeSeriesPoints', 'vmax', 'vmin', 'wrapEnabled');
  const getState = useGetAppState();
  const viewBounds = useViewBounds();
  const [supported, setSupported] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [fps, setFps] = useState(2);
  const [includeLabels, setIncludeLabels] = useState(false);
  const [includeContext, setIncludeContext] = useState(false);
  const [includeOutlines, setIncludeOutlines] = useState(false);
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
  // Counted and serialized only when the box is ticked and the overlays change, not on every render.
  const outlines = useMemo(() => includeOutlines ? outlineSelection(state.overlays) : null, [includeOutlines, state.overlays]);
  const invalidOutlines = !!outlines && (outlines.count < 1 || outlines.count > MAX_OUTLINE_LAYERS);
  const outlineProblem = outlines?.problem ?? null;
  const invalidPoints = includePoints && (visiblePoints.length < 1 || visiblePoints.length > 5);
  const labelProblem = includeLabels ? animationLabelProblem(state.annotations) : null;
  const basicEligible = !labelProblem && (!includeContext || crop) && !invalidOutlines && !outlineProblem && !invalidPoints && supported && !!layer && labels.length >= 2 && count >= 2 && count <= 90 && !state.wrapEnabled && !complex && Number.isFinite(state.vmin) && Number.isFinite(state.vmax) && state.vmax > state.vmin && (!crop || !!viewBounds);
  const ref = state.refEnabled && info?.uses_spatial_ref && info.algorithm === 'shift';
  const refTime = info ? activeRefTime(info, state.refTimeIndex?.[layer], state.dataMode) : null;
  const b = crop ? viewBounds : null;
  const body = {
    ...(includeLabels ? { labels: state.annotations.map(a=>({ text:a.text,lon:a.position[1],lat:a.position[0],color:a.color,font_size:a.fontSize })) } : {}),
    ...(includeContext ? { include_context: true } : {}),
    variable: layer, start_index: start, end_index: end, fps,
    vmin: state.vmin, vmax: state.vmax, colormap: state.colormap,
    bounds: b ? [b[1], b[0], b[3], b[2]] : null,
    layer_masks: applicableMasks(info, state.layerMasks).map(({ dataset, threshold, mode }) => ({ dataset, threshold, mode })),
    custom_mask_path: state.customMaskPath,
    ...(state.dataMode === 'cog' && info?.mask_file_list?.some(Boolean) ? { mask_min_value: info.mask_min_value } : {}),
    ...(includePoints ? { points: visiblePoints.map(p => ({ id: p.id, name: p.name, color: p.color,
      lat: p.position[0], lon: p.position[1] })) } : {}),
    ...(ref ? { ref_lon: state.refMarkerPosition[1], ref_lat: state.refMarkerPosition[0],
      ref_buffer_m: state.refBufferEnabled ? state.refBufferRadius : 0 } : {}),
    ...(refTime === null ? {} : { ref_time_idx: refTime }),
  };
  const catalog = new URLSearchParams(location.search).get('dataset');
  const suffix = catalog ? `?dataset=${encodeURIComponent(catalog)}` : '';
  // The outlines arrive already serialized (memoized above) and are appended as the last key.
  const bodyKey = outlines?.json ? `${JSON.stringify(body).slice(0, -1)},"outlines":${outlines.json}}` : JSON.stringify(body);
  const planKey = suffix + bodyKey;
  const latestPlanKey = useRef(planKey); latestPlanKey.current = planKey;
  useSpacedEffect(() => {
    if (!basicEligible || busy) return;
    const request = new AbortController();
    setPlan(null);
    fetch(`/export/animation/plan${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyKey, signal: request.signal,
    }).then(async response => {
      const result = await response.json();
      if (request.signal.aborted) return;
      if (!response.ok) throw new Error(errorDetail(result) ?? 'The selected GIF settings could not be validated.');
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
      const opacity = getState().opacity;
      const background = includeContext ? await captureAnimationContext(request.signal) : null;
      if (latestPlanKey.current !== planKey || (includeContext && getState().opacity !== opacity)) throw new Error('Export settings changed during capture. Review them and retry.');
      const renderedBody = background ? JSON.stringify({ ...JSON.parse(bodyKey), background, raster_opacity: opacity }) : bodyKey;
      const response = await fetch(`/export/animation${catalog ? `?dataset=${encodeURIComponent(catalog)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: renderedBody, signal: request.signal,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new Error(errorDetail(problem) ?? `GIF export failed (HTTP ${response.status})`);
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
        Uses the current color limits, named quality masks and reference. Optional background snapshots and text labels are display-only.
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
        <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input aria-label="Include vector outlines in GIF" type="checkbox" checked={includeOutlines} onChange={e => setIncludeOutlines(e.target.checked)} />
          Include visible vector outlines (black)
        </label>
        {includeOutlines && <div className="row-label">Uses 1–5 visible vector layers, at most 100 features per layer and 5,000 vertices in total. Large files drawn from server tiles are not included. Black outlines with a white halo; no fills, text labels or feature properties.</div>}
      <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input aria-label="Include text annotations (up to 20)" type="checkbox" checked={includeLabels} disabled={busy}
        onChange={e => setIncludeLabels(e.target.checked)} />Include text annotations (up to 20)</label>
      <label className="row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input aria-label="Include background and its opacity" type="checkbox" checked={includeContext} disabled={busy}
        onChange={e => setIncludeContext(e.target.checked)} />Include background and its opacity</label>
      {includeContext && <div className="row-label">Current viewport only. Keep one flat, north-up map; background tiles must be loaded. Source attribution is included. Foreground opacity follows the map.</div>}
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
      {invalidPoints && <div className="row-label">Point histories need 1–5 visible points: {visiblePoints.length === 0 ? 'click the map to add one, or show one in the Points panel' : `${visiblePoints.length} are visible, hide some in the Points panel`}.</div>}
      {invalidOutlines && <div className="row-label">Outlines need 1–5 visible vector layers: {outlines!.count > MAX_OUTLINE_LAYERS ? 'hide extra layers in Overlays' : outlines!.tiled.length ? 'add or show a smaller vector layer in Overlays' : 'add or show a vector layer in Overlays'}.</div>}
      {outlines && outlines.tiled.length > 0 && <div className="row-label">Not included in outlines, drawn from server tiles: {outlines.tiled.map(name => `“${name}”`).join(', ')}.</div>}
      {outlineProblem && <div role="alert" className="row-label">{outlineProblem}</div>}
      {includeContext && !crop && <div role="alert" className="row-label">Background export requires Crop to current view.</div>}
      {labelProblem && <div role="alert" className="row-label">{labelProblem}</div>}
      {!labelProblem && !(includeContext && !crop) && !basicEligible && !invalidPoints && !invalidOutlines && !outlineProblem && <div className="row-label">Choose 2–90 saved epochs from a real-valued time series, with Rewrap off.</div>}
      {error && <div role="alert" className="row-label" style={{ color: 'var(--sb-red)' }}>{error}</div>}
    </>
  </div>;
}
