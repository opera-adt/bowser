import { useState, useRef, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { COLORMAP_NAMES, colormapGradientCSS, valueToColor } from '../colorscales';

const FILTER_OPERATORS = ['>', '<', '>=', '<=', '='] as const;

const RASTER_COLORMAPS = [
  { value: 'rdbu_r', label: 'Blue-Red' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'magma', label: 'Magma' },
  { value: 'twilight', label: 'Twilight (cyclic)' },
  { value: 'cfastie', label: 'CFastie' },
  { value: 'rplumbo', label: 'RPlumbo' },
  { value: 'schwarzwald', label: 'Schwarzwald' },
  { value: 'bugn', label: 'Blue-Green' },
  { value: 'ylgn', label: 'Yellow-Green' },
  { value: 'gist_earth', label: 'Earth' },
  { value: 'terrain', label: 'Terrain' },
];

const inputStyle = {
  width: '100%',
  padding: '3px 5px',
  background: '#2a2a4a',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 3,
  fontSize: 12,
  boxSizing: 'border-box' as const,
};

const selectStyle = {
  ...inputStyle,
  padding: '4px 6px',
};

const labelStyle = { fontSize: 11, color: '#aaa', display: 'block' as const, marginBottom: 2 };

const sectionGap = { marginBottom: 10 };

const basemapLabels: Record<string, string> = {
  satellite: 'Satellite',
  osm: 'OpenStreetMap',
  dark: 'Dark',
};

function MiniHistogram({ histogram, vmin, vmax, colormap }: {
  histogram: { edges: number[]; counts: number[] };
  vmin: number; vmax: number; colormap: string;
}) {
  const { edges, counts } = histogram;
  const maxCount = Math.max(...counts, 1);
  const nBins = counts.length;
  const svgW = 220;
  const svgH = 36;
  const barW = svgW / nBins;

  const bars = useMemo(() => counts.map((count, i) => {
    const midVal = (edges[i] + edges[i + 1]) / 2;
    const [r, g, b] = valueToColor(midVal, vmin, vmax, colormap);
    const h = (count / maxCount) * svgH;
    return { x: i * barW, h, fill: `rgb(${r},${g},${b})` };
  }), [counts, edges, vmin, vmax, colormap, maxCount, barW]);

  return (
    <div style={{ marginBottom: 6 }}>
      <svg width={svgW} height={svgH} style={{ display: 'block' }}>
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={svgH - bar.h}
            width={Math.max(barW - 0.5, 1)}
            height={bar.h}
            fill={bar.fill}
            opacity={0.8}
          />
        ))}
      </svg>
    </div>
  );
}

