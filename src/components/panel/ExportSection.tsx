import { useCallback, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { downloadLayer, type ExportFormat } from '../../map/exportLayer';
import { SectionHeader } from './controls';
import { saveFile } from '../../utils/saveFile';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'geojson', label: 'GeoJSON' }, { value: 'csv', label: 'CSV' }, { value: 'kml', label: 'KML' }, { value: 'shapefile', label: 'Shapefile (.zip)' },
];

/** Saving the data layer (GeoTIFF) and vector layers (GeoJSON, CSV, KML, Shapefile). */
export default function ExportSection() {
  const { state } = useAppContext();
  const [exporting, setExporting] = useState(false);

  // Export the active layer as a GeoTIFF, mirroring the tile request's masking
  // params so the file matches what's rendered (recommended + layer + custom masks).
  const handleExportGeoTIFF = useCallback(async () => {
    if (!state.currentDataset) return;
    setExporting(true);
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

      const res = await fetch(`/export/geotiff?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const masked = state.layerMasks.length > 0 || !!state.customMaskPath;
      // Name the file by the layer's actual time label (e.g. a date or
      // reference_secondary pair) rather than the bare slice index; fall back
      // to `t<index>` for datasets without a time axis. Sanitize for a path:
      // strip the time-of-day after `T` and replace filename-unsafe chars.
      const timeVal = state.datasetInfo[state.currentDataset]?.x_values?.[state.currentTimeIndex];
      const timeToken = timeVal == null
        ? `t${state.currentTimeIndex}`
        : String(timeVal).split('T')[0].replace(/[^0-9A-Za-z._-]/g, '-');
      await saveFile(blob, `${state.currentDataset}_${timeToken}${masked ? '_masked' : ''}.tif`);
    } catch (err) {
      console.error('GeoTIFF export failed:', err);
      alert(`GeoTIFF export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, state.layerMasks, state.customMaskPath, state.datasetInfo]);

  const vectors = state.overlays.filter(o => o.type === 'vector' && o.data?.features.length);
  const [format, setFormat] = useState<ExportFormat>('geojson');

  return (
    <div className="sidebar-section">
      <SectionHeader label="Export" />
      {(
        <>
          <button className="hist-btn" style={{ width: '100%' }}
            disabled={!state.currentDataset || exporting}
            title="Download the active layer as a GeoTIFF (masking applied if enabled)"
            onClick={handleExportGeoTIFF}>
            <i className={`fa-solid ${exporting ? 'fa-spinner fa-spin' : 'fa-download'}`} style={{ marginRight: 6 }}></i>
            {exporting ? 'Exporting…' : 'Data layer (GeoTIFF)'}
          </button>
          {(state.layerMasks.length > 0 || state.customMaskPath) && (
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
