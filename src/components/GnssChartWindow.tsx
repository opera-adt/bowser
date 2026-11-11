import { useEffect, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { chartLayerFor } from '../utils/chartLayers';
import { gnssSeriesUrl, losVector, rateSource, stepMarkers, toLos, type GnssSeries } from '../map/gnss';
import { describeFit, fitSeries, modelCurve, modelLabel } from '../map/fitSettings';
import ModelCard, { type PickKind } from './ModelCard';
import { displayUnit } from '../utils/units';

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A GNSS station's daily east, north and up (and LOS when the cube has a look vector), from the identify tool. */
export default function GnssChartWindow() {
  const { state, dispatch } = useAppContext();
  const station = state.gnssChartStation;
  const [series, setSeries] = useState<GnssSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModel, setShowModel] = useState(false);
  const [picking, setPicking] = useState<PickKind | null>(null);
  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: 560, defaultHeight: 640, initialRight: 440, initialBottom: 20, fitContent: true,
  });

  useEffect(() => {
    if (!station) return;
    let cancelled = false;
    setSeries(null);
    setError(null);
    fetch(gnssSeriesUrl(station))
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.detail ?? `HTTP ${r.status}`); return b; })
      .then(b => { if (!cancelled) setSeries(b); })
      .catch(err => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [station?.id, station?.custom]);  // eslint-disable-line react-hooks/exhaustive-deps

  const ds = chartLayerFor(state.currentDataset, state.datasetInfo);
  const los = losVector(ds ? state.datasetInfo[ds]?.los_metadata : null);
  // GNSS is in mm; Project › Units can show inches.
  const u = displayUnit('mm', state.units);
  const dp = u.label === 'in' ? 2 : 1;
  // One fit per component, with the same model settings as the InSAR chart.
  const fits = useMemo(() => {
    if (!series || !showModel) return null;
    const comp = (values: number[]) => fitSeries(series.dates.map((d, i) => ({ x: d, y: values[i] * u.factor })), state.fitSettings);
    const losValues = los ? series.dates.map((_, i) => toLos(los, series.east_mm[i], series.north_mm[i], series.up_mm[i])) : null;
    return { East: comp(series.east_mm), North: comp(series.north_mm), Up: comp(series.up_mm), ...(losValues ? { LOS: comp(losValues) } : {}) } as Record<string, ReturnType<typeof fitSeries>>;
  }, [series, showModel, state.fitSettings, los, u.factor]);

  if (!station) return null;
  const text = cssVar('--sb-text', '#e8e6e3');
  const grid = cssVar('--sb-border', '#444750');
  const panels: [string, string, (i: number) => number, number][] = series ? [
    ['East', '#f59e0b', i => series.east_mm[i], station.ve_mm_yr],
    ['North', '#22c55e', i => series.north_mm[i], station.vn_mm_yr],
    ['Up', '#3b82f6', i => series.up_mm[i], station.vu_mm_yr],
    ...(los ? [['LOS', '#e11d48', (i: number) => toLos(los, series.east_mm[i], series.north_mm[i], series.up_mm[i]),
      toLos(los, station.ve_mm_yr, station.vn_mm_yr, station.vu_mm_yr)] as [string, string, (i: number) => number, number]] : []),
  ] : [];

  return (
    <div id="gnss-chart" ref={panelRef} className="gnss-chart-window" style={panelStyle} onMouseDown={e => e.stopPropagation()}>
      <div className="chart-header" onMouseDown={onDragMouseDown} style={{ cursor: 'grab' }}>
        <h4 style={{ margin: 0, fontSize: '0.9em' }}>GNSS {station.id}</h4>
        <div className="chart-controls">
          <button className={`chart-btn${showModel ? ' active' : ''}`} aria-pressed={showModel} aria-label="Model"
            onClick={() => setShowModel(v => !v)}
            title={showModel ? `Model: ${modelLabel(state.fitSettings)}` : 'Fit a model to each component (shared with the InSAR chart)'}>
            <i className={`fa-solid ${showModel ? 'fa-chart-line' : 'fa-chart-simple'}`}></i>
          </button>
          {series?.station_page && <a className="chart-btn" href={series.station_page} target="_blank" rel="noopener noreferrer">UNR page</a>}
          <button className="chart-btn" style={{ color: 'var(--sb-red)' }} title="Close" onClick={() => dispatch({ type: 'OPEN_GNSS_CHART', payload: null })}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div className="row-label" style={{ fontSize: '0.72em', padding: '2px 0 4px' }}>
        {station.custom
          ? <>Positions from your file, {u.label} from its first date{series?.frame ? ` (${series.frame})` : ''}. Rates are a straight-line fit, {u.label}/yr.</>
          : <>Daily positions, {u.label} from the first day, North America fixed (UNR IGS20). Rates are MIDAS, {u.label}/yr.</>}
        {los ? ' LOS is towards the satellite of this cube.' : ''}
      </div>
      {series?.monument && (
        <div className="gnss-monument">
          <b>Monument</b> {[series.monument.monument, series.monument.monument_height_m && `${series.monument.monument_height_m} m high`,
            series.monument.foundation && `on ${series.monument.foundation.toLowerCase()}`,
            series.monument.foundation_depth_m && `${series.monument.foundation_depth_m} m deep`,
            series.monument.geology && `in ${series.monument.geology.toLowerCase()}`].filter(Boolean).join(' · ')}
        </div>
      )}
      {series?.steps && series.steps.length > 0 && (
        <div className="gnss-steps">
          <details>
            <summary><b>Steps ({series.steps.length})</b> equipment changes and nearby earthquakes, dotted on the charts</summary>
            {series.steps.map((st, i) => (
              <span key={i} className={`model-chip model-chip-${st.kind === 'equipment' ? 'step' : 'break'}`} title={st.event ?? st.detail}>
                {st.date} {st.kind === 'equipment' ? st.detail : `quake ${st.detail}`}
              </span>
            ))}
          </details>
          <button type="button" className="chart-btn" title="Add these dates as steps in the model"
            onClick={() => {
              dispatch({ type: 'SET_FIT_SETTINGS', payload: { steps: [...new Set([...state.fitSettings.steps, ...series.steps!.map(st => st.date)])].sort().slice(0, 20) } });
              setShowModel(true);
            }}>
            Use as model steps
          </button>
        </div>
      )}
      {showModel && (
        <ModelCard settings={state.fitSettings} picking={picking} onPick={setPicking}
          onChange={patch => dispatch({ type: 'SET_FIT_SETTINGS', payload: patch })} />
      )}
      {error && <div className="row-label" style={{ color: 'var(--sb-red)' }}>{error}</div>}
      {!series && !error && <div className="chart-placeholder"><p>Loading…</p></div>}
      {series && (
        <div className="gnss-chart-stack">
          {panels.map(([name, color, at, rate], k) => (
            <div key={name} className="gnss-chart-panel">
              <Line
                data={{ datasets: [{
                  label: `${name} (${rateSource(station)} ${rate >= 0 ? '+' : ''}${(rate * u.factor).toFixed(dp)} ${u.label}/yr)`,
                  data: series.dates.map((d, i) => ({ x: Date.parse(d), y: at(i) * u.factor })),
                  borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 1, order: 2,
                }, ...(series.steps?.length ? (() => {
                  const ys = series.dates.map((_, i) => at(i) * u.factor);
                  return [{
                    label: 'steps',
                    data: stepMarkers(series.steps!, Math.min(...ys), Math.max(...ys)),
                    borderColor: '#a855f7', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1, borderDash: [2, 3], spanGaps: false, order: 1,
                  }];
                })() : []), ...(fits?.[name] ? [{
                  label: 'model',
                  data: modelCurve(fits[name]!).map(p => ({ x: Date.parse(p.x), y: p.y })),
                  // In front of the data (Chart.js draws the lowest order last).
                  borderColor: cssVar('--sb-text', '#e8e6e3'), backgroundColor: 'transparent', pointRadius: 0, borderWidth: 2,
                  borderDash: [6, 4], spanGaps: false, order: 0,
                }] : [])] }}
                options={{
                  animation: false, maintainAspectRatio: false, parsing: false as never,
                  onClick: (event, _elements, chart) => {
                    if (!picking) return;
                    const t = chart.scales.x?.getValueForPixel(event.x ?? NaN);
                    if (typeof t === 'number' && Number.isFinite(t)) {
                      const iso = new Date(t).toISOString().slice(0, 10);
                      const key = picking === 'step' ? 'steps' : 'breaks';
                      dispatch({ type: 'SET_FIT_SETTINGS', payload: { [key]: [...new Set([...state.fitSettings[key], iso])].sort().slice(0, 20) } });
                    }
                    setPicking(null);
                  },
                  scales: {
                    x: { type: 'time', ticks: { color: text, maxTicksLimit: 6, display: k === panels.length - 1 }, grid: { color: grid } },
                    y: { title: { display: true, text: u.label, color: text }, ticks: { color: text, maxTicksLimit: 4 }, grid: { color: grid } },
                  },
                  plugins: { legend: { labels: { color: text, boxWidth: 10, font: { size: 10 } } } },
                }}
              />
            </div>
          ))}
        </div>
      )}
      {fits && (
        <div className="model-summary">
          {Object.entries(fits).map(([name, fit]) => <div key={name}><b>{name}</b>: {describeFit(fit, 1, u.label)}</div>)}
        </div>
      )}
      {resizeGrip}
    </div>
  );
}
