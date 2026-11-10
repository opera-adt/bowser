import { useEffect, useRef, useState } from 'react';
import type { RasterGroup } from '../../types';
import { activeRefTime, canReReference, refDateLabel } from '../../utils/refDate';

interface RefDatePickerProps {
  info: RasterGroup;
  /** The step chosen for this layer, if any (state.refTimeIndex[layer]). */
  chosen: number | undefined;
  currentTimeIndex: number;
  dataMode: string;
  onChoose: (index: number | null) => void;
}

/**
 * The layer's reference date, "ref: <date>", in the Time step header just left of the date. For displacement-like layers clicking it
 * offers another date (from the list or the current one), the map and chart then showing
 * value − value at that date; Reset goes back to the stored reference.
 */
export default function RefDatePicker({ info, chosen, currentTimeIndex, dataMode, onChoose }: RefDatePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const movable = canReReference(info) && dataMode === 'md';
  const active = activeRefTime(info, chosen, dataMode);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const stored = info.reference_date ? `ref: ${info.reference_date}` : 'ref: stored';
  if (!movable) {
    return info.reference_date ? <span className="ref-date"><span className="slider-value ref-date-label">{stored}</span></span> : null;
  }
  const choose = (index: number | null) => { onChoose(index); setOpen(false); };
  const current = Math.min(currentTimeIndex, info.x_values.length - 1);
  const label = active === null ? stored : `ref: ${refDateLabel(info.x_values[active])}`;

  return (
    <span className="ref-date" ref={rootRef}>
      <button type="button" className={`slider-value date-toggle ref-date-label${active === null ? '' : ' on'}`}
        aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={active === null
          ? `Reference date${info.reference_date ? '' : ' as stored in the layer'}: click to reference to another date`
          : `Shown relative to ${refDateLabel(info.x_values[active])}: click to change or reset`}>
        {label}
      </button>
      {open && (
        <div className="cscale-pop ref-date-pop" role="group" aria-label="Reference date">
          <span className="row-label">Reference to another date…</span>
          <select className="sidebar-select" aria-label="Reference to date" value={active ?? ''}
            onChange={e => choose(parseInt(e.target.value))}>
            {active === null && <option value="" disabled>Choose a date</option>}
            {info.x_values.map((x, i) => <option key={i} value={i}>{refDateLabel(x)}</option>)}
          </select>
          <div className="cscale-actions">
            <button type="button" className="hist-btn" onClick={() => choose(current)}
              title={`Reference to ${refDateLabel(info.x_values[current])}, the date on the map`}>Use current date</button>
            <button type="button" className="hist-btn" disabled={active === null} onClick={() => choose(null)}
              title="Back to the reference date stored in the layer">Reset</button>
          </div>
        </div>
      )}
    </span>
  );
}