export default function PointControlsPanel() {
  const { state, dispatch } = useAppContext();
  const [draftVmin, setDraftVmin] = useState(String(state.pointVmin));
  const [draftVmax, setDraftVmax] = useState(String(state.pointVmax));
  const [exportWithTs, setExportWithTs] = useState(false);

  // Raster vmin/vmax drafts
  const [draftRasterVmin, setDraftRasterVmin] = useState(String(state.vmin));
  const [draftRasterVmax, setDraftRasterVmax] = useState(String(state.vmax));

  // Filter draft state
  const [filterAttr, setFilterAttr] = useState('');
  const [filterOp, setFilterOp] = useState<string>('>');
  const [filterVal, setFilterVal] = useState('');
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Only show numeric (non-geometry, non-id) attributes in dropdowns
  const numericAttrs = Object.entries(state.pointAttributes).filter(
    ([name, info]) =>
      name !== 'geometry' &&
      name !== 'point_id' &&
      name !== 'longitude' &&
      name !== 'latitude' &&
      (info.type.includes('FLOAT') || info.type.includes('DOUBLE') || info.type.includes('INT'))
  );

  const handleColorByChange = (value: string) => {
    dispatch({ type: 'SET_POINT_COLOR_BY', payload: value });
    const attr = state.pointAttributes[value];
    if (attr?.min != null && attr?.max != null) {
      if (value.includes('velocity')) {
        const absMax = Math.max(Math.abs(attr.min), Math.abs(attr.max));
        dispatch({ type: 'SET_POINT_VMIN', payload: -absMax });
        dispatch({ type: 'SET_POINT_VMAX', payload: absMax });
        setDraftVmin((-absMax).toFixed(2));
        setDraftVmax(absMax.toFixed(2));
      } else {
        dispatch({ type: 'SET_POINT_VMIN', payload: attr.min });
        dispatch({ type: 'SET_POINT_VMAX', payload: attr.max });
        setDraftVmin(attr.min.toFixed(2));
        setDraftVmax(attr.max.toFixed(2));
      }
    }
  };

  const commitVmin = () => {
    const v = parseFloat(draftVmin);
    if (!isNaN(v)) dispatch({ type: 'SET_POINT_VMIN', payload: v });
  };

  const commitVmax = () => {
    const v = parseFloat(draftVmax);
    if (!isNaN(v)) dispatch({ type: 'SET_POINT_VMAX', payload: v });
  };

  const addFilter = () => {
    if (!effectiveFilterAttr || !filterVal) return;
    const v = parseFloat(filterVal);
    if (isNaN(v)) return;
    const expr = `${effectiveFilterAttr}${filterOp}${v}`;
    const next = [...activeFilters, expr];
    setActiveFilters(next);
    dispatch({ type: 'SET_POINT_FILTER', payload: next.join(' AND ') });
    setFilterVal('');
    filterInputRef.current?.focus();
  };

  const removeFilter = (index: number) => {
    const next = activeFilters.filter((_, i) => i !== index);
    setActiveFilters(next);
    dispatch({ type: 'SET_POINT_FILTER', payload: next.join(' AND ') });
  };

  const clearFilters = () => {
    setActiveFilters([]);
    dispatch({ type: 'SET_POINT_FILTER', payload: '' });
  };

  const currentAttr = state.pointAttributes[state.pointColorBy];
  const pointCount = currentAttr?.count;
  const hasPoints = state.activePointLayer != null;
  const hasRasters = Object.keys(state.datasetInfo).length > 0;

  // Set default filter attribute (only when point data is available)
  const effectiveFilterAttr = filterAttr || (numericAttrs.length > 0 ? numericAttrs[0][0] : '');

  return (
    <div style={{
      position: 'absolute', top: 10, left: 10, zIndex: 100,
      background: 'rgba(20, 20, 40, 0.92)', color: '#ddd',
      borderRadius: 6, padding: '10px 14px',
      fontSize: 13, fontFamily: 'system-ui, sans-serif',
      minWidth: 240, maxWidth: 280, backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.1)',
      maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
        Layers
      </div>

      {/* Layer toggles */}
      <div style={sectionGap}>
        {/* Point layer toggle */}
        {hasPoints && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={state.pointLayerVisible}
              onChange={e => dispatch({ type: 'SET_POINT_LAYER_VISIBLE', payload: e.target.checked })}
              style={{ accentColor: '#5566cc' }}
            />
            <span>Points</span>
            {pointCount != null && (
              <span style={{ color: '#999', fontSize: 11 }}>
                ({pointCount.toLocaleString()})
              </span>
            )}
          </label>
        )}

        {/* Raster layer toggle + controls */}
        {hasRasters && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={state.rasterLayerVisible}
                onChange={e => dispatch({ type: 'SET_RASTER_LAYER_VISIBLE', payload: e.target.checked })}
                style={{ accentColor: '#5566cc' }}
              />
              <span>Raster</span>
            </label>

            {/* Raster controls (collapsed when hidden) */}
            {state.rasterLayerVisible && (
              <div style={{ paddingLeft: 20, marginBottom: 4 }}>
                {/* Dataset selector */}
                <select
                  value={state.currentDataset}
                  onChange={e => dispatch({ type: 'SET_CURRENT_DATASET', payload: e.target.value })}
                  style={{ ...selectStyle, marginBottom: 4 }}
                >
                  {Object.keys(state.datasetInfo).map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>

                {/* Time slider */}
                {state.datasetInfo[state.currentDataset] && (
                  <div style={{ marginBottom: 4 }}>
                    <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                      <span>Time</span>
                      <span style={{ fontSize: 10 }}>
                        {state.datasetInfo[state.currentDataset].x_values[state.currentTimeIndex]}
                      </span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max={state.datasetInfo[state.currentDataset].x_values.length - 1}
                      step="1"
                      value={state.currentTimeIndex}
                      onChange={e => dispatch({ type: 'SET_TIME_INDEX', payload: parseInt(e.target.value) })}
                      style={{ width: '100%' }}
                    />
                  </div>
                )}

                {/* Raster colormap */}
                <div style={{ marginBottom: 4 }}>
                  <label style={labelStyle}>Colormap</label>
                  <select
                    value={state.colormap}
                    onChange={e => dispatch({ type: 'SET_COLORMAP', payload: e.target.value })}
                    style={selectStyle}
                  >
                    {RASTER_COLORMAPS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <img
                    src={`/colorbar/${state.colormap}`}
                    style={{ width: '100%', height: 12, borderRadius: 2, marginTop: 2 }}
                    alt="Raster colorbar"
                  />
                </div>

                {/* Raster vmin/vmax */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Min</label>
                    <input
                      type="number" step="any"
                      value={draftRasterVmin}
                      onChange={e => setDraftRasterVmin(e.target.value)}
                      onBlur={() => { const v = parseFloat(draftRasterVmin); if (!isNaN(v)) dispatch({ type: 'SET_VMIN', payload: v }); }}
                      onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(draftRasterVmin); if (!isNaN(v)) dispatch({ type: 'SET_VMIN', payload: v }); } }}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Max</label>
                    <input
                      type="number" step="any"
                      value={draftRasterVmax}
                      onChange={e => setDraftRasterVmax(e.target.value)}
                      onBlur={() => { const v = parseFloat(draftRasterVmax); if (!isNaN(v)) dispatch({ type: 'SET_VMAX', payload: v }); }}
                      onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(draftRasterVmax); if (!isNaN(v)) dispatch({ type: 'SET_VMAX', payload: v }); } }}
                      style={inputStyle}
                    />
                  </div>
                </div>

                {/* Raster opacity */}
                <div style={{ marginBottom: 4 }}>
                  <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                    <span>Opacity</span>
                    <span>{state.opacity.toFixed(2)}</span>
                  </label>
                  <input
                    type="range"
                    min="0" max="1" step="0.05"
                    value={state.opacity}
                    onChange={e => dispatch({ type: 'SET_OPACITY', payload: parseFloat(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Show timeseries button (raster click mode) */}
                <button
                  onClick={() => dispatch({ type: 'TOGGLE_CHART' })}
                  style={{
                    width: '100%', padding: '4px 8px', fontSize: 11, cursor: 'pointer',
                    background: state.showChart ? '#5566cc' : '#2a2a4a',
                    color: state.showChart ? '#fff' : '#ccc',
                    border: '1px solid #444', borderRadius: 3,
                  }}
                >
                  {state.showChart ? 'Hide time series' : 'Show time series'}
                </button>
              </div>
            )}
          </>
        )}

        {/* Point opacity slider */}
        {hasPoints && state.pointLayerVisible && (
          <div style={{ marginTop: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Point opacity</span>
              <span>{state.pointOpacity.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0" max="1" step="0.05"
              value={state.pointOpacity}
              onChange={e => dispatch({ type: 'SET_POINT_OPACITY', payload: parseFloat(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>
        )}
      </div>

      {/* Separator */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />

      {/* Basemap switcher */}
      <div style={sectionGap}>
        <label style={labelStyle}>Basemap</label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['satellite', 'osm', 'dark'] as const).map(key => (
            <button
              key={key}
              onClick={() => dispatch({ type: 'SET_POINT_BASEMAP', payload: key })}
              style={{
                flex: 1, padding: '3px 6px', fontSize: 11,
                background: state.pointBasemap === key ? '#5566cc' : '#2a2a4a',
                color: state.pointBasemap === key ? '#fff' : '#aaa',
                border: state.pointBasemap === key ? '1px solid #7788ee' : '1px solid #444',
                borderRadius: 3, cursor: 'pointer',
              }}
            >
              {basemapLabels[key]}
            </button>
          ))}
        </div>
      </div>

      {/* Point-specific controls */}
      {hasPoints && (<>
      {/* Separator */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />

      {/* Color by dropdown */}
      <div style={sectionGap}>
        <label style={labelStyle}>Color by</label>
        <select
          value={state.pointColorBy}
          onChange={e => handleColorByChange(e.target.value)}
          style={selectStyle}
        >
          {numericAttrs.map(([name, info]) => (
            <option key={name} value={name}>
              {name}
              {info.min != null ? ` [${info.min.toFixed(2)}, ${info.max!.toFixed(2)}]` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Colormap selector */}
      <div style={sectionGap}>
        <label style={labelStyle}>Colormap</label>
        <select
          value={state.pointColormap}
          onChange={e => dispatch({ type: 'SET_POINT_COLORMAP', payload: e.target.value })}
          style={selectStyle}
        >
          {COLORMAP_NAMES.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {/* Colorbar */}
      <div style={{ marginBottom: 8 }}>
        <div style={{
          height: 12, borderRadius: 2,
          background: colormapGradientCSS(state.pointColormap),
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 2 }}>
          <span>{state.pointVmin.toFixed(1)}</span>
          <span>{((state.pointVmin + state.pointVmax) / 2).toFixed(1)}</span>
          <span>{state.pointVmax.toFixed(1)}</span>
        </div>
      </div>

      {/* Histogram */}
      {state.pointHistogram && (
        <MiniHistogram
          histogram={state.pointHistogram}
          vmin={state.pointVmin}
          vmax={state.pointVmax}
          colormap={state.pointColormap}
        />
      )}

      {/* Vmin / Vmax */}
      <div style={{ display: 'flex', gap: 8, ...sectionGap }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Min</label>
          <input
            type="number"
            step="any"
            value={draftVmin}
            onChange={e => setDraftVmin(e.target.value)}
            onBlur={commitVmin}
            onKeyDown={e => e.key === 'Enter' && commitVmin()}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Max</label>
          <input
            type="number"
            step="any"
            value={draftVmax}
            onChange={e => setDraftVmax(e.target.value)}
            onBlur={commitVmax}
            onKeyDown={e => e.key === 'Enter' && commitVmax()}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Current attribute stats */}
      {currentAttr?.mean != null && (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
          mean: {currentAttr.mean.toFixed(3)}
        </div>
      )}

      {/* Separator */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />

      {/* Filter section */}
      <div>
        <label style={labelStyle}>Filter</label>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <select
            value={effectiveFilterAttr}
            onChange={e => setFilterAttr(e.target.value)}
            style={{ ...selectStyle, flex: 3 }}
          >
            {numericAttrs.map(([name]) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select
            value={filterOp}
            onChange={e => setFilterOp(e.target.value)}
            style={{ ...selectStyle, flex: 1, textAlign: 'center' }}
          >
            {FILTER_OPERATORS.map(op => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          <input
            ref={filterInputRef}
            type="number"
            step="any"
            placeholder="val"
            value={filterVal}
            onChange={e => setFilterVal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addFilter()}
            style={{ ...inputStyle, flex: 2 }}
          />
          <button
            onClick={addFilter}
            style={{
              padding: '3px 8px', fontSize: 12, cursor: 'pointer',
              background: '#3a5a3a', color: '#cfc', border: '1px solid #4a7a4a',
              borderRadius: 3,
            }}
          >
            +
          </button>
        </div>

        {/* Active filters */}
        {activeFilters.length > 0 && (
          <div style={{ marginBottom: 4 }}>
            {activeFilters.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: '#1a2a3a', padding: '2px 6px', borderRadius: 3,
                  marginBottom: 2, fontSize: 11, fontFamily: 'monospace',
                }}
              >
                <span style={{ color: '#8cf' }}>{f}</span>
                <button
                  onClick={() => removeFilter(i)}
                  style={{
                    background: 'none', border: 'none', color: '#f88',
                    cursor: 'pointer', fontSize: 12, padding: '0 2px',
                  }}
                >
                  x
                </button>
              </div>
            ))}
            <button
              onClick={clearFilters}
              style={{
                background: 'none', border: 'none', color: '#888',
                cursor: 'pointer', fontSize: 10, padding: '2px 0',
              }}
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {/* Separator */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />

      {/* Export */}
      <div>
        <label style={labelStyle}>Export</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={exportWithTs}
            onChange={e => setExportWithTs(e.target.checked)}
            style={{ accentColor: '#5566cc' }}
          />
          <span style={{ color: '#aaa' }}>Include timeseries</span>
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['csv', 'geojson', 'parquet'] as const).map(fmt => (
            <button
              key={fmt}
              onClick={() => {
                const params = new URLSearchParams();
                params.set('format', fmt);
                if (state.pointFilter) params.set('filter', state.pointFilter);
                if (exportWithTs) params.set('include_timeseries', 'true');
                window.open(`/points/${state.activePointLayer}/export?${params}`, '_blank');
              }}
              style={{
                flex: 1, padding: '4px 6px', fontSize: 11, cursor: 'pointer',
                background: '#2a2a4a', color: '#ccc', border: '1px solid #444',
                borderRadius: 3,
              }}
            >
              {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      </>)}
    </div>
  );
}
