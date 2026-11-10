import { useAppContext } from '../context/AppContext';
import { clampTimeIndex } from '../utils/timeStep';

/** A time label as shown: a date, or a "reference → secondary" pair. */
export function dateLabel(value: unknown): string {
  const s = String(value ?? '');
  const pair = s.split('_');
  if (pair.length === 2 && pair.every(p => /^\d{4}-?\d{2}-?\d{2}/.test(p))) return `${pair[0].slice(0, 10)} → ${pair[1].slice(0, 10)}`;
  return s.replace(/T.*/, '');
}

/**
 * The map's time step under the left tools. Clicking the date in Main › Layers cycles: the badge
 * (previous / next and a slider, the same time step as the panel's slider), the date alone, hidden.
 */
export default function DateBadge() {
  const { state, dispatch } = useAppContext();
  const info = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
  const n = info?.x_values.length ?? 0;
  if (state.dateBadge === 'off' || n < 2) return null;
  const i = Math.min(state.currentTimeIndex, n - 1);
  const go = (next: number) => dispatch({ type: 'SET_TIME_INDEX', payload: clampTimeIndex(next, n) });
  const tip = `${i + 1} of ${n}${state.currentDataset ? ` · ${state.currentDataset}` : ''}`;
  if (state.dateBadge === 'date') {
    return (
      <div className="date-badge date-only" aria-live="polite" title={tip} onMouseDown={e => e.stopPropagation()}>
        <span className="date-badge-date">{dateLabel(info!.x_values[i])}</span>
      </div>
    );
  }
  return (
    <div className="date-badge" role="group" aria-label="Map date" onMouseDown={e => e.stopPropagation()}
      title={tip}>
      <button type="button" className="date-badge-step" aria-label="Previous date" disabled={i === 0} onClick={() => go(i - 1)}>‹</button>
      <span className="date-badge-date" aria-live="polite">{dateLabel(info!.x_values[i])}</span>
      <button type="button" className="date-badge-step" aria-label="Next date" disabled={i === n - 1} onClick={() => go(i + 1)}>›</button>
      <button type="button" className="date-badge-close" aria-label="Hide the date" title="Hide the date (click the date in Main › Layers to show it again)"
        onClick={() => dispatch({ type: 'TOGGLE_DATE_BADGE' })}>×</button>
      {/* A thin progress line along the bottom edge, draggable like the panel's slider. */}
      <input type="range" className="date-badge-track" min={0} max={n - 1} step={1} value={i} aria-label="Map date"
        style={{ ['--progress' as string]: `${(100 * i) / (n - 1)}%` }}
        onChange={e => go(parseInt(e.target.value))} />
    </div>
  );
}
