/** Split-screen divider (DOM, shared by both maps): drag to move, plus the right-panel dataset selector. */
import { useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';

export default function SplitDivider() {
  const { state, dispatch } = useAppContext();
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const parent = containerRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const pos = Math.max(0.1, Math.min(0.9, (e.clientX - rect.left) / rect.width));
      dispatch({ type: 'SET_SPLIT_POSITION', payload: pos });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dispatch]);

  const datasets = Object.keys(state.datasetInfo);
  const pct = `${(state.splitPosition * 100).toFixed(2)}%`;

  return (
    <div ref={containerRef} style={{ position: 'absolute', top: 0, bottom: 0, left: pct, width: 0, zIndex: 1500, pointerEvents: 'none' }}>
      {/* vertical rule */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: -1, width: 2, background: 'rgba(255,255,255,0.85)', boxShadow: '0 0 6px rgba(0,0,0,0.5)', pointerEvents: 'none' }} />

      {/* drag handle */}
      <div
        onMouseDown={e => { e.preventDefault(); dragging.current = true; }}
        style={{
          position: 'absolute', top: '50%', left: -18, transform: 'translateY(-50%)',
          width: 36, height: 36, background: 'var(--toolbar-bg)',
          border: '1px solid var(--sb-border)', borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'ew-resize', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          fontSize: 13, color: 'var(--sb-text)', pointerEvents: 'all',
        }}
      >
        <i className="fa-solid fa-arrows-left-right" />
      </div>

      {/* right-panel dataset selector */}
      <div style={{
        position: 'absolute', top: 10, left: 8,
        background: 'var(--toolbar-bg)', border: '1px solid var(--sb-border)',
        borderRadius: 6, padding: '4px 8px', fontSize: '0.78em',
        color: 'var(--sb-text)', whiteSpace: 'nowrap',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)', pointerEvents: 'all',
      }}>
        <select
          value={state.splitDataset || ''}
          onChange={e => dispatch({ type: 'SET_SPLIT_DATASET', payload: e.target.value || null })}
          style={{ background: 'transparent', border: 'none', color: 'inherit', fontSize: 'inherit', cursor: 'pointer', outline: 'none', maxWidth: 160 }}
        >
          <option value="">— right layer —</option>
          {datasets.map(ds => (
            <option key={ds} value={ds}>{state.datasetInfo[ds].label || ds}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
