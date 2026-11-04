import { useEffect, useRef, useState } from 'react';
import { baseColormap, COLORMAP_GROUPS, colormapLabel, isInverted, withInvert } from '../../utils/colormaps';
import { Switch } from './controls';

const fmt = (v: number) => String(+v.toPrecision(4));

export interface RangeStats {
  p2: number;
  p98: number;
  p5?: number;
  p95?: number;
}

const PRESETS: { label: string; lo: keyof RangeStats; hi: keyof RangeStats; title: string }[] = [
  { label: '2–98%', lo: 'p2', hi: 'p98', title: "Set the range to the layer's 2nd and 98th percentiles" },
  { label: '5–95%', lo: 'p5', hi: 'p95', title: "Set the range to the layer's 5th and 95th percentiles" },
];

interface ColorScalePickerProps {
  colormap: string;
  vmin: number;
  vmax: number;
  /** Percentiles for the range presets (null when they can't be had). */
  stats: () => Promise<RangeStats | null>;
  onColormap: (colormap: string) => void;
  onRange: (vmin: number, vmax: number) => void;
  /** Show values times ``factor`` with ``label`` (inches in imperial); the range stays in data units. */
  display?: { factor: number; label: string };
}

/**
 * The colour bar with its range. Clicking it opens every option: the colormaps by
 * group, min and max, 2–98 % and 5–95 % of the layer, ± symmetric and invert. Closes on Esc, a click
 * elsewhere, or a second click on the bar.
 */
export default function ColorScalePicker({ colormap, vmin, vmax, stats, onColormap, onRange, display }: ColorScalePickerProps) {
  const k = display?.factor ?? 1;
  const suffix = display?.label ? ` ${display.label}` : '';
  const [open, setOpen] = useState(false);
  const [draftMin, setDraftMin] = useState(fmt(vmin * k));
  const [draftMax, setDraftMax] = useState(fmt(vmax * k));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraftMin(fmt(vmin * k)), [vmin, k]);
  useEffect(() => setDraftMax(fmt(vmax * k)), [vmax, k]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const commitMin = () => { const v = Number(draftMin); if (draftMin.trim() !== '' && !Number.isNaN(v)) onRange(v / k, vmax); };
  const commitMax = () => { const v = Number(draftMax); if (draftMax.trim() !== '' && !Number.isNaN(v)) onRange(vmin, v / k); };

  const preset = async (lo: keyof RangeStats, hi: keyof RangeStats) => {
    try {
      const r = await stats();
      const a = r?.[lo];
      const b = r?.[hi];
      if (typeof a === 'number' && typeof b === 'number') onRange(a, b);
    } catch { /* keep the current range */ }
  };

  const symmetric = () => {
    const m = Math.max(Math.abs(vmin), Math.abs(vmax));
    onRange(-m, m);
  };

  return (
    <div className="cscale" ref={rootRef}>
      <button type="button" className="cscale-bar" aria-expanded={open} title="Change the colormap and range" onClick={() => setOpen(o => !o)}>
        <img src={`/colorbar/${colormap}`} className="cscale-gradient" alt="" />
        <span className="cscale-labels">
          <span>{fmt(vmin * k)}{suffix}</span>
          <span className="cscale-name">{colormapLabel(colormap)}</span>
          <span>{fmt(vmax * k)}{suffix}</span>
        </span>
      </button>
      {open && (
        <div className="cscale-pop">
          <div className="cscale-range">
            <label className="minmax-field">
              <span className="minmax-label">Min{suffix}</span>
              <input aria-label="Min value" className="sidebar-input" type="text" inputMode="decimal" value={draftMin}
                onChange={e => setDraftMin(e.target.value)} onBlur={commitMin} onKeyDown={e => e.key === 'Enter' && commitMin()} />
            </label>
            <label className="minmax-field">
              <span className="minmax-label">Max{suffix}</span>
              <input aria-label="Max value" className="sidebar-input" type="text" inputMode="decimal" value={draftMax}
                onChange={e => setDraftMax(e.target.value)} onBlur={commitMax} onKeyDown={e => e.key === 'Enter' && commitMax()} />
            </label>
          </div>
          <div className="cscale-actions">
            {PRESETS.map(p => (
              <button key={p.label} type="button" className="hist-btn" onClick={() => preset(p.lo, p.hi)} title={p.title}>{p.label}</button>
            ))}
            <button type="button" className="hist-btn" onClick={symmetric} title="Centre the range on zero">± Symmetric</button>
          </div>
          <div className="toggle-row">
            <span className="row-label">Invert</span>
            <Switch checked={isInverted(colormap)} label="Invert colormap" onChange={() => onColormap(withInvert(colormap, !isInverted(colormap)))} />
          </div>
          {COLORMAP_GROUPS.map(([group, options]) => (
            <div key={group}>
              <div className="cscale-group">{group}</div>
              <div className="cscale-grid">
                {options.map(o => (
                  <button key={o.value} type="button" className="cscale-choice" aria-pressed={baseColormap(colormap) === o.value}
                    onClick={() => onColormap(withInvert(o.value, isInverted(colormap)))}>
                    <img src={`/colorbar/${o.value}`} alt="" loading="lazy" />
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
