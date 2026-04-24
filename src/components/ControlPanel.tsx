import { useEffect, useState, useCallback } from 'react';
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

export default function ControlPanel({ title }: { title: string }) {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [draftVmin, setDraftVmin] = useState(String(state.vmin));
  const [draftVmax, setDraftVmax] = useState(String(state.vmax));
  const [lightTheme, setLightTheme] = useState(false);
  const [draftRefLat, setDraftRefLat] = useState(String(state.refMarkerPosition[0]));
  const [draftRefLon, setDraftRefLon] = useState(String(state.refMarkerPosition[1]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    masking: true,
    buffer: true,
  });
  const toggleSection = (key: string) => setCollapsed(c => ({ ...c, [key]: !c[key] }));
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
        <SectionHeader icon="fa-palette" label="Visualization" />
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
        <Histogram />
      </div>

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
