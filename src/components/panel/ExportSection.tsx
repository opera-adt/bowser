import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { downloadLayer, type ExportFormat } from '../../map/exportLayer';
import { SectionHeader } from './controls';
import { exportFilename } from '../../utils/exportFilename';
import { saveFile } from '../../utils/saveFile';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'geojson', label: 'GeoJSON' }, { value: 'csv', label: 'CSV' }, { value: 'kml', label: 'KML' }, { value: 'shapefile', label: 'Shapefile (.zip)' },
];

/** Give up on a GeoTIFF export that hasn't finished after this long. */
export const EXPORT_TIMEOUT_MS = 120_000;
const TIMEOUT_MESSAGE = `The server didn't answer within ${EXPORT_TIMEOUT_MS / 60_000} minutes — try again, or check that Bowser is still running.`;

/** Bytes as a short size: 512 B, 3.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a response body, reporting bytes as they arrive. Stops when `signal` aborts. */
async function readBody(res: Response, signal: AbortSignal, onBytes: (received: number) => void): Promise<Blob> {
  const reader = res.body?.getReader?.();
  if (!reader) return res.blob();
  const stop = () => { reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', stop);
  try {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onBytes(received);
    }
    return new Blob(chunks as BlobPart[], { type: res.headers?.get('Content-Type') ?? 'image/tiff' });
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Saving the data layer (GeoTIFF) and vector layers (GeoJSON, CSV, KML, Shapefile). */
export default function ExportSection() {
  const { state } = useAppContext();
  const [exporting, setExporting] = useState(false);
  // Progress of the running export: seconds since it started, bytes so far, total if known.
  const [elapsed, setElapsed] = useState(0);
  const [received, setReceived] = useState<{ bytes: number; total: number | null } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const abortRef = useRef<{ controller: AbortController; reason: 'cancel' | 'timeout' | null } | null>(null);
  useEffect(() => () => { abortRef.current?.controller.abort(); }, []);
  // bowser-lite (the desktop app's server) can't write GeoTIFFs: /config says so.
  const [canExport, setCanExport] = useState(true);
  useEffect(() => {
    let live = true;
    fetch('/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => { if (live && cfg?.geotiff_export === false) setCanExport(false); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  // Export the active layer as a GeoTIFF, mirroring the tile request's masking
  // params so the file matches what's rendered (recommended + layer + custom masks).
  const handleExportGeoTIFF = useCallback(async () => {
    if (!state.currentDataset) return;
    const run = { controller: new AbortController(), reason: null as 'cancel' | 'timeout' | null };
    abortRef.current = run;
    const started = Date.now();
    setExporting(true);
    setElapsed(0);
    setReceived(null);
    setExportError(null);
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const timeout = setTimeout(() => { run.reason = 'timeout'; run.controller.abort(); }, EXPORT_TIMEOUT_MS);
    try {
      const params = new URLSearchParams();
      params.set('variable', state.currentDataset);
      params.set('time_idx', String(state.currentTimeIndex));
      const datasetId = new URLSearchParams(window.location.search).get('dataset');
      if (datasetId) params.set('dataset', datasetId);
      if (state.layerMasks.length > 0) {
        params.set('layer_masks', JSON.stringify(
          state.layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode }))
        ));
      }
      if (state.customMaskPath) params.set('custom_mask_path', state.customMaskPath);
      const info = state.datasetInfo[state.currentDataset];
      if (state.refEnabled && info?.uses_spatial_ref && info.algorithm === 'shift') {
        params.set('ref_lat', String(state.refMarkerPosition[0]));
        params.set('ref_lon', String(state.refMarkerPosition[1]));
        if (state.refBufferEnabled && state.refBufferRadius > 0) {
          params.set('ref_buffer_m', String(state.refBufferRadius));
        }
      }

      const { signal } = run.controller;
      const res = await fetch(`/export/geotiff?${params.toString()}`, { signal });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(typeof error?.detail === 'string' ? error.detail : `HTTP ${res.status}`);
      }
      const length = Number(res.headers?.get('Content-Length'));
      const total = length > 0 ? length : null;
      const blob = await readBody(res, signal, bytes => setReceived({ bytes, total }));
      if (signal.aborted) return;
      await saveFile(blob, exportFilename(res.headers.get('Content-Disposition'), state.currentDataset));
    } catch (err) {
      if (run.reason === 'timeout') { setExportError(TIMEOUT_MESSAGE); return; }
      if (run.reason === 'cancel') return;
      console.error('GeoTIFF export failed:', err);
      alert(`GeoTIFF export failed: ${(err as Error).message}`);
    } finally {
      clearInterval(tick);
      clearTimeout(timeout);
      if (abortRef.current === run) abortRef.current = null;
      setExporting(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, state.layerMasks, state.customMaskPath,
    state.datasetInfo, state.refEnabled, state.refMarkerPosition,
    state.refBufferEnabled, state.refBufferRadius]);

  const cancelExport = useCallback(() => {
    const run = abortRef.current;
    if (!run) return;
    run.reason = 'cancel';
    run.controller.abort();
  }, []);

  const vectors = state.overlays.filter(o => o.type === 'vector' && o.data?.features.length);
  const [format, setFormat] = useState<ExportFormat>('geojson');

  return (
    <div className="sidebar-section">
      <SectionHeader label="Export" />
      {(
        <>
          <button className="hist-btn" style={{ width: '100%' }}
            disabled={!state.currentDataset || exporting || !canExport}
            title={canExport
              ? 'Download native values with active masks and the selected spatial reference; reference details are saved in the GeoTIFF'
              : 'GeoTIFF export needs the full Bowser server (bowser run)'}
            onClick={handleExportGeoTIFF}>
            <i className={`fa-solid ${exporting ? 'fa-spinner fa-spin' : 'fa-download'}`} style={{ marginRight: 6 }}></i>
            {exporting ? 'Exporting…' : 'Data layer (GeoTIFF)'}
          </button>
          {exporting && (
            <div className="toggle-row" style={{ gap: 8 }}>
              <span className="row-label" style={{ fontSize: '0.72em' }}>
                Exporting… {elapsed} s
                {received && ` · ${formatBytes(received.bytes)}${received.total
                  ? ` of ${formatBytes(received.total)} (${Math.min(100, Math.round(received.bytes / received.total * 100))}%)`
                  : ''}`}
              </span>
              <button type="button" className="hist-btn" style={{ flex: 'none' }} onClick={cancelExport}>Cancel</button>
            </div>
          )}
          {exportError && (
            <div className="row-label" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{exportError}</div>
          )}
          {!canExport && (
            <div className="row-label" style={{ fontSize: '0.72em', textAlign: 'center' }}>
              GeoTIFF export needs the full Bowser server (<code>bowser run</code>)
            </div>
          )}
          {canExport && (state.layerMasks.length > 0 || state.customMaskPath) && (
            <div className="row-label" style={{ fontSize: '0.72em', textAlign: 'center' }}>masking will be applied</div>
          )}
          <div className="minmax-label" style={{ marginTop: 4 }}>Vector layers</div>
          {vectors.length === 0 ? (
            <div className="row-label" style={{ fontSize: '0.74em' }}>Files you add and shapes you draw can be saved here.</div>
          ) : (
            <>
              <select className="sidebar-select" value={format} aria-label="Format" onChange={e => setFormat(e.target.value as ExportFormat)}>
                {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              {vectors.map(o => (
                <div key={o.id} className="toggle-row" style={{ gap: 8 }}>
                  <span className="ov-name" title={o.name}>{o.name}</span>
                  <button type="button" className="hist-btn" style={{ flex: 'none' }}
                    onClick={() => downloadLayer(o.name, o.data!.features as never, format)}>Save</button>
                </div>
              ))}
              {format === 'csv' && <div className="row-label" style={{ fontSize: '0.72em' }}>One row per shape: its point (or first vertex) and attributes.</div>}
            </>
          )}
        </>
      )}
    </div>
  );
}
