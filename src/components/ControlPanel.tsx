import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import Histogram from './Histogram';

const colormapOptions = [
  { value: 'rdbu', label: 'Blue–Red' },
  { value: 'twilight', label: 'Twilight (cyclic)' },
  { value: 'cfastie', label: 'CFastie' },
  { value: 'rplumbo', label: 'RPlumbo' },
  { value: 'schwarzwald', label: 'Schwarzwald' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'bugn', label: 'Blue–Green' },
  { value: 'ylgn', label: 'Yellow–Green' },
  { value: 'magma', label: 'Magma' },
  { value: 'gist_earth', label: 'Earth' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'terrain', label: 'Terrain' },
  { value: 'gray', label: 'Grays' },
  { value: 'jet', label: 'Jet' },
];

// Default per-bin colors for discrete/categorical overlays.
const BIN_PALETTE = [
  '#d62728', '#ff7f0e', '#ffd92f', '#2ca02c', '#1f77b4', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#17becf', '#bcbd22', '#393b79',
];
const binColorsFor = (n: number, prev: string[] = []): string[] =>
  Array.from({ length: n }, (_, k) => prev[k] ?? BIN_PALETTE[k % BIN_PALETTE.length]);

export default function ControlPanel({ title }: { title: string }) {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [draftVmin, setDraftVmin] = useState(String(state.vmin));
  const [draftVmax, setDraftVmax] = useState(String(state.vmax));
  const [draftSplitVmin, setDraftSplitVmin] = useState(String(state.splitVmin));
  const [draftSplitVmax, setDraftSplitVmax] = useState(String(state.splitVmax));
  const [draftWrapWavelength, setDraftWrapWavelength] = useState(state.wrapWavelength !== null ? String(state.wrapWavelength) : '');
  const [draftWrapPeriod, setDraftWrapPeriod] = useState(String(state.wrapPeriod));
  const [lightTheme, setLightTheme] = useState(false);
  const [draftRefLat, setDraftRefLat] = useState(String(state.refMarkerPosition[0]));
  const [draftRefLon, setDraftRefLon] = useState(String(state.refMarkerPosition[1]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    masking: true,
    buffer: true,
    overlays: true,
    export: true,
    project: true,
  });

  // ── Project save/load: persist points, reference, annotations and masks. ──
  const PROJECT_KEYS = [
    'currentDataset', 'currentTimeIndex', 'colormap', 'vmin', 'vmax',
    'refMarkerPosition', 'refEnabled', 'refMarkerVisible',
    'timeSeriesPoints', 'annotations', 'layerMasks', 'customMaskPath',
  ] as const;
  const saveProject = useCallback(() => {
    const project: Record<string, unknown> = { bowser_project: 1, saved: new Date().toISOString() };
    PROJECT_KEYS.forEach(k => {
      // Drop cached time-series/trend values from points — they refetch on load.
      project[k] = k === 'timeSeriesPoints'
        ? state.timeSeriesPoints.map(({ data, trendData, ...rest }) => rest)
        : (state as any)[k];
    });
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bowser-project-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }, [state]);
  const loadProject = useCallback(async (file: File) => {
    try {
      const p = JSON.parse(await file.text());
      if (!p || typeof p !== 'object') throw new Error('not a bowser project file');
      const payload: Record<string, unknown> = {};
      PROJECT_KEYS.forEach(k => { if (k in p) payload[k] = p[k]; });
      dispatch({ type: 'LOAD_PROJECT', payload });
    } catch (err) {
      alert(`Could not load project: ${(err as Error).message}`);
    }
  }, [dispatch]);
  const toggleSection = (key: string) => setCollapsed(c => ({ ...c, [key]: !c[key] }));
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
      const url = URL.createObjectURL(blob);
      const masked = state.layerMasks.length > 0 || !!state.customMaskPath;
      // Name the file by the layer's actual time label (e.g. a date or
      // reference_secondary pair) rather than the bare slice index; fall back
      // to `t<index>` for datasets without a time axis. Sanitize for a path:
      // strip the time-of-day after `T` and replace filename-unsafe chars.
      const timeVal = state.datasetInfo[state.currentDataset]?.x_values?.[state.currentTimeIndex];
      const timeToken = timeVal == null
        ? `t${state.currentTimeIndex}`
        : String(timeVal).split('T')[0].replace(/[^0-9A-Za-z._-]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${state.currentDataset}_${timeToken}${masked ? '_masked' : ''}.tif`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('GeoTIFF export failed:', err);
      alert(`GeoTIFF export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, state.layerMasks, state.customMaskPath, state.datasetInfo]);

  // Upload a GeoTIFF as a raster overlay: store it, read band metadata, grab
  // WGS84 bounds from the tiler's tilejson, and add it with sensible defaults
  // (RGB for >=3 bands, colormap + p2/p98 rescale for single-band).
  const handleUploadRaster = useCallback(async (file: File) => {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/upload_raster', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json();
      let bounds: [number, number, number, number] | null = null;
      try {
        const tj = await fetch(
          `/overlay/WebMercatorQuad/tilejson.json?url=${encodeURIComponent(meta.path)}`
        ).then(r => r.json());
        if (Array.isArray(tj.bounds) && tj.bounds.length === 4) bounds = tj.bounds;
      } catch { /* bounds optional */ }
      const b0 = meta.bands?.[0] ?? { p2: 0, p98: 1, min: 0, max: 1 };
      dispatch({
        type: 'ADD_OVERLAY',
        payload: {
          id: `ov_${Date.now()}`,
          name: meta.name,
          type: 'geotiff',
          path: meta.path,
          bandCount: meta.band_count,
          bands: meta.bands ?? [],
          bounds,
          visible: true,
          opacity: 1,
          mode: meta.band_count >= 3 ? 'rgb' : 'cmap',
          cmap: 'viridis',
          vmin: b0.p2 ?? b0.min ?? 0,
          vmax: b0.p98 ?? b0.max ?? 1,
          discrete: false,
          nbins: 5,
          binColors: binColorsFor(5),
        },
      });
    } catch (err) {
      alert(`Raster upload failed: ${(err as Error).message}`);
    }
  }, [dispatch]);

  // Add an external WMS / WMTS(XYZ-template) overlay from a URL.
  const [extType, setExtType] = useState<'wms' | 'wmts'>('wms');
  const [extUrl, setExtUrl] = useState('');
  const [extLayers, setExtLayers] = useState('');
  const addExternalOverlay = useCallback(() => {
    // Leaflet only substitutes lowercase {x}/{y}/{z}/{s}; normalize uppercase
    // placeholders (common in WMTS/ArcGIS docs) so they don't throw.
    const url = extUrl.trim()
      .replace(/\{Z\}/g, '{z}').replace(/\{Y\}/g, '{y}')
      .replace(/\{X\}/g, '{x}').replace(/\{S\}/g, '{s}');
    if (!url) return;
    dispatch({
      type: 'ADD_OVERLAY',
      payload: {
        id: `ov_${Date.now()}`,
        name: (extType === 'wms' ? extLayers.trim() : '') || url.replace(/^https?:\/\//, '').slice(0, 30),
        type: extType,
        visible: true,
        opacity: 1,
        url,
        wmsLayers: extType === 'wms' ? extLayers.trim() : undefined,
        maxNativeZoom: 18,
      },
    });
    setExtUrl(''); setExtLayers('');
    setWmsLayerOptions([]);
  }, [extType, extUrl, extLayers, dispatch]);

  // Fetch a WMS's named layers (server-side proxy avoids browser CORS) so the
  // user can pick from a dropdown instead of knowing the layer name in advance.
  const [wmsLayerOptions, setWmsLayerOptions] = useState<{ name: string; title: string }[]>([]);
  const [wmsLoading, setWmsLoading] = useState(false);
  const fetchWmsLayers = useCallback(async () => {
    const u = extUrl.trim();
    if (!u) return;
    setWmsLoading(true);
    try {
      const res = await fetch(`/wms_capabilities?url=${encodeURIComponent(u)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const layers = (await res.json()).layers ?? [];
      setWmsLayerOptions(layers);
      if (layers.length) setExtLayers(layers[0].name);
      else alert('No named layers found in this WMS.');
    } catch (err) {
      alert(`Could not load WMS layers: ${(err as Error).message}`);
    } finally {
      setWmsLoading(false);
    }
  }, [extUrl]);
  // dataset range cache: { [datasetName]: { min, max, p2, p98 } }
  const [datasetRanges, setDatasetRanges] = useState<Record<string, { min: number; max: number; p2: number; p98: number }>>({});

  // Fetch range for any mask dataset not yet in cache
  useEffect(() => {
    const missing = state.layerMasks
      .map(m => m.dataset)
      .filter(ds => ds && !(ds in datasetRanges));
    const unique = [...new Set(missing)];
    unique.forEach(async ds => {
      try {
        const res = await fetch(`/dataset_range/${encodeURIComponent(ds)}`);
        if (res.ok) {
          const data = await res.json();
          setDatasetRanges(prev => ({ ...prev, [ds]: data }));
        }
      } catch { /* ignore */ }
    });
  }, [state.layerMasks, datasetRanges]);

  const toggleTheme = () => {
    const next = !lightTheme;
    setLightTheme(next);
    document.documentElement.setAttribute('data-theme', next ? 'light' : 'dark');
  };

  useEffect(() => setDraftVmin(String(state.vmin)), [state.vmin]);
  useEffect(() => setDraftVmax(String(state.vmax)), [state.vmax]);
  useEffect(() => setDraftSplitVmin(String(state.splitVmin)), [state.splitVmin]);
  useEffect(() => setDraftSplitVmax(String(state.splitVmax)), [state.splitVmax]);
  useEffect(() => {
    setDraftRefLat(state.refMarkerPosition[0].toFixed(6));
    setDraftRefLon(state.refMarkerPosition[1].toFixed(6));
  }, [state.refMarkerPosition]);

  useEffect(() => {
    const datasetName = state.currentDataset;
    if (!datasetName) return;

    const safeNumToString = (x: number) => (Object.is(x, -0) ? '-0' : String(x));

    localStorage.setItem(`${datasetName}-colormap_name`, state.colormap);
    localStorage.setItem(`${datasetName}-vmin`, safeNumToString(state.vmin));
    localStorage.setItem(`${datasetName}-vmax`, safeNumToString(state.vmax));
  }, [state.colormap, state.vmin, state.vmax]);

  useEffect(() => {
    const ds = state.currentDataset;
    if (!ds) return;
    const info = state.datasetInfo[ds];
    const isPhase = info?.algorithm === 'phase' || info?.algorithm === 'rewrap';
    const colormap = localStorage.getItem(`${ds}-colormap_name`);
    const vminStr = localStorage.getItem(`${ds}-vmin`);
    const vmaxStr = localStorage.getItem(`${ds}-vmax`);
    if (colormap) dispatch({ type: 'SET_COLORMAP', payload: colormap });
    if (vminStr !== null) {
      const v = Number(vminStr);
      if (!Number.isNaN(v)) dispatch({ type: 'SET_VMIN', payload: v });
    } else if (isPhase) {
      dispatch({ type: 'SET_VMIN', payload: -Math.PI });
    }
    if (vmaxStr !== null) {
      const v = Number(vmaxStr);
      if (!Number.isNaN(v)) dispatch({ type: 'SET_VMAX', payload: v });
    } else if (isPhase) {
      dispatch({ type: 'SET_VMAX', payload: Math.PI });
    }
  }, [state.currentDataset, dispatch]);

  // Seed the moving reference marker from the cube's recorded reference point
  // (reference_lonlat, [lon, lat]) the first time we see each dataset. Tracked
  // in a ref so re-selecting a dataset never clobbers a marker the user moved.
  const appliedRefDefault = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ds = state.currentDataset;
    if (!ds || appliedRefDefault.current.has(ds)) return;
    const refLonLat = state.datasetInfo[ds]?.reference_lonlat;
    appliedRefDefault.current.add(ds);
    if (!refLonLat) return;
    const [lon, lat] = refLonLat;
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lon] });
    if (state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentDataset, state.datasetInfo, dispatch]);

  // Auto-set vmin/vmax when wrap is toggled
  useEffect(() => {
    if (!state.wrapEnabled) return;
    const half = state.wrapWavelength !== null && state.wrapWavelength > 0
      ? Math.PI
      : state.wrapPeriod / 2;
    dispatch({ type: 'SET_VMIN', payload: -half });
    dispatch({ type: 'SET_VMAX', payload: half });
  }, [state.wrapEnabled, state.wrapWavelength, state.wrapPeriod, dispatch]);

  // Auto-set vmin/vmax only when the user explicitly switches Phase ↔ Amplitude.
  // Do NOT include state.currentDataset here — the dataset-change effect above
  // already handles defaults on switch, and including it here would overwrite
  // any localStorage-persisted custom range the user had saved.
  useEffect(() => {
    const info = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
    if (info?.algorithm !== 'phase' && info?.algorithm !== 'amplitude') return;
    if (state.complexMode === 'phase') {
      dispatch({ type: 'SET_VMIN', payload: -Math.PI });
      dispatch({ type: 'SET_VMAX', payload: Math.PI });
    } else {
      dispatch({ type: 'SET_VMIN', payload: 0 });
      dispatch({ type: 'SET_VMAX', payload: 1 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.complexMode, dispatch]);

  const handleDatasetChange = (ds: string) => {
    dispatch({ type: 'SET_CURRENT_DATASET', payload: ds });
    const info = state.datasetInfo[ds];
    if (info?.uses_spatial_ref) setRefValues(ds);
  };

  // Re-fetch ref values when buffer toggle or radius changes (for tile shift correction)
  useEffect(() => {
    const ds = state.currentDataset;
    if (!ds) return;
    const info = state.datasetInfo[ds];
    if (!info?.uses_spatial_ref) return;
    setRefValues(ds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.refBufferEnabled, state.refBufferRadius]);

  const commitVmin = useCallback(() => {
    const v = Number(draftVmin);
    if (!Number.isNaN(v)) dispatch({ type: 'SET_VMIN', payload: v });
  }, [draftVmin, dispatch]);

  const commitVmax = useCallback(() => {
    const v = Number(draftVmax);
    if (!Number.isNaN(v)) dispatch({ type: 'SET_VMAX', payload: v });
  }, [draftVmax, dispatch]);

  const setRefValues = async (ds: string) => {
    const [lat, lng] = state.refMarkerPosition;
    try {
      let values: number[] | undefined;
      if (state.refBufferEnabled && state.refBufferRadius > 0) {
        const result = await fetchBufferTimeSeries(lng, lat, ds, state.refBufferRadius, 0);
        if (result?.median) {
          // Re-align sparse {x,y} array back to full-length index array
          const xValues = state.datasetInfo[ds]?.x_values?.map(String) ?? result.labels?.map(String) ?? [];
          const byX = Object.fromEntries(result.median.map((pt: { x: string; y: number }) => [String(pt.x), pt.y]));
          values = xValues.map((x: string) => byX[x] ?? NaN);
        }
      }
      if (!values) {
        values = await fetchPointTimeSeries(lng, lat, ds);
      }
      if (values) dispatch({ type: 'SET_REF_VALUES', payload: { dataset: ds, values } });
    } catch (error) {
      console.error('Error setting reference values:', error);
    }
  };

  const commitRefPosition = useCallback(() => {
    const lat = parseFloat(draftRefLat);
    const lon = parseFloat(draftRefLon);
    if (isNaN(lat) || isNaN(lon)) return;
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lon] });
    const ds = state.currentDataset;
    if (ds && state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRefLat, draftRefLon, state.currentDataset, state.datasetInfo, dispatch]);

  const currentDatasetInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
  const currentTimeValue = currentDatasetInfo
    ? currentDatasetInfo.x_values[state.currentTimeIndex]
    : '';
  const splitDatasetInfo = state.splitDataset ? state.datasetInfo[state.splitDataset] : null;
  const splitTimeValue = splitDatasetInfo
    ? splitDatasetInfo.x_values[Math.min(state.splitTimeIndex, splitDatasetInfo.x_values.length - 1)]
    : '';

  const SectionHeader = ({ icon, label, collapseKey }: { icon: string; label: string; collapseKey?: string }) => (
    <div
      className="sidebar-section-label"
      style={collapseKey ? { cursor: 'pointer', userSelect: 'none' } : undefined}
      onClick={collapseKey ? () => toggleSection(collapseKey) : undefined}
    >
      <span><i className={`fa-solid ${icon}`}></i> {label}</span>
      {collapseKey && (
        <i className={`fa-solid fa-chevron-${collapsed[collapseKey] ? 'down' : 'up'}`}
          style={{ fontSize: '0.75em', color: 'var(--sb-muted)' }} />
      )}
    </div>
  );

  return (
    <div id="menu">
      <div className="sidebar-theme-toggle">
        <button className="theme-toggle-btn" onClick={toggleTheme} title={lightTheme ? 'Switch to dark theme' : 'Switch to light theme'}>
          <i className={`fa-solid ${lightTheme ? 'fa-moon' : 'fa-sun'}`}></i>
        </button>
      </div>
      {title && <div className="sidebar-title">{title}</div>}

      {/* ── LAYERS ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-layer-group" label="Layers" />
        <select className="sidebar-select" value={state.currentDataset} onChange={e => handleDatasetChange(e.target.value)}>
          {Object.keys(state.datasetInfo).map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {currentDatasetInfo && (
          <div className="slider-group">
            <div className="slider-label">
              <span>Time step</span>
              <span className="slider-value">{currentTimeValue}</span>
            </div>
            <input type="range" className="sidebar-range"
              min="0" max={currentDatasetInfo.x_values.length - 1} step="1"
              value={state.currentTimeIndex}
              onChange={e => dispatch({ type: 'SET_TIME_INDEX', payload: parseInt(e.target.value) })}
            />
          </div>
        )}
      </div>

      {/* ── VISUALIZATION ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-palette" label={state.splitScreen ? 'Left Layer' : 'Visualization'} />
        <div className="colormap-row">
          <select
            className="sidebar-select"
            value={state.colormap.endsWith('_r') ? state.colormap.slice(0, -2) : state.colormap}
            onChange={e => {
              const base = e.target.value;
              const inverted = state.colormap.endsWith('_r');
              dispatch({ type: 'SET_COLORMAP', payload: inverted ? `${base}_r` : base });
            }}
          >
            {colormapOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            className={`invert-btn${state.colormap.endsWith('_r') ? ' active' : ''}`}
            title="Invert colormap"
            onClick={() => {
              const cm = state.colormap;
              dispatch({ type: 'SET_COLORMAP', payload: cm.endsWith('_r') ? cm.slice(0, -2) : `${cm}_r` });
            }}
          >⇅</button>
        </div>
        <div className="colorbar-row">
          <input
            aria-label="Min value"
            className="sidebar-input"
            type="text"
            inputMode="decimal"
            value={draftVmin}
            onChange={e => setDraftVmin(e.target.value)}
            onBlur={commitVmin}
            onKeyDown={e => e.key === 'Enter' && commitVmin()}
          />
          <img src={`/colorbar/${state.colormap}`} className="colorbar-img" alt="Colormap" />
          <input
            aria-label="Max value"
            className="sidebar-input"
            type="text"
            inputMode="decimal"
            value={draftVmax}
            onChange={e => setDraftVmax(e.target.value)}
            onBlur={commitVmax}
            onKeyDown={e => e.key === 'Enter' && commitVmax()}
          />
        </div>
        <div className="slider-group">
          <div className="slider-label">
            <span>Opacity</span>
            <span className="slider-value">{Math.round(state.opacity * 100)}%</span>
          </div>
          <input type="range" className="sidebar-range"
            min="0" max="1" step="0.01" value={state.opacity}
            onChange={e => dispatch({ type: 'SET_OPACITY', payload: parseFloat(e.target.value) })} />
        </div>
        {currentDatasetInfo && (
          <div style={{ marginTop: 6 }}>
            {/* Phase / Amplitude toggle — only for complex (CFloat32) datasets */}
            {(currentDatasetInfo.algorithm === 'phase' || currentDatasetInfo.algorithm === 'amplitude') && (
              <div className="toggle-row" style={{ marginBottom: 6 }}>
                <span style={{ fontSize: '0.82em', color: 'var(--sb-muted)' }}>View</span>
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['phase', 'amplitude'] as const).map(mode => (
                    <button
                      key={mode}
                      className={`toggle-pill${state.complexMode === mode ? ' active' : ''}`}
                      onClick={() => dispatch({ type: 'SET_COMPLEX_MODE', payload: mode })}
                    >
                      {mode === 'phase' ? 'Phase' : 'Amplitude'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="toggle-row">
              <span style={{ fontSize: '0.82em', color: 'var(--sb-muted)' }}>Rewrap</span>
              <button
                className={`toggle-pill${state.wrapEnabled ? ' active' : ''}`}
                title="Re-wrap timeseries / unwrapped phase / velocity for fringe visualization"
                onClick={() => dispatch({ type: 'TOGGLE_WRAP' })}
              >
                {state.wrapEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {state.wrapEnabled && (
              <div style={{ marginTop: 4 }}>
                <div className="minmax-row">
                  <div className="minmax-field">
                    <label className="minmax-label" title="Wavelength in meters — multiplies data by 4π/λ before wrapping to (−π, π). Clear to use Period instead.">λ (m)</label>
                    <div style={{ display: 'flex', gap: 2 }}>
                      <input
                        className="sidebar-input"
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 0.24"
                        value={draftWrapWavelength}
                        onChange={e => setDraftWrapWavelength(e.target.value)}
                        onBlur={() => {
                          const v = parseFloat(draftWrapWavelength);
                          dispatch({ type: 'SET_WRAP_WAVELENGTH', payload: draftWrapWavelength === '' || isNaN(v) ? null : v });
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const v = parseFloat(draftWrapWavelength);
                            dispatch({ type: 'SET_WRAP_WAVELENGTH', payload: draftWrapWavelength === '' || isNaN(v) ? null : v });
                          }
                        }}
                        style={{ flex: 1 }}
                      />
                      {state.wrapWavelength !== null && (
                        <button
                          onClick={() => { setDraftWrapWavelength(''); dispatch({ type: 'SET_WRAP_WAVELENGTH', payload: null }); }}
                          title="Clear wavelength — switch to Period mode"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sb-muted)', padding: '0 2px', fontSize: '0.85em', flexShrink: 0 }}
                        >✕</button>
                      )}
                    </div>
                  </div>
                  <div className="minmax-field">
                    <label className="minmax-label" title="Modulo period for wrapping (in data units). Active when λ is empty.">Period</label>
                    <input
                      className="sidebar-input"
                      type="text"
                      inputMode="decimal"
                      placeholder={`${(2 * Math.PI).toFixed(4)}`}
                      value={draftWrapPeriod}
                      onChange={e => setDraftWrapPeriod(e.target.value)}
                      onBlur={() => {
                        const v = parseFloat(draftWrapPeriod);
                        if (!isNaN(v) && v > 0) dispatch({ type: 'SET_WRAP_PERIOD', payload: v });
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = parseFloat(draftWrapPeriod);
                          if (!isNaN(v) && v > 0) dispatch({ type: 'SET_WRAP_PERIOD', payload: v });
                        }
                      }}
                    />
                  </div>
                </div>
                <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', marginTop: 2 }}>
                  {state.wrapWavelength !== null
                    ? `scale = 4π/λ = ${(4 * Math.PI / state.wrapWavelength).toFixed(3)} rad/m → wrap to (−π, π)`
                    : `wrap period = ${state.wrapPeriod.toFixed(4)} (data units)`}
                </div>
              </div>
            )}
          </div>
        )}
        <Histogram />
      </div>

      {/* ── SPLIT SCREEN RIGHT LAYER ── */}
      {state.splitScreen && (
        <div className="sidebar-section">
          <SectionHeader icon="fa-table-columns" label="Right Layer" />

          <select
            className="sidebar-select"
            value={state.splitDataset || ''}
            onChange={e => dispatch({ type: 'SET_SPLIT_DATASET', payload: e.target.value || null })}
          >
            <option value="">— none —</option>
            {Object.entries(state.datasetInfo).map(([key, info]) => (
              <option key={key} value={key}>{info.label || key}</option>
            ))}
          </select>

          {splitDatasetInfo && (
            <div className="slider-group">
              <div className="slider-label">
                <span>Time step</span>
                <span className="slider-value">{splitTimeValue}</span>
              </div>
              <input type="range" className="sidebar-range"
                min="0" max={splitDatasetInfo.x_values.length - 1} step="1"
                value={Math.min(state.splitTimeIndex, splitDatasetInfo.x_values.length - 1)}
                onChange={e => dispatch({ type: 'SET_SPLIT_TIME_INDEX', payload: parseInt(e.target.value) })}
              />
            </div>
          )}

          {state.splitDataset && (
            <>
              <div className="colormap-row" style={{ marginTop: 6 }}>
                <select
                  className="sidebar-select"
                  value={state.splitColormap.endsWith('_r') ? state.splitColormap.slice(0, -2) : state.splitColormap}
                  onChange={e => {
                    const base = e.target.value;
                    const inv = state.splitColormap.endsWith('_r');
                    dispatch({ type: 'SET_SPLIT_COLORMAP', payload: inv ? `${base}_r` : base });
                  }}
                >
                  {colormapOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <button
                  className={`invert-btn${state.splitColormap.endsWith('_r') ? ' active' : ''}`}
                  title="Invert colormap"
                  onClick={() => {
                    const cm = state.splitColormap;
                    dispatch({ type: 'SET_SPLIT_COLORMAP', payload: cm.endsWith('_r') ? cm.slice(0, -2) : `${cm}_r` });
                  }}
                >⇅</button>
              </div>
              <div className="colorbar-row">
                <input
                  aria-label="Min value"
                  className="sidebar-input"
                  type="text" inputMode="decimal"
                  value={draftSplitVmin}
                  onChange={e => setDraftSplitVmin(e.target.value)}
                  onBlur={() => { const v = parseFloat(draftSplitVmin); if (!isNaN(v)) dispatch({ type: 'SET_SPLIT_VMIN', payload: v }); }}
                  onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(draftSplitVmin); if (!isNaN(v)) dispatch({ type: 'SET_SPLIT_VMIN', payload: v }); } }}
                />
                <img src={`/colorbar/${state.splitColormap}`} className="colorbar-img" alt="Colormap" />
                <input
                  aria-label="Max value"
                  className="sidebar-input"
                  type="text" inputMode="decimal"
                  value={draftSplitVmax}
                  onChange={e => setDraftSplitVmax(e.target.value)}
                  onBlur={() => { const v = parseFloat(draftSplitVmax); if (!isNaN(v)) dispatch({ type: 'SET_SPLIT_VMAX', payload: v }); }}
                  onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(draftSplitVmax); if (!isNaN(v)) dispatch({ type: 'SET_SPLIT_VMAX', payload: v }); } }}
                />
              </div>
              <Histogram
                dataset={state.splitDataset}
                vmin={state.splitVmin}
                vmax={state.splitVmax}
                onSetVmin={v => dispatch({ type: 'SET_SPLIT_VMIN', payload: v })}
                onSetVmax={v => dispatch({ type: 'SET_SPLIT_VMAX', payload: v })}
              />
              <div className="slider-group">
                <div className="slider-label">
                  <span>Opacity</span>
                  <span className="slider-value">{Math.round(state.splitOpacity * 100)}%</span>
                </div>
                <input
                  className="sidebar-range"
                  type="range" min="0" max="1" step="0.01"
                  value={state.splitOpacity}
                  onChange={e => dispatch({ type: 'SET_SPLIT_OPACITY', payload: parseFloat(e.target.value) })}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── REFERENCE POINT ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-crosshairs" label="Reference Point" />
        <div className="minmax-row">
          <div className="minmax-field">
            <label className="minmax-label">Lat</label>
            <input className="sidebar-input" type="text" inputMode="decimal"
              value={draftRefLat} onChange={e => setDraftRefLat(e.target.value)}
              onBlur={commitRefPosition} onKeyDown={e => e.key === 'Enter' && commitRefPosition()} />
          </div>
          <div className="minmax-field">
            <label className="minmax-label">Lon</label>
            <input className="sidebar-input" type="text" inputMode="decimal"
              value={draftRefLon} onChange={e => setDraftRefLon(e.target.value)}
              onBlur={commitRefPosition} onKeyDown={e => e.key === 'Enter' && commitRefPosition()} />
          </div>
        </div>
        {currentDatasetInfo?.reference_lonlat && (
          <button
            className="sidebar-btn"
            style={{ marginTop: 6, width: '100%', fontSize: '0.8em' }}
            title={`Reset to the cube's reference point (${currentDatasetInfo.reference_lonlat[1].toFixed(5)}, ${currentDatasetInfo.reference_lonlat[0].toFixed(5)})`}
            onClick={() => {
              const [lon, lat] = currentDatasetInfo.reference_lonlat!;
              dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lon] });
              const ds = state.currentDataset;
              if (ds && state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds);
            }}
          >
            <i className="fas fa-rotate-left" style={{ marginRight: 6 }} />
            Revert to default reference
          </button>
        )}
        <div className="toggle-row" style={{ marginTop: 6 }}>
          <span style={{ fontSize: '0.82em', color: 'var(--sb-muted)' }}>Sample around ref marker</span>
          <button className={`toggle-pill${state.refBufferEnabled ? ' active' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_REF_BUFFER' })}>
            {state.refBufferEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
        {state.refBufferEnabled && (
          <div className="slider-group">
            <div className="slider-label">
              <span>Radius</span>
              <span className="slider-value">{state.refBufferRadius} m</span>
            </div>
            <input type="range" className="sidebar-range"
              min="5" max="5000" step="5" value={state.refBufferRadius}
              onChange={e => dispatch({ type: 'SET_REF_BUFFER_RADIUS', payload: parseInt(e.target.value) })} />
          </div>
        )}
      </div>

      {/* ── MASKING (collapsible) ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-mask" label="Masking" collapseKey="masking" />
        {!collapsed.masking && (
          <>
            {state.layerMasks.map(mask => {
              const range = datasetRanges[mask.dataset];
              const rMin = range?.p2 ?? range?.min ?? 0;
              const rMax = range?.p98 ?? range?.max ?? 1;
              const step = rMax - rMin > 0 ? parseFloat(((rMax - rMin) / 200).toPrecision(2)) : 0.01;
              return (
                <div key={mask.id} className="layer-mask-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                    <select className="sidebar-select" style={{ flex: 1, fontSize: '0.78em' }}
                      value={mask.dataset}
                      onChange={e => {
                        const ds = e.target.value;
                        const newRange = datasetRanges[ds];
                        const defaultThreshold = newRange
                          ? (mask.mode === 'max' ? (newRange.p98 ?? newRange.max) : (newRange.p2 ?? newRange.min)) ?? 0.5
                          : 0.5;
                        dispatch({ type: 'UPDATE_LAYER_MASK', payload: { id: mask.id, updates: { dataset: ds, threshold: defaultThreshold } } });
                      }}>
                      {Object.keys(state.datasetInfo).map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                    <select className="sidebar-select" style={{ width: 56, fontSize: '0.78em', padding: '2px 4px' }}
                      value={mask.mode}
                      onChange={e => {
                        const newMode = e.target.value as 'min' | 'max';
                        const r = datasetRanges[mask.dataset];
                        const newThreshold = r
                          ? (newMode === 'max' ? (r.p98 ?? r.max) : (r.p2 ?? r.min)) ?? mask.threshold
                          : mask.threshold;
                        dispatch({ type: 'UPDATE_LAYER_MASK', payload: { id: mask.id, updates: { mode: newMode, threshold: newThreshold } } });
                      }}>
                      <option value="min">≥</option>
                      <option value="max">≤</option>
                    </select>
                    <button className="hist-btn"
                      style={{ color: 'var(--sb-red)', padding: '2px 6px', flexShrink: 0 }}
                      onClick={() => dispatch({ type: 'REMOVE_LAYER_MASK', payload: mask.id })}
                    ><i className="fa-solid fa-xmark"></i></button>
                  </div>
                  <div className="slider-label">
                    <span style={{ fontSize: '0.75em', color: 'var(--sb-muted)' }}>
                      Threshold{range ? ` [${rMin.toPrecision(3)}, ${rMax.toPrecision(3)}]` : ''}
                    </span>
                    <input type="number"
                      style={{ width: 72, fontSize: '0.75em', background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)', borderRadius: 4, color: 'var(--sb-text)', padding: '1px 4px', textAlign: 'right' }}
                      step={step} value={parseFloat(mask.threshold.toPrecision(4))}
                      onChange={e => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v)) dispatch({ type: 'UPDATE_LAYER_MASK', payload: { id: mask.id, updates: { threshold: v } } });
                      }} />
                  </div>
                  <input type="range" className="sidebar-range"
                    min={rMin} max={rMax} step={step} value={mask.threshold}
                    onChange={e => dispatch({ type: 'UPDATE_LAYER_MASK', payload: { id: mask.id, updates: { threshold: parseFloat(e.target.value) } } })} />
                </div>
              );
            })}
            {Object.keys(state.datasetInfo).length > 0 && (
              <button className="hist-btn" style={{ width: '100%', marginTop: 4 }}
                onClick={() => {
                  const firstDataset = Object.keys(state.datasetInfo)[0];
                  const range = datasetRanges[firstDataset];
                  dispatch({
                    type: 'ADD_LAYER_MASK', payload: {
                      id: `mask_${Date.now()}`, dataset: firstDataset,
                      threshold: range ? (range.p2 ?? range.min) : 0.5, mode: 'min',
                    }
                  });
                }}>
                <i className="fa-solid fa-plus" style={{ marginRight: 5 }}></i>Add layer mask
              </button>
            )}
            <div className="custom-mask-row" style={{ marginTop: 8 }}>
              <label className="minmax-label" style={{ marginBottom: 4 }}>Custom mask (GeoTIFF)</label>
              <div className="custom-mask-controls">
                <label className="hist-btn" style={{ cursor: 'pointer', textAlign: 'center' }}>
                  Upload
                  <input type="file" accept=".tif,.tiff" style={{ display: 'none' }}
                    onChange={async e => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const form = new FormData();
                      form.append('file', f);
                      const res = await fetch('/upload_mask', { method: 'POST', body: form });
                      if (res.ok) {
                        const data = await res.json();
                        dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: data.path });
                      }
                    }} />
                </label>
                {state.customMaskPath && (
                  <button className="hist-btn" style={{ color: 'var(--sb-red)' }}
                    onClick={() => dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: null })}>Clear</button>
                )}
              </div>
              {state.customMaskPath && (
                <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', wordBreak: 'break-all', marginTop: 2 }}>
                  {state.customMaskPath.split('/').pop()}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── BUFFER SAMPLING (collapsible) ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-circle-dot" label="Point Buffer" collapseKey="buffer" />
        {!collapsed.buffer && (
          <>
            <div className="toggle-row">
              <span style={{ fontSize: '0.82em', color: 'var(--sb-muted)' }}>Enable buffer mode</span>
              <button className={`toggle-pill${state.bufferEnabled ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'TOGGLE_BUFFER' })}>
                {state.bufferEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {state.bufferEnabled && (
              <>
                <div className="slider-group">
                  <div className="slider-label">
                    <span>Radius</span><span className="slider-value">{state.bufferRadius} m</span>
                  </div>
                  <input type="range" className="sidebar-range"
                    min="5" max="5000" step="5" value={state.bufferRadius}
                    onChange={e => dispatch({ type: 'SET_BUFFER_RADIUS', payload: parseInt(e.target.value) })} />
                </div>
                <div className="slider-group">
                  <div className="slider-label">
                    <span>Samples shown</span><span className="slider-value">{state.bufferSamples}</span>
                  </div>
                  <input type="range" className="sidebar-range"
                    min="0" max="50" step="1" value={state.bufferSamples}
                    onChange={e => dispatch({ type: 'SET_BUFFER_SAMPLES', payload: parseInt(e.target.value) })} />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── OVERLAYS (collapsible) ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-layer-group" label="Overlays" collapseKey="overlays" />
        {!collapsed.overlays && (
          <>
            <label className="hist-btn" style={{ width: '100%', cursor: 'pointer', textAlign: 'center', display: 'block' }}>
              <i className="fa-solid fa-upload" style={{ marginRight: 6 }}></i>Upload raster (GeoTIFF)
              <input type="file" accept=".tif,.tiff" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadRaster(f); e.currentTarget.value = ''; }} />
            </label>
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 4 }}>
                <select className="sidebar-select" style={{ width: 72, fontSize: '0.76em' }} value={extType}
                  onChange={e => setExtType(e.target.value as 'wms' | 'wmts')}>
                  <option value="wms">WMS</option>
                  <option value="wmts">WMTS</option>
                </select>
                <input className="sidebar-input" style={{ flex: 1, fontSize: '0.74em' }}
                  placeholder={extType === 'wms' ? 'WMS base URL' : 'WMTS/XYZ template …/{z}/{x}/{y}'}
                  value={extUrl} onChange={e => { setExtUrl(e.target.value); setWmsLayerOptions([]); }} />
              </div>
              {extType === 'wms' && (
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button className="hist-btn" style={{ whiteSpace: 'nowrap', fontSize: '0.76em' }}
                    disabled={!extUrl.trim() || wmsLoading} onClick={fetchWmsLayers}
                    title="Read the available layers from this WMS">
                    {wmsLoading ? '…' : 'Load layers'}
                  </button>
                  {wmsLayerOptions.length > 0 ? (
                    <select className="sidebar-select" style={{ flex: 1, fontSize: '0.76em' }}
                      value={extLayers} onChange={e => setExtLayers(e.target.value)}>
                      {wmsLayerOptions.map(l => <option key={l.name} value={l.name}>{l.title}</option>)}
                    </select>
                  ) : (
                    <input className="sidebar-input" style={{ flex: 1, fontSize: '0.74em' }}
                      placeholder="WMS layer name" value={extLayers} onChange={e => setExtLayers(e.target.value)} />
                  )}
                </div>
              )}
              <button className="hist-btn" style={{ width: '100%', marginTop: 4 }} disabled={!extUrl.trim()} onClick={addExternalOverlay}>
                <i className="fa-solid fa-plus" style={{ marginRight: 5 }}></i>Add {extType.toUpperCase()}
              </button>
            </div>
            {state.overlays.length === 0 && (
              <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', marginTop: 6, textAlign: 'center' }}>
                Uploaded rasters sit between the basemap and the data layer.
              </div>
            )}
            {state.overlays.map((o, i) => (
              <div key={o.id} className="layer-mask-row" style={{ marginTop: 8 }}>
                {/* Name on its own line so it's fully visible */}
                <div style={{ fontSize: '0.76em', fontWeight: 600, marginBottom: 3, wordBreak: 'break-all', lineHeight: 1.2 }} title={o.name}>
                  {o.type !== 'geotiff' && <span style={{ color: 'var(--sb-muted)', fontWeight: 400 }}>{o.type.toUpperCase()} · </span>}{o.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 4 }}>
                  <button className="hist-btn" style={{ padding: '2px 5px' }} title={o.visible ? 'Hide' : 'Show'}
                    onClick={() => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { visible: !o.visible } } })}>
                    <i className={`fa-solid ${o.visible ? 'fa-eye' : 'fa-eye-slash'}`}></i>
                  </button>
                  {o.type === 'geotiff' && (
                    <button className="hist-btn" style={{ padding: '2px 5px' }} title="Center map on this raster" disabled={!o.bounds}
                      onClick={() => { if (o.bounds) dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [o.bounds![1], o.bounds![0], o.bounds![3], o.bounds![2]] }); }}>
                      <i className="fa-solid fa-crosshairs"></i>
                    </button>
                  )}
                  <button className="hist-btn" style={{ padding: '2px 5px' }} title="Move up (toward data)" disabled={i === state.overlays.length - 1}
                    onClick={() => dispatch({ type: 'REORDER_OVERLAY', payload: { id: o.id, direction: 'up' } })}>
                    <i className="fa-solid fa-arrow-up"></i>
                  </button>
                  <button className="hist-btn" style={{ padding: '2px 5px' }} title="Move down (toward basemap)" disabled={i === 0}
                    onClick={() => dispatch({ type: 'REORDER_OVERLAY', payload: { id: o.id, direction: 'down' } })}>
                    <i className="fa-solid fa-arrow-down"></i>
                  </button>
                  <button className="hist-btn" style={{ padding: '2px 5px', color: 'var(--sb-red)' }} title="Remove"
                    onClick={() => dispatch({ type: 'REMOVE_OVERLAY', payload: o.id })}>
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                  <span style={{ flex: 1 }} />
                </div>
                <div className="slider-label">
                  <span style={{ fontSize: '0.75em', color: 'var(--sb-muted)' }}>Opacity</span>
                  <span className="slider-value">{Math.round(o.opacity * 100)}%</span>
                </div>
                <input type="range" className="sidebar-range" min="0" max="1" step="0.05" value={o.opacity}
                  onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { opacity: parseFloat(e.target.value) } } })} />
                {state.splitScreen && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)' }}>Show on</span>
                    <select className="sidebar-select" style={{ flex: 1, fontSize: '0.76em' }} value={o.side ?? 'both'}
                      onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { side: e.target.value as 'left' | 'right' | 'both' } } })}>
                      <option value="both">Both sides</option>
                      <option value="left">Left only</option>
                      <option value="right">Right only</option>
                    </select>
                  </div>
                )}
                {o.type !== 'geotiff' ? (
                  <>
                    <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginTop: 4, wordBreak: 'break-all' }}>{o.url}</div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)' }} title="Highest zoom the service has tiles for; above it, tiles are upsampled instead of disappearing">Max native zoom</span>
                      <input className="sidebar-input" type="number" min={1} max={24} style={{ width: 56, fontSize: '0.76em' }}
                        value={o.maxNativeZoom ?? 18}
                        onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { maxNativeZoom: Math.max(1, Math.min(24, parseInt(e.target.value) || 18)) } } })} />
                    </div>
                  </>
                ) : (o.bandCount ?? 1) >= 3 ? (
                  <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', marginTop: 4 }}>RGB ({o.bandCount}-band)</div>
                ) : (
                  <>
                    <div className="toggle-row" style={{ marginTop: 4 }}>
                      <span style={{ fontSize: '0.78em', color: 'var(--sb-muted)' }}>Discrete classes</span>
                      <button className={`toggle-pill${o.discrete ? ' active' : ''}`}
                        onClick={() => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { discrete: !o.discrete } } })}>
                        {o.discrete ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    {!o.discrete && (
                      <select className="sidebar-select" style={{ width: '100%', fontSize: '0.78em', marginTop: 4 }}
                        value={o.cmap}
                        onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { cmap: e.target.value } } })}>
                        {colormapOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    )}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <div className="minmax-field" style={{ flex: 1 }}>
                        <label className="minmax-label">Min</label>
                        <input className="sidebar-input" type="number" value={o.vmin}
                          onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { vmin: parseFloat(e.target.value) } } })} />
                      </div>
                      <div className="minmax-field" style={{ flex: 1 }}>
                        <label className="minmax-label">Max</label>
                        <input className="sidebar-input" type="number" value={o.vmax}
                          onChange={e => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { vmax: parseFloat(e.target.value) } } })} />
                      </div>
                      {o.discrete && (
                        <div className="minmax-field" style={{ width: 60 }}>
                          <label className="minmax-label">Classes</label>
                          <input className="sidebar-input" type="number" min={2} max={12} value={o.nbins ?? 5}
                            onChange={e => { const n = Math.max(2, Math.min(12, parseInt(e.target.value) || 2));
                              dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { nbins: n, binColors: binColorsFor(n, o.binColors) } } }); }} />
                        </div>
                      )}
                    </div>
                    {o.discrete && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {(o.binColors ?? []).map((c, k) => {
                          const vmin = o.vmin ?? 0, vmax = o.vmax ?? 1, nb = o.nbins ?? 1;
                          const step = (vmax - vmin) / nb;
                          const lo = vmin + k * step, hi = vmin + (k + 1) * step;
                          return (
                            <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }} title={`${lo.toPrecision(3)} – ${hi.toPrecision(3)}`}>
                              <input type="color" value={c} style={{ width: 26, height: 18, padding: 0, border: '1px solid var(--sb-border)', borderRadius: 3, background: 'none', cursor: 'pointer' }}
                                onChange={e => { const colors = [...(o.binColors ?? [])]; colors[k] = e.target.value;
                                  dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates: { binColors: colors } } }); }} />
                              <span style={{ fontSize: '0.6em', color: 'var(--sb-muted)' }}>{hi.toPrecision(3)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── PROJECT (save/load) ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-floppy-disk" label="Project" collapseKey="project" />
        {!collapsed.project && (
          <>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="hist-btn" style={{ flex: 1 }} onClick={saveProject}
                title="Save points, reference, annotations & masks to a file">
                <i className="fa-solid fa-download" style={{ marginRight: 5 }}></i>Save
              </button>
              <label className="hist-btn" style={{ flex: 1, cursor: 'pointer', textAlign: 'center' }}
                title="Load a saved project">
                <i className="fa-solid fa-upload" style={{ marginRight: 5 }}></i>Load
                <input type="file" accept=".json,application/json" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) loadProject(f); e.currentTarget.value = ''; }} />
              </label>
            </div>
            <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginTop: 4, textAlign: 'center' }}>
              points · reference · annotations · masks
            </div>
          </>
        )}
      </div>

      {/* ── EXPORT (active layer → GeoTIFF) ── */}
      <div className="sidebar-section">
        <SectionHeader icon="fa-download" label="Export" collapseKey="export" />
        {!collapsed.export && (
          <>
            <button className="hist-btn" style={{ width: '100%' }}
              disabled={!state.currentDataset || exporting}
              title="Download the active layer as a GeoTIFF (masking applied if enabled)"
              onClick={handleExportGeoTIFF}>
              <i className={`fa-solid ${exporting ? 'fa-spinner fa-spin' : 'fa-download'}`} style={{ marginRight: 6 }}></i>
              {exporting ? 'Exporting…' : 'Export layer (GeoTIFF)'}
            </button>
            {(state.layerMasks.length > 0 || state.customMaskPath) && (
              <div style={{ fontSize: '0.72em', color: 'var(--sb-muted)', marginTop: 4, textAlign: 'center' }}>
                masking will be applied
              </div>
            )}
          </>
        )}
      </div>

      {/* ── FOOTER ── */}
      <div className="sidebar-footer">
        <button className="chart-toggle-btn" onClick={() => dispatch({ type: 'TOGGLE_CHART' })}>
          <i className={`fa-solid ${state.showChart ? 'fa-chart-line' : 'fa-wave-square'}`}></i>
          {state.showChart ? 'Hide' : 'Show'} Time Series
        </button>
        {state.refBufferEnabled && (
          <button className="chart-toggle-btn" style={{ marginTop: 4 }}
            onClick={() => dispatch({ type: 'TOGGLE_REF_CHART' })}>
            <i className="fa-solid fa-crosshairs"></i>
            {state.showRefChart ? 'Hide' : 'Show'} Ref Buffer Chart
          </button>
        )}
      </div>
    </div>
  );
}
