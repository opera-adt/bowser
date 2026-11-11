import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useApi, datasetRangeUrl } from '../../hooks/useApi';
import Histogram from '../Histogram';
import ColorScalePicker, { type RangeStats } from './ColorScalePicker';
import LayerInfo from './LayerInfo';
import TimeStepper from './TimeStepper';
import RefDatePicker from './RefDatePicker';
import ReferenceCandidates from './ReferenceCandidates';
import CustomMaskUpload from './CustomMaskUpload';
import { displayUnit } from '../../utils/units';
import { readLayerInfoShown, saveLayerInfoShown } from '../../utils/layerInfoPref';
import { baseColormap } from '../../utils/colormaps';
import { LayerOptions, SectionHeader, Switch } from './controls';
import { referenceValues } from '../../map/interactions';

/** A layer's percentiles, for the colour scale's range presets. */
async function rangeOf(dataset: string): Promise<RangeStats | null> {
  const res = await fetch(datasetRangeUrl(dataset));
  return res.ok ? res.json() : null;
}

/** The colormap rewrap switches to, and the ones that already wrap round (kept as they are). */
const WRAP_COLORMAP = 'twilight';
const isCyclic = (colormap: string) => ['twilight', 'hsv'].includes(baseColormap(colormap));

export default function MainTab() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [draftWrapWavelength, setDraftWrapWavelength] = useState(state.wrapWavelength !== null ? String(state.wrapWavelength) : '');
  const [draftWrapPeriod, setDraftWrapPeriod] = useState(String(state.wrapPeriod));
  const [draftRefLat, setDraftRefLat] = useState(String(state.refMarkerPosition[0]));
  const [draftRefLon, setDraftRefLon] = useState(String(state.refMarkerPosition[1]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    masking: true,
    buffer: true,
  });
  const toggleSection = (key: string) => setCollapsed(c => ({ ...c, [key]: !c[key] }));
  // The layer description notes (main and right-hand layer) follow one per-viewer choice.
  const [showLayerInfo, setShowLayerInfo] = useState(readLayerInfoShown);
  const toggleLayerInfo = () => setShowLayerInfo(shown => {
    saveLayerInfoShown(!shown);
    return !shown;
  });

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
        const res = await fetch(datasetRangeUrl(ds));
        if (res.ok) {
          const data = await res.json();
          setDatasetRanges(prev => ({ ...prev, [ds]: data }));
        }
      } catch { /* ignore */ }
    });
  }, [state.layerMasks, datasetRanges]);

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
    if (state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds, [lat, lon]);
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

  // Rewrapped fringes need a cyclic colormap (its ends meet at ±π): Twilight while rewrap is on,
  // then the previous colormap back, unless another was picked in the meantime.
  const beforeWrap = useRef<string | null>(null);
  useEffect(() => {
    if (state.wrapEnabled) {
      if (!isCyclic(state.colormap)) {
        beforeWrap.current = state.colormap;
        dispatch({ type: 'SET_COLORMAP', payload: WRAP_COLORMAP });
      }
    } else if (beforeWrap.current) {
      if (state.colormap === WRAP_COLORMAP) dispatch({ type: 'SET_COLORMAP', payload: beforeWrap.current });
      beforeWrap.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wrapEnabled, dispatch]);

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

  // ``position`` is where the marker is going: a caller that has just moved it must pass it,
  // since this render's state still holds the old position.
  // Only the newest lookup may set the values: an older answer arriving late would undo a reset.
  const refRequest = useRef(0);
  const setRefValues = async (ds: string, position: [number, number] = state.refMarkerPosition) => {
    const request = ++refRequest.current;
    try {
      const values = await referenceValues(state, ds, position, { fetchPointTimeSeries, fetchBufferTimeSeries });
      if (values && request === refRequest.current) dispatch({ type: 'SET_REF_VALUES', payload: { dataset: ds, values } });
    } catch (error) {
      console.error('Error setting reference values:', error);
    }
  };

  const commitRefPosition = useCallback(() => {
    const lat = parseFloat(draftRefLat);
    const lon = parseFloat(draftRefLon);
    if (isNaN(lat) || isNaN(lon)) return;
    // Leaving the box (say, to press reset) must not re-send a position already in place.
    const [curLat, curLon] = state.refMarkerPosition;
    if (Math.abs(lat - curLat) < 1e-7 && Math.abs(lon - curLon) < 1e-7) return;
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lon] });
    const ds = state.currentDataset;
    if (ds && state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds, [lat, lon]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRefLat, draftRefLon, state.currentDataset, state.datasetInfo, state.refMarkerPosition, dispatch]);

  const currentDatasetInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
  const currentTimeValue = currentDatasetInfo
    ? currentDatasetInfo.x_values[state.currentTimeIndex]
    : '';
  const splitDatasetInfo = state.splitDataset ? state.datasetInfo[state.splitDataset] : null;
  const splitTimeValue = splitDatasetInfo
    ? splitDatasetInfo.x_values[Math.min(state.splitTimeIndex, splitDatasetInfo.x_values.length - 1)]
    : '';

  return (
    <>
      {/* ── LAYERS ── */}
      <div className="sidebar-section">
        <SectionHeader label="Layers" action={currentDatasetInfo || splitDatasetInfo ? (
          <button type="button" className={`ov-icon-btn${showLayerInfo ? ' on' : ''}`} data-command="panel.layer_info" aria-pressed={showLayerInfo}
            aria-label="Layer description" title={showLayerInfo ? 'Hide layer description' : 'Show layer description'}
            onClick={toggleLayerInfo}>
            <i className="fa-solid fa-circle-info" aria-hidden="true"></i>
          </button>
        ) : null} />
        <select aria-label="Layer" className="sidebar-select" value={state.currentDataset} onChange={e => handleDatasetChange(e.target.value)}>
          <LayerOptions names={Object.keys(state.datasetInfo)} />
        </select>
        {showLayerInfo && <LayerInfo info={currentDatasetInfo} />}
        {currentDatasetInfo && currentDatasetInfo.x_values.length > 1 && (
          <div className="slider-group">
            <div className="slider-label">
              <span>Time step</span>
              <span className="time-step-values">
                <RefDatePicker key={`ref-${state.currentDataset}`} info={currentDatasetInfo} chosen={state.refTimeIndex[state.currentDataset]}
                  currentTimeIndex={state.currentTimeIndex} dataMode={state.dataMode}
                  onChoose={index => dispatch({ type: 'SET_REF_TIME_INDEX', payload: { dataset: state.currentDataset, index } })} />
                <span className="time-step-divider" aria-hidden="true" />
                <button type="button" className={`slider-value date-toggle${state.dateBadge !== 'off' ? ' on' : ''}`}
                  aria-pressed={state.dateBadge !== 'off'} onClick={() => dispatch({ type: 'TOGGLE_DATE_BADGE' })}
                  title={state.dateBadge === 'off' ? 'Show this date on the map' : state.dateBadge === 'full' ? 'Show the date alone on the map' : 'Hide the date on the map'}>
                  {currentTimeValue}
                </button>
              </span>
            </div>
            <TimeStepper key={state.currentDataset} value={state.currentTimeIndex} count={currentDatasetInfo.x_values.length}
              onChange={i => dispatch({ type: 'SET_TIME_INDEX', payload: i })}
              onPlayingChange={p => dispatch({ type: 'SET_PLAYING', payload: p })} />
          </div>
        )}
      </div>

      {/* ── VISUALIZATION ── */}
      <div className="sidebar-section">
        <SectionHeader label={state.splitScreen ? 'Left Layer' : 'Visualization'} />
        <ColorScalePicker colormap={state.colormap} vmin={state.vmin} vmax={state.vmax} stats={() => rangeOf(state.currentDataset)}
          onColormap={c => dispatch({ type: 'SET_COLORMAP', payload: c })}
          onRange={(lo, hi) => { dispatch({ type: 'SET_VMIN', payload: lo }); dispatch({ type: 'SET_VMAX', payload: hi }); }}
          display={state.wrapEnabled ? undefined : displayUnit(state.datasetInfo[state.currentDataset]?.unit, state.units)} />
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
                <div className="segmented">
                  {(['phase', 'amplitude'] as const).map(mode => (
                    <button
                      key={mode}
                      className={`segmented-item${state.complexMode === mode ? ' active' : ''}`}
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
              <Switch checked={state.wrapEnabled} title="Re-wrap timeseries / unwrapped phase / velocity for fringe visualization"
                onChange={() => dispatch({ type: 'TOGGLE_WRAP' })} />
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
          <SectionHeader label="Right Layer" />

          <select
            aria-label="Right layer"
            className="sidebar-select"
            value={state.splitDataset || ''}
            onChange={e => dispatch({ type: 'SET_SPLIT_DATASET', payload: e.target.value || null })}
          >
            <option value="">— none —</option>
            <LayerOptions names={Object.keys(state.datasetInfo)} labelOf={name => state.datasetInfo[name]?.label || name} />
          </select>
          {showLayerInfo && <LayerInfo info={splitDatasetInfo} />}

          {splitDatasetInfo && splitDatasetInfo.x_values.length > 1 && (
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
              <ColorScalePicker colormap={state.splitColormap} vmin={state.splitVmin} vmax={state.splitVmax} stats={() => rangeOf(state.splitDataset!)}
                onColormap={c => dispatch({ type: 'SET_SPLIT_COLORMAP', payload: c })}
                onRange={(lo, hi) => { dispatch({ type: 'SET_SPLIT_VMIN', payload: lo }); dispatch({ type: 'SET_SPLIT_VMAX', payload: hi }); }}
                display={displayUnit(state.datasetInfo[state.splitDataset!]?.unit, state.units)} />
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
        <SectionHeader label="Reference Point" action={(() => {
          // The cube's recorded reference point, or the middle of the data when it has none.
          const recorded = currentDatasetInfo?.reference_lonlat;
          const b = currentDatasetInfo?.latlon_bounds;
          const target: [number, number] | null = recorded
            ? [recorded[1], recorded[0]]
            : b ? [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2] : null;
          if (!target) return null;
          const where = `${target[0].toFixed(5)}, ${target[1].toFixed(5)}`;
          return (
            <button type="button" className="ov-icon-btn" aria-label="Reset the reference point"
              title={recorded ? `Reset to the cube's reference point (${where})` : `Reset to the middle of the data (${where}); this cube records no reference point`}
              onClick={() => {
                dispatch({ type: 'SET_REF_MARKER_POSITION', payload: target });
                const ds = state.currentDataset;
                if (ds && state.datasetInfo[ds]?.uses_spatial_ref) setRefValues(ds, target);
              }}>
              <i className="fa-solid fa-rotate-left"></i>
            </button>
          );
        })()} />
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
          <Switch checked={state.refBufferEnabled} onChange={() => dispatch({ type: 'TOGGLE_REF_BUFFER' })} />
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
        <ReferenceCandidates />
      </div>

      {/* ── MASKING (collapsible) ── */}
      <div className="sidebar-section">
        <SectionHeader label={state.layerMasks.length ? `Masking · ${state.layerMasks.length} on` : 'Masking'} collapsed={collapsed.masking} onToggle={() => toggleSection('masking')} />
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
                      <LayerOptions names={Object.keys(state.datasetInfo)} />
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
            <CustomMaskUpload />
          </>
        )}
      </div>

      {/* ── BUFFER SAMPLING (collapsible) ── */}
      <div className="sidebar-section">
        <SectionHeader label="Point Buffer" collapsed={collapsed.buffer} onToggle={() => toggleSection('buffer')} />
        {!collapsed.buffer && (
          <>
            <div className="toggle-row">
              <span style={{ fontSize: '0.82em', color: 'var(--sb-muted)' }}>Enable buffer mode</span>
              <Switch checked={state.bufferEnabled} onChange={() => dispatch({ type: 'TOGGLE_BUFFER' })} />
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

    </>
  );
}
