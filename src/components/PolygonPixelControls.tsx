import type { ChartArea } from '../types';
import type { PixelPreviewSelection } from '../hooks/usePolygonPixelPreview';

interface Props { areas: ChartArea[]; layers: string[]; selection: PixelPreviewSelection | null;
  onChange: (value: PixelPreviewSelection | null) => void }

/** A small optional preview; summaries retain their own all-pixel support. Session only. */
export default function PolygonPixelControls({ areas, layers, selection, onChange }: Props) {
  if (!areas.length || !layers.length) return null;
  return <div className="chart-area-notes">
    <label className="chart-area-note">Pixels <select aria-label="Polygon pixel histories" className="sidebar-select"
      value={selection?.curve_mode ?? 'none'} onChange={e => {
        const mode = e.target.value;
        onChange(mode === 'none' ? null : { areaId: selection?.areaId ?? areas[0].id,
          dataset: selection?.dataset ?? layers[0], curve_mode: mode as 'sample' | 'all', sample_count: selection && Number.isInteger(selection.sample_count) && selection.sample_count >= 1 && selection.sample_count <= 500 ? selection.sample_count : 50 });
      }}>
      <option value="none">Off</option><option value="sample">Sample</option><option value="all">All (bounded)</option>
    </select></label>
    {selection && <>
      <select aria-label="Pixel history area" className="sidebar-select" value={selection.areaId}
        onChange={e => onChange({ ...selection, areaId: e.target.value })}>
        {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {layers.length > 1 && <select aria-label="Pixel history layer" className="sidebar-select" value={selection.dataset}
        onChange={e => onChange({ ...selection, dataset: e.target.value })}>
        {layers.map(ds => <option key={ds} value={ds}>{ds}</option>)}
      </select>}
      {selection.curve_mode === 'sample' && <label className="chart-area-note">Limit <input aria-label="Pixel sample size" type="number"
        min={1} max={500} step={1} value={selection.sample_count} style={{ width: 60 }}
        onChange={e => onChange({ ...selection, sample_count: Number(e.target.value) })} /></label>}
      <span className="chart-area-note">One area/layer. Up to 500 curves and 100,000 values. Summaries use all eligible pixels.</span>
    </>}
  </div>;
}
