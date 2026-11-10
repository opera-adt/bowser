import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { polygonChoices } from '../utils/polygonSeries';
import { AREA_NEEDS_SERVER, usePolygonStats } from '../hooks/usePolygonStats';

export { AREA_NEEDS_SERVER };

/**
 * The chart header's "+ Area" button: add a polygon's median, mean and p10–p90 band to the
 * chart. With polygons on the map (Draw tools or vector files) it lists them, with "Draw a new
 * area" last; with none it starts drawing a polygon on the map straight away.
 */
export default function ChartAreaButton() {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const supported = usePolygonStats();
  const rootRef = useRef<HTMLDivElement>(null);
  const choices = polygonChoices(state.overlays);

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
        aria-expanded={open} aria-pressed={state.areaDrawing} aria-label="Add an area" onClick={onClick} title={title}>
        <i className="fa-solid fa-draw-polygon"></i>
      </button>
      {open && (
        <div className="series-style-pop area-pick-pop" onMouseDown={e => e.stopPropagation()}>
          <div className="row-label">Add an area to the chart:</div>
          {choices.map(c => (
            <button key={c.key} type="button" className="hist-btn area-pick-item" title={c.name}
              onClick={() => { setOpen(false); dispatch({ type: 'ADD_CHART_AREA', payload: { geometry: c.geometry, name: c.name, source: c.source } }); }}>
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
