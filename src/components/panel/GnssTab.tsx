import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { useAppContext } from '../../context/AppContext';
import { useApi } from '../../hooks/useApi';
import { refDragEnd } from '../../map/interactions';
import { chartLayerFor } from '../../utils/chartLayers';
import { GNSS_LAYER_ID, distanceKm, gnssLosSeries, losVector, mmPerUnit, toLos, typicalLos, type GnssSeries, type GnssStation } from '../../map/gnss';
import type { Overlay } from '../../types';
import { SectionHeader, Switch } from './controls';
import { displayUnit, type DisplayUnit } from '../../utils/units';

/** Half the side (degrees) of the view the zoom button opens on a station: about 2 km. */
const ZOOM_DEG = 0.01;

/** A GNSS value (mm) in the chosen units, with two decimals for inches. */
const show = (u: DisplayUnit, mm: number) => (mm * u.factor).toFixed(u.label === 'in' ? 2 : 1);

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** UNR GNSS stations in the view (MIDAS velocities), and one station's record against InSAR. */
export default function GnssTab() {
  const { state, dispatch } = useAppContext();
  const { fetchMultiPointTimeSeries, fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [stations, setStations] = useState<GnssStation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GnssStation | null>(null);

  const ds = chartLayerFor(state.currentDataset, state.datasetInfo);
  const info = ds ? state.datasetInfo[ds] : null;
  const cubeLos = losVector(info?.los_metadata ?? state.datasetInfo[state.currentDataset]?.los_metadata);
  const [pass, setPass] = useState<'ascending' | 'descending'>('ascending');
  const los = cubeLos ?? typicalLos(pass);
  const onMap = state.overlays.some(o => o.id === GNSS_LAYER_ID);
  const u = displayUnit('mm', state.units);

  const find = async () => {
    if (!state.viewBounds) return;
    const [south, west, north, east] = state.viewBounds;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ west: String(west), south: String(south), east: String(east), north: String(north) });
      const res = await fetch(`/gnss/stations?${q}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
      setStations(body.stations);
      if (onMap) showOnMap(body.stations);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const showOnMap = (list: GnssStation[]) => {
    const overlay: Overlay = {
      id: GNSS_LAYER_ID, name: 'GNSS stations (UNR)', type: 'vector', visible: true, opacity: 1, aboveData: true,
      color: '#e11d48', pointRadius: 5, lineWidth: 1,
      data: { type: 'FeatureCollection', features: list.map(s => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { ...s },
      })) },
      attribution: 'GNSS: Nevada Geodetic Laboratory (UNR), MIDAS velocities, NA fixed',
    };
    dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_LAYER_ID });
    dispatch({ type: 'ADD_OVERLAY', payload: overlay });
  };

  const [cx, cy] = state.viewBounds
    ? [(state.viewBounds[1] + state.viewBounds[3]) / 2, (state.viewBounds[0] + state.viewBounds[2]) / 2]
    : [0, 0];

  return (
    <>
      <div className="sidebar-section">
        <SectionHeader label="GNSS stations" />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="hist-btn" disabled={loading || !state.viewBounds} onClick={find}>
            {loading ? 'Finding…' : stations ? 'Find again in this view' : 'Find stations in this view'}
          </button>
        </div>
        <div className="toggle-row">
          <span style={{ fontSize: '0.82em' }}>Show them on the map</span>
          <Switch checked={onMap} label="Show GNSS stations on the map" onChange={() => {
            if (onMap) dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_LAYER_ID });
            else if (stations) showOnMap(stations);
          }} />
        </div>
        {error && <div className="row-label" style={{ fontSize: '0.76em', color: 'var(--sb-red)' }}>{error}</div>}
        {stations && stations.length === 0 && <div className="row-label">No stations with 3+ years of data in this view.</div>}
        {stations && stations.length > 0 && (
          <div className="gnss-list" role="listbox" aria-label="GNSS stations">
            {stations.map(s => (
              <div key={s.id} className="gnss-row">
                <button type="button" role="option" aria-selected={selected?.id === s.id}
                  className="gnss-item" onClick={() => setSelected(s)}>
                  <strong>{s.id}</strong>
                  <span>{los ? `${show(u, toLos(los, s.ve_mm_yr, s.vn_mm_yr, s.vu_mm_yr))} LOS` : `${show(u, s.vu_mm_yr)} up`}</span>
                  <span className="row-label">{distanceKm(cx, cy, s.lon, s.lat).toFixed(0)} km</span>
                </button>
                <button type="button" className="ov-icon-btn" title={`Zoom to ${s.id} and select it`} aria-label={`Zoom to ${s.id}`}
                  onClick={() => { setSelected(s); dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [s.lat - ZOOM_DEG, s.lon - ZOOM_DEG, s.lat + ZOOM_DEG, s.lon + ZOOM_DEG] }); }}>
                  <i className="fa-solid fa-magnifying-glass-plus"></i>
                </button>
              </div>
            ))}
          </div>
        )}
        {!cubeLos && (
          <>
            <div className="segmented" role="radiogroup" aria-label="Line of sight">
              {(['ascending', 'descending'] as const).map(p => (
                <button key={p} type="button" role="radio" aria-checked={pass === p}
                  className={`segmented-item${pass === p ? ' active' : ''}`} onClick={() => setPass(p)}>
                  {p === 'ascending' ? 'Ascending' : 'Descending'}
                </button>
              ))}
            </div>
            <div className="row-label" style={{ fontSize: '0.7em' }}>
              This cube has no line-of-sight vector: LOS uses a typical Sentinel-1 look (39° incidence), so it is approximate.
            </div>
          </>
        )}
        <div className="row-label" style={{ fontSize: '0.7em' }}>
          Velocities in {u.label}/yr (MIDAS, North America fixed); LOS is towards the satellite. Nearest the map centre first.
        </div>
      </div>
      {selected && (
        <StationCompare u={u} key={`${selected.id}:${state.refMarkerPosition.join(',')}`} station={selected} dataset={ds} los={los}
          isReference={Math.abs(state.refMarkerPosition[0] - selected.lat) < 1e-6 && Math.abs(state.refMarkerPosition[1] - selected.lon) < 1e-6}
          onUseAsReference={() => void refDragEnd(state, [selected.lat, selected.lon], { fetchPointTimeSeries, fetchBufferTimeSeries }, dispatch)}
          fetchInsar={async () => {
            if (!ds) return null;
            const ref = info?.uses_spatial_ref && state.refEnabled ? state.refMarkerPosition : null;
            const r = await fetchMultiPointTimeSeries(
              [{ id: selected.id, lat: selected.lat, lon: selected.lon, color: '#5bc0be', name: selected.id }],
              ds, ref?.[1], ref?.[0], false, state.layerMasks,
              state.refEnabled && state.refBufferEnabled ? state.refBufferRadius : 0,
            );
            return r?.datasets[0]?.data ?? null;
          }}
          unit={info?.unit}
          onAddPoint={() => dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [selected.lat, selected.lon], name: selected.id } })}
        />
      )}
    </>
  );
}

interface StationCompareProps {
  station: GnssStation;
  dataset: string | null;
  los: { east: number; north: number; up: number } | null;
  unit: string | undefined;
  fetchInsar: () => Promise<{ x: string; y: number }[] | null>;
  onAddPoint: () => void;
  isReference: boolean;
  onUseAsReference: () => void;
  u: DisplayUnit;
}

/** One station: velocities, and its LOS record against the InSAR series at the station. */
function StationCompare({ station: s, dataset, los, unit, fetchInsar, onAddPoint, isReference, onUseAsReference, u }: StationCompareProps) {
  const [series, setSeries] = useState<GnssSeries | null>(null);
  const [insar, setInsar] = useState<{ x: string; y: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = mmPerUnit(unit);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/gnss/series/${s.id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
        if (!cancelled) setSeries(body);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      try {
        const pts = await fetchInsar();
        if (!cancelled) setInsar(pts);
      } catch { /* the GNSS record still shows */ }
    })();
    return () => { cancelled = true; };
  }, [s.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const insarMm = insar && scale !== null ? insar.filter(p => Number.isFinite(p.y)).map(p => ({ x: String(p.x).slice(0, 10), y: p.y * scale })) : null;
  const insarStart = insarMm?.[0];
  const span = insarMm && insarMm.length > 1 ? [insarMm[0].x, insarMm[insarMm.length - 1].x] : null;
  const whole = series?.dates.length ? [series.dates[0], series.dates[series.dates.length - 1]] : null;
  const range = span ?? whole;
  const gnss = series && los && range ? gnssLosSeries(series, los, range[0], range[1]) : null;
  const noInsar = insar !== null && !(insarMm && insarMm.length > 1);
  const insarRel = insarMm && insarStart ? insarMm.map(p => ({ x: p.x, y: +(p.y - insarStart.y).toFixed(2) })) : null;
  const text = cssVar('--sb-text', '#e8e6e3');
  const grid = cssVar('--sb-border', '#444750');

  return (
    <div className="sidebar-section">
      <SectionHeader label={`Station ${s.id}`} />
      <div className="gnss-velocities">
        <span>East <b>{show(u, s.ve_mm_yr)}</b></span>
        <span>North <b>{show(u, s.vn_mm_yr)}</b></span>
        <span>Up <b>{show(u, s.vu_mm_yr)}</b> ±{show(u, s.sigma_vu_mm_yr)}</span>
        {los && <span>LOS <b>{show(u, toLos(los, s.ve_mm_yr, s.vn_mm_yr, s.vu_mm_yr))}</b></span>}
      </div>
      <div className="row-label" style={{ fontSize: '0.72em' }}>
        {u.label}/yr, {s.first.toFixed(1)}–{s.last.toFixed(1)}
        {series && <> · <a href={series.station_page} target="_blank" rel="noopener noreferrer">UNR station page</a></>}
      </div>
      {error && <div className="row-label" style={{ fontSize: '0.76em', color: 'var(--sb-red)' }}>{error}</div>}
      {!los && <div className="row-label" style={{ fontSize: '0.76em' }}>This cube has no line-of-sight vector, so GNSS can't be projected to compare.</div>}
      {los && scale === null && dataset && <div className="row-label" style={{ fontSize: '0.76em' }}>{dataset} is in {unit || 'unknown units'}, not metres, so it isn't compared in mm.</div>}
      {los && !series && !error && <div className="row-label">Loading the record…</div>}
      {series && noInsar && (
        <div className="row-label" style={{ fontSize: '0.74em' }}>No InSAR at this station (outside the cube, or masked): its LOS record alone.</div>
      )}
      {gnss && (insarRel || noInsar) && (
        <div style={{ height: 210 }}>
          <Line
            data={{ datasets: [
              { label: `GNSS ${s.id} (LOS)`, data: gnss.map(p => ({ x: Date.parse(p.x), y: p.y * u.factor })), borderColor: '#e11d48', backgroundColor: '#e11d48', pointRadius: 0, borderWidth: 1, order: 1 },
              ...(insarRel ? [{ label: `InSAR ${dataset}`, data: insarRel.map(p => ({ x: Date.parse(p.x), y: p.y * u.factor })), borderColor: '#5bc0be', backgroundColor: '#5bc0be', pointRadius: 2, borderWidth: 1.5 }] : []),
            ] }}
            options={{
              animation: false, maintainAspectRatio: false, parsing: false as never,
              scales: {
                x: { type: 'time', ticks: { color: text, maxTicksLimit: 5 }, grid: { color: grid } },
                y: { title: { display: true, text: `LOS (${u.label})`, color: text }, ticks: { color: text }, grid: { color: grid } },
              },
              plugins: { legend: { labels: { color: text, boxWidth: 10, font: { size: 10 } } } },
            }}
          />
        </div>
      )}
      {gnss && insarRel && (
        <div className="row-label" style={{ fontSize: '0.7em' }}>
          {isReference
            ? `InSAR is referenced to ${s.id}, so it is near 0 here; elsewhere it is motion relative to this station, whose own LOS motion is the red line.`
            : 'Both start at 0 on the first InSAR date. InSAR is relative to the reference point, GNSS to North America: compare slopes and shapes, not offsets.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="hist-btn" disabled={isReference} onClick={onUseAsReference}
          title="Move the InSAR reference point onto this station">
          {isReference ? 'Reference point is here' : 'Use as reference point'}
        </button>
        <button type="button" className="hist-btn" onClick={onAddPoint}>Add as time-series point</button>
      </div>
    </div>
  );
}
