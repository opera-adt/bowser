import { useAppDispatch, useAppFields } from '../context/AppContext';
import type { AreaSupport } from '../types';

/** A shared analysis choice for all chart and Stats summaries, not a data mask. */
export default function PolygonSupportControl() {
  const { areaSupport, customMaskPath } = useAppFields('areaSupport', 'customMaskPath');
  const dispatch = useAppDispatch();
  const choice = areaSupport ?? 'auto';
  return <div className="chart-sliders">
    <label className="chart-area-note chart-area-band" title="Applies to charts and the Stats tab. Same pixels across dates improves comparability but can reduce coverage.">Area pixels{' '}
      <select className="sidebar-select" aria-label="Area pixel support" value={choice}
        onChange={e => dispatch({ type: 'SET_AREA_SUPPORT', payload: e.target.value as AreaSupport })}>
        <option value="auto">Automatic</option>
        <option value="common">Same pixels at every date</option>
        <option value="per_date">Available pixels on each date</option>
      </select>
    </label>
    {choice === 'common' && customMaskPath && <span className="chart-area-note">Uploaded mask: only pixels valid at every date are retained.</span>}
  </div>;
}
