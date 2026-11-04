import { useState } from 'react';
import type { FitSettings } from '../map/fitSettings';

export type PickKind = 'step' | 'break';

interface ModelCardProps {
  settings: FitSettings;
  onChange: (patch: Partial<FitSettings>) => void;
  picking: PickKind | null;
  onPick: (kind: PickKind | null) => void;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The trend model, as in the OPERA DISP portal's Model card: polynomial order, annual and
 * semi-annual terms, 3σ outlier rejection, segment breaks and steps (typed or picked on the chart).
 */
export default function ModelCard({ settings: s, onChange, picking, onPick }: ModelCardProps) {
  const dateRow = (kind: PickKind, key: 'steps' | 'breaks', label: string, hint: string) => (
    <DateList kind={kind} label={label} hint={hint} dates={s[key]} picking={picking === kind}
      onPick={() => onPick(picking === kind ? null : kind)}
      onAdd={iso => onChange({ [key]: [...new Set([...s[key], iso])].sort().slice(0, 20) })}
      onRemove={iso => onChange({ [key]: s[key].filter(d => d !== iso) })} />
  );
  return (
    <div className="model-card">
      <div className="model-row">
        <label>Polynomial{' '}
          <select className="sidebar-select model-select" value={s.polyOrder} aria-label="Polynomial order"
            onChange={e => onChange({ polyOrder: Number(e.target.value) as FitSettings['polyOrder'] })}>
            <option value={0}>offset</option>
            <option value={1}>linear</option>
            <option value={2}>quadratic</option>
            <option value={3}>cubic</option>
          </select>
        </label>
        <label><input type="checkbox" checked={s.annual} onChange={e => onChange({ annual: e.target.checked })} /> annual</label>
        <label><input type="checkbox" checked={s.semiannual} onChange={e => onChange({ semiannual: e.target.checked })} /> semi-annual</label>
        <label title="Iteratively exclude points beyond 3 robust σ">
          <input type="checkbox" checked={s.rejectOutliers} onChange={e => onChange({ rejectOutliers: e.target.checked })} /> reject outliers
        </label>
      </div>
      {dateRow('break', 'breaks', 'Segments', 'Break the polynomial at each date: a separate fit (rate) per segment')}
      {dateRow('step', 'steps', 'Steps', 'An offset (jump) at each date: earthquakes, equipment changes')}
    </div>
  );
}

function DateList({ kind, label, hint, dates, picking, onPick, onAdd, onRemove }: {
  kind: PickKind; label: string; hint: string; dates: string[]; picking: boolean;
  onPick: () => void; onAdd: (iso: string) => void; onRemove: (iso: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="model-row" title={hint}>
      <span className="model-label">{label}</span>
      {dates.length === 0 && <span className="model-muted">none</span>}
      {dates.map(d => (
        <span key={d} className={`model-chip model-chip-${kind}`}>
          {d}
          <button type="button" aria-label={`Remove ${d}`} onClick={() => onRemove(d)}>×</button>
        </span>
      ))}
      <input type="date" className="model-date" value={draft} aria-label={`${label} date`} onChange={e => setDraft(e.target.value)} />
      <button type="button" className="chart-btn" disabled={!ISO.test(draft)} onClick={() => { onAdd(draft); setDraft(''); }} title={`Add the ${kind} date`}>+</button>
      <button type="button" className={`chart-btn${picking ? ' active' : ''}`} aria-pressed={picking} onClick={onPick}
        title={`Click the chart to add a ${kind} there`}>
        {picking ? 'Click the chart…' : 'Pick on chart'}
      </button>
    </div>
  );
}
