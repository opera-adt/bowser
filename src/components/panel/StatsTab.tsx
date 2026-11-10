import { useMemo, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useAreaReference } from '../../hooks/useAreaReference';
import { areaStatsKey } from '../../utils/polygonSeries';
import { chartDatasets } from '../../utils/zonalStats';
import { areaRows, geometryBounds, medianTrend, recordAverage, statsCsv, toIsoDate, type AreaRow, type StatsTableRow } from '../../utils/areaStats';
import { activeRefTime } from '../../utils/refDate';
import { displayUnit } from '../../utils/units';
import { saveFile } from '../../utils/saveFile';
import { LayerOptions, SectionHeader } from './controls';
import type { ChartArea } from '../../types';

type SortKey = 'order' | 'name' | 'mean' | 'median' | 'std' | 'trend';
const SORTS: [SortKey, string][] = [['order', 'Added'], ['name', 'Name'], ['mean', 'Mean'], ['median', 'Median'], ['std', 'Std'], ['trend', 'Trend']];

/**
 * Stats: every area in the chart (from Zonal stats on a vector layer or + Area) with its pixel
 * count and, at the map's date or averaged over the record, its mean, median, spread (std, p10,
 * p90) and the median's linear trend. Values are as the chart shows them: the viewer's reference
 * and any chosen reference date taken off, in the display units.
 */
