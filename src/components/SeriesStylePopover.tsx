import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { AREA_WIDTHS, areaStyle, LINES, MARKERS, type LineStyle, type MarkerShape } from '../map/seriesStyle';
import type { ChartArea, TimeSeriesPoint } from '../types';

const MARKER_LABEL: Record<MarkerShape, string> = {
  circle: '● circle', square: '■ square', triangle: '▲ triangle', diamond: '◆ diamond', star: '★ star', cross: '✕ cross', none: 'no marker',
};
const LINE_LABEL: Record<LineStyle, string> = { solid: 'line', dashed: 'dashed', none: 'no line' };

/**
 * The chart header's Style button: colour, marker and line for each point, the marker size, and
 * for each area its colour, median line, mean on or off and band on or off with its opacity.
 */
export default function SeriesStylePopover() {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const update = (id: string, updates: Partial<TimeSeriesPoint>) => dispatch({ type: 'UPDATE_TIME_SERIES_POINT', payload: { id, updates } });
  const updateArea = (id: string, updates: Partial<ChartArea>) => dispatch({ type: 'UPDATE_CHART_AREA', payload: { id, updates } });
  const all = (updates: Partial<TimeSeriesPoint>) => state.timeSeriesPoints.forEach(p => update(p.id, updates));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="series-style" ref={rootRef}>
      <button className={`chart-btn${open ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen(o => !o)}
        title="Style the points and areas: colour, marker, line and size">
        <i className="fa-solid fa-palette"></i>
      </button>
      {open && (
        <div className="series-style-pop" onMouseDown={e => e.stopPropagation()}>
          <div className="series-style-row series-style-head">
            <span>Marker size</span>
            <input type="range" min={1} max={12} step={1} value={state.markerSize} aria-label="Marker size"
              onChange={e => dispatch({ type: 'SET_MARKER_SIZE', payload: Number(e.target.value) })} />
            <span className="slider-value">{state.markerSize}px</span>
          </div>
          {state.timeSeriesPoints.length === 0 && state.chartAreas.length === 0 && <div className="row-label">No points yet.</div>}
          {state.timeSeriesPoints.map(p => (
            <div key={p.id} className="series-style-row">
              <input type="color" value={p.color} aria-label={`Colour of ${p.name}`} onChange={e => update(p.id, { color: e.target.value })} />
              <span className="series-style-name" title={p.name}>{p.name}</span>
              <select className="sidebar-select" aria-label={`Marker of ${p.name}`} value={p.marker ?? 'circle'}
                onChange={e => update(p.id, { marker: e.target.value as MarkerShape })}>
                {MARKERS.map(m => <option key={m} value={m}>{MARKER_LABEL[m]}</option>)}
              </select>
              <select className="sidebar-select" aria-label={`Line of ${p.name}`} value={p.line ?? 'solid'}
                onChange={e => update(p.id, { line: e.target.value as LineStyle })}>
                {LINES.map(l => <option key={l} value={l}>{LINE_LABEL[l]}</option>)}
              </select>
            </div>
          ))}
          {state.timeSeriesPoints.length > 1 && (
            <div className="series-style-row">
              <span className="row-label">All points:</span>
              <button type="button" className="hist-btn" onClick={() => all({ line: 'none' })}>Markers only</button>
              <button type="button" className="hist-btn" onClick={() => all({ marker: 'none', line: 'solid' })}>Lines only</button>
              <button type="button" className="hist-btn" onClick={() => all({ marker: 'circle', line: 'solid' })}>Both</button>
            </div>
          )}
          {state.chartAreas.map(a => {
            const look = areaStyle(a);
            return (
              <div key={a.id} className="series-style-area">
                <div className="series-style-row">
                  <input type="color" value={a.color} aria-label={`Colour of ${a.name}`} onChange={e => updateArea(a.id, { color: e.target.value })} />
                  <span className="series-style-name" title={a.name}>{a.name}</span>
                  <select className="sidebar-select" aria-label={`Median line of ${a.name}`} value={look.line}
                    onChange={e => updateArea(a.id, { line: e.target.value as LineStyle })}>
                    {LINES.map(l => <option key={l} value={l}>{LINE_LABEL[l]}</option>)}
                  </select>
                  <select className="sidebar-select" aria-label={`Line width of ${a.name}`} value={look.lineWidth}
                    onChange={e => updateArea(a.id, { lineWidth: Number(e.target.value) })}>
                    {AREA_WIDTHS.map(w => <option key={w} value={w}>{w}px</option>)}
                  </select>
                </div>
                <div className="series-style-row series-style-sub">
                  <label><input type="checkbox" checked={look.showMean} aria-label={`Mean of ${a.name}`}
                    onChange={() => updateArea(a.id, { showMean: !look.showMean })} /> Mean</label>
                  <label><input type="checkbox" checked={look.showBand} aria-label={`Band of ${a.name}`}
                    onChange={() => updateArea(a.id, { showBand: !look.showBand })} /> Band</label>
                  <input type="range" min={0} max={0.8} step={0.05} value={look.bandOpacity} disabled={!look.showBand}
                    aria-label={`Band opacity of ${a.name}`} onChange={e => updateArea(a.id, { bandOpacity: Number(e.target.value) })} />
                  <span className="slider-value">{Math.round(look.bandOpacity * 100)}%</span>
                </div>
              </div>
            );
          })}
          <div className="row-label" style={{ fontSize: '0.9em' }}>A colour is also the feature's colour on the map.</div>
        </div>
      )}
    </div>
  );
}
