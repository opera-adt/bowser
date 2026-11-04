import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';

/** What the identify tool found at the last click. */
export default function IdentifyPanel() {
  const { state, dispatch } = useAppContext();
  const { panelRef, panelStyle, onDragMouseDown } = useDraggableResizable({
    defaultWidth: 320, defaultHeight: 300, initialRight: 100, initialBottom: 240,
  });
  const r = state.identify;
  if (!state.identifyEnabled || !r) return null;
  return (
    <div ref={panelRef} className="identify-panel" style={{ ...panelStyle, height: 'auto', maxHeight: 420 }}
      onMouseDown={e => e.stopPropagation()}>
      <div className="identify-head" onMouseDown={onDragMouseDown}>
        <strong>Here</strong>
        <span className="identify-coord">{r.lngLat[1].toFixed(5)}, {r.lngLat[0].toFixed(5)}</span>
        <button type="button" className="ov-icon-btn" title="Close" onClick={() => dispatch({ type: 'SET_IDENTIFY', payload: null })}>
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div className="identify-body">
        {r.items.length === 0 && r.pending.length === 0 && (
          <div className="row-label">Nothing here. Switch on geology, soils or land cover (Overlays › Services), or click a GNSS station.</div>
        )}
        {r.items.map((item, i) => (
          <div key={i} className="identify-item">
            <div className="identify-title">
              {item.color && <i style={{ background: item.color }} />}
              {item.title}
            </div>
            <table>
              <tbody>
                {item.rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}
              </tbody>
            </table>
            {item.link && <a href={item.link} target="_blank" rel="noopener noreferrer">Source</a>}
          </div>
        ))}
        {r.pending.length > 0 && <div className="row-label">Looking up {r.pending.join(' and ')}…</div>}
      </div>
    </div>
  );
}