export default function StatsTab() {
  const { state, dispatch } = useAppContext();
  const [whole, setWhole] = useState(false);
  const [sort, setSort] = useState<SortKey>('order');
  const [chosenDs, setChosenDs] = useState<string | null>(null);

  // The layers asked for: the chart's, then any other with answers.
  const withAnswers = [...new Set(Object.keys(state.areaStats).map(k => k.split('::')[0]))];
  const layers = [...new Set([...chartDatasets(state), ...withAnswers])].filter(ds => state.datasetInfo[ds]);
  const ds = chosenDs && layers.includes(chosenDs) ? chosenDs : layers[0] ?? null;
  const areas = state.chartAreas;
  const reference = useAreaReference(ds ? [ds] : [], areas.length > 0 && !!ds);
  const info = ds ? state.datasetInfo[ds] : undefined;
  const shown = displayUnit(info?.unit, state.units);
  const rateUnit = shown.rate?.label ?? shown.label;
  const refIndex = ds ? activeRefTime(info, state.refTimeIndex[ds], state.dataMode) : null;
  const ref = ds ? reference(ds) : null;

  // The map's date: its label in the map's layer, found in this layer's dates.
  const mapLabel = state.datasetInfo[state.currentDataset]?.x_values?.[state.currentTimeIndex];
  const table = useMemo(() => areas.map((a, order) => {
    const entry = ds ? state.areaStats[areaStatsKey(ds, a.id)] : undefined;
    let rows: AreaRow[] | null = null;
    if (entry?.data && ref !== undefined) rows = areaRows(entry.data, ref, refIndex);
    let stats: AreaRow | null = null;
    if (rows) {
      if (whole) stats = recordAverage(rows);
      else {
        const i = rows.findIndex(r => r.label === String(mapLabel));
        stats = rows[i >= 0 ? i : Math.min(state.currentTimeIndex, rows.length - 1)] ?? null;
      }
    }
    return {
      area: a, order, entry,
      pixels: entry?.data ? (entry.data.polygon_pixels ?? Math.max(0, ...entry.data.statistics.map(s => s.count))) : null,
      stats, trend: rows ? medianTrend(rows, toIsoDate, shown) : null,
    };
  }), [areas, ds, state.areaStats, ref, refIndex, whole, mapLabel, state.currentTimeIndex, shown]);

  const sorted = [...table].sort((x, y) => {
    if (sort === 'order') return x.order - y.order;
    if (sort === 'name') return x.area.name.localeCompare(y.area.name);
    const pick = (r: typeof x) => (sort === 'trend' ? r.trend : r.stats?.[sort]) ?? -Infinity;
    return pick(y) - pick(x);
  });

  const pending = ds ? areas.filter(a => state.areaStats[areaStatsKey(ds, a.id)]?.pending).length : 0;
  const when = whole ? 'all dates (average)' : (sorted.find(r => r.stats)?.stats?.label ?? '');
  const fmt = (v: number | null | undefined, k = shown.factor) =>
    (v === null || v === undefined || !Number.isFinite(v) ? '–' : (v * k).toPrecision(3));

  const download = () => {
    if (!ds) return;
    const rows: StatsTableRow[] = sorted.map(r => ({
      name: r.area.name, layer: r.area.source?.layer ?? 'drawn', pixels: r.pixels, stats: r.stats, trend: r.trend,
    }));
    const csv = statsCsv(rows, { dataset: ds, when: whole ? 'all dates' : toIsoDate(when), unit: shown.label, rateUnit, factor: shown.factor });
    void saveFile(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `zonal-stats-${ds}-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const zoom = (a: ChartArea) => { const b = geometryBounds(a.geometry); if (b) dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: b }); };

  return (
    <div className="sidebar-section">
      <SectionHeader label="Zonal stats" />
      {areas.length === 0 ? (
        <div className="row-label" style={{ fontSize: '0.76em', lineHeight: 1.45 }}>
          No areas yet. Use <i className="fa-solid fa-chart-column"></i> on a vector layer in Overlays, or + Area in the chart.
        </div>
      ) : (
        <>
          {layers.length > 1 && (
            <div className="toggle-row" style={{ gap: 6 }}>
              <span className="row-label">Layer</span>
              <select className="sidebar-select" style={{ flex: 1, minWidth: 0, fontSize: '0.76em' }} aria-label="Stats layer"
                value={ds ?? ''} onChange={e => setChosenDs(e.target.value)}>
                <LayerOptions names={layers} />
              </select>
            </div>
          )}
          <div className="segmented" role="radiogroup" aria-label="Statistics for">
            {([false, true] as const).map(w => (
              <button key={String(w)} type="button" role="radio" aria-checked={whole === w}
                className={`segmented-item${whole === w ? ' active' : ''}`} onClick={() => setWhole(w)}>
                {w ? 'Whole record' : 'This date'}
              </button>
            ))}
          </div>
          <div className="toggle-row" style={{ gap: 6 }}>
            <span className="row-label">Sort by</span>
            <select className="sidebar-select" style={{ width: 'auto', fontSize: '0.76em' }} aria-label="Sort by"
              value={sort} onChange={e => setSort(e.target.value as SortKey)}>
              {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <button type="button" className="hist-btn" style={{ flex: 'none', marginLeft: 'auto' }} onClick={download} disabled={!ds}>
              <i className="fa-solid fa-download"></i> Download CSV
            </button>
          </div>
          <div className="row-label" style={{ fontSize: '0.72em' }}>
            {pending > 0 && <>{areas.length - pending}/{areas.length} areas · </>}
            {whole ? 'Average over all dates' : when ? `On ${toIsoDate(when)}` : ''}
            {ref ? ' · relative to the reference' : ''}{refIndex !== null && info ? ` · relative to ${toIsoDate(String(info.x_values[refIndex]))}` : ''}
          </div>
          <div className="zs-list" role="list" aria-label="Zonal stats">
            {sorted.map(({ area: a, entry, pixels, stats, trend }) => (
              <div key={a.id} className={`zs-row${a.visible ? '' : ' hidden'}`} role="listitem" aria-label={a.name}>
                <div className="ov-row-head">
                  <span className="ov-swatch" style={{ background: a.color }} />
                  <span className="ov-name" title={a.name}>{a.name}</span>
                  <button type="button" className="ov-icon-btn" title={a.visible ? 'Hide in the chart' : 'Show in the chart'} aria-pressed={a.visible}
                    onClick={() => dispatch({ type: 'UPDATE_CHART_AREA', payload: { id: a.id, updates: { visible: !a.visible } } })}>
                    <i className={`fa-solid ${a.visible ? 'fa-eye' : 'fa-eye-slash'}`}></i>
                  </button>
                  <button type="button" className="ov-icon-btn" title={`Zoom to ${a.name}`} onClick={() => zoom(a)}>
                    <i className="fa-solid fa-crosshairs"></i>
                  </button>
                  <button type="button" className="ov-icon-btn danger" title={`Remove ${a.name}`}
                    onClick={() => dispatch({ type: 'REMOVE_CHART_AREA', payload: a.id })}>
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
                <div className="ov-type zs-source">
                  {a.source?.layer ?? 'Drawn'}{pixels !== null ? ` · ${pixels} px` : ''}
                </div>
                {entry?.error ? (
                  <div className="row-label" style={{ fontSize: '0.72em', color: 'var(--sb-red)' }}>{entry.error}</div>
                ) : !stats ? (
                  <div className="row-label" style={{ fontSize: '0.72em' }}>{entry?.pending || !entry ? 'Working…' : 'No value on this date'}</div>
                ) : (
                  <dl className="zs-stats">
                    <div><dt>Mean</dt><dd>{fmt(stats.mean)}</dd></div>
                    <div><dt>Median</dt><dd>{fmt(stats.median)}</dd></div>
                    <div><dt>Std</dt><dd>{fmt(stats.std)}</dd></div>
                    <div><dt>p10</dt><dd>{fmt(stats.p10)}</dd></div>
                    <div><dt>p90</dt><dd>{fmt(stats.p90)}</dd></div>
                    <div title="Linear trend of the median over the record"><dt>Trend</dt><dd>{fmt(trend, 1)}</dd></div>
                  </dl>
                )}
              </div>
            ))}
          </div>
          <div className="row-label" style={{ fontSize: '0.7em' }}>
            Values in {shown.label || 'data units'}; trend of the median in {rateUnit}/yr. Std, p10 and p90 are across the pixels.
          </div>
        </>
      )}
    </div>
  );
}
