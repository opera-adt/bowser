import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { polygonChoices } from '../utils/polygonSeries';

/** Why the button is off on bowser-lite (its /config says polygon_stats: false). */
export const AREA_NEEDS_SERVER = 'Area statistics need the full Bowser server';

/**
 * The chart header's "+ Area" button: add a polygon's median, mean and p10–p90 band to the
 * chart. With polygons on the map (Draw tools or vector files) it lists them, with "Draw a new
 * area" last; with none it starts drawing a polygon on the map straight away.
 */
export default function ChartAreaButton() {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const choices = polygonChoices(state.overlays);

  useEffect(() => {
    let live = true;
    fetch('/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => { if (live && cfg?.polygon_stats === false) setSupported(false); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const draw = () => { setOpen(false); dispatch({ type: 'SET_AREA_DRAWING', payload: true }); };
  const onClick = () => {
    if (state.areaDrawing) dispatch({ type: 'SET_AREA_DRAWING', payload: false });
    else if (choices.length === 0) draw();
    else setOpen(o => !o);
  };

  const title = !supported ? AREA_NEEDS_SERVER
    : state.areaDrawing ? 'Stop waiting for an area'
    : 'Add an area: its median, mean and p10–p90 spread';

  return (
    <div className="series-style" ref={rootRef}>
      <button className={`chart-btn${open || state.areaDrawing ? ' active' : ''}`} disabled={!supported}
        aria-expanded={open} aria-pressed={state.areaDrawing} onClick={onClick} title={title}>
        <i className="fa-solid fa-draw-polygon"></i>
        <span className="chart-btn-label">+ Area</span>
      </button>
      {open && (
        <div className="series-style-pop area-pick-pop" onMouseDown={e => e.stopPropagation()}>
          <div className="row-label">Add an area to the chart:</div>
          {choices.map(c => (
            <button key={c.key} type="button" className="hist-btn area-pick-item" title={c.name}
              onClick={() => { setOpen(false); dispatch({ type: 'ADD_CHART_AREA', payload: { geometry: c.geometry, name: c.name } }); }}>
              {c.name}
            </button>
          ))}
          <button type="button" className="hist-btn area-pick-item" onClick={draw}>
            <i className="fa-solid fa-pen"></i> Draw a new area
          </button>
        </div>
      )}
    </div>
  );
}
