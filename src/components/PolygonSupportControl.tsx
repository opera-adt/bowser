import { useAppDispatch, useAppFields } from '../context/AppContext';
import type { AreaSupport } from '../types';

/** A shared analysis choice for all chart and Stats summaries, not a data mask. */
export default function PolygonSupportControl() {
  const { areaSupport } = useAppFields('areaSupport');
  const dispatch = useAppDispatch();
  const choice = areaSupport ?? 'auto';
  return <div className="chart-area-note">
    <label>Area pixels{' '}
      <select className="sidebar-select" aria-label="Area pixel support" value={choice}
        onChange={e => dispatch({ type: 'SET_AREA_SUPPORT', payload: e.target.value as AreaSupport })}>
        <option value="auto">Automatic</option>
        <option value="common">Same pixels at every date</option>
        <option value="per_date">Available pixels on each date</option>
      </select>
    </label>
    <span>{choice === 'common' ? ' Comparable footprint; gaps can reduce coverage.'
      : choice === 'per_date' ? ' More coverage; changing pixels can affect the history.'
      : ' Same pixels without quality masks; available pixels on each date when masked.'}
      {' '}Applies to all area charts and summaries.
    </span>
  </div>;
}
