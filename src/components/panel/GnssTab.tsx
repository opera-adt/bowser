import { useEffect, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { useAppContext } from '../../context/AppContext';
import { useApi } from '../../hooks/useApi';
import { refDragEnd } from '../../map/interactions';
import { chartLayerFor } from '../../utils/chartLayers';
import {
  GNSS_CUSTOM_LAYER_ID, GNSS_LAYER_ID, describeLoad, distanceKm, fetchCustomStations, gnssKey, gnssLosSeries, gnssSeriesUrl, loadGnssFile,
  losVector, mmPerUnit, rateSource, removeCustomStation, toLos, typicalLos, type CustomGnssStation, type GnssSeries, type GnssStation,
} from '../../map/gnss';
import { customGnssOverlay, gnssOverlay } from '../../map/contextServices';
import { SectionHeader, Switch } from './controls';
import { displayUnit, type DisplayUnit } from '../../utils/units';

/** How a GNSS file should look, with example files to copy. */
/** The source of the open-source stations. */
const UNR_SITE = 'https://geodesy.unr.edu/';
const GNSS_FORMAT_DOCS = 'https://github.com/opera-adt/bowser/blob/main/docs/gnss.md#the-file-format';

/** Half the side (degrees) of the view the zoom button opens on a station: about 2 km. */
const ZOOM_DEG = 0.01;

/** What a GNSS file may be: CSV or text tables, and NGL's .tenv3. */
const GNSS_ACCEPT = '.csv,.tsv,.txt,.tenv3,.pos,.dat';
type Units = 'auto' | 'm' | 'mm' | 'cm';
/** Stations from files already put on the map once: opening the tab shows only new ones. */
const shownCustom = new Set<string>();

/** A GNSS value (mm) in the chosen units, with two decimals for inches. */
const show = (u: DisplayUnit, mm: number) => (mm * u.factor).toFixed(u.label === 'in' ? 2 : 1);

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * UNR GNSS stations in the view (MIDAS velocities), stations from the user's own files
 * (POST /gnss/custom, kept for the server session), and one station's record against InSAR.
 */
export default function GnssTab() {
  const { state, dispatch } = useAppContext();
  const { fetchMultiPointTimeSeries, fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const [stations, setStations] = useState<GnssStation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GnssStation | null>(null);
  // Stations from the user's files.
  const [custom, setCustom] = useState<CustomGnssStation[]>([]);
  const [units, setUnits] = useState<Units>('auto');
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [allowOpen, setAllowOpen] = useState(false);
  const [path, setPath] = useState('');
  // Bumped on every load, so a reloaded station's record is read again.
  const [loads, setLoads] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const customOnMap = state.overlays.some(o => o.id === GNSS_CUSTOM_LAYER_ID);

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
    dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_LAYER_ID });
    dispatch({ type: 'ADD_OVERLAY', payload: gnssOverlay(list) });
  };

  const showCustom = (list: CustomGnssStation[]) => {
    list.forEach(s => shownCustom.add(s.id));
    dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_CUSTOM_LAYER_ID });
    if (list.length) dispatch({ type: 'ADD_OVERLAY', payload: customGnssOverlay(list) });
  };

  // Stations already loaded (here, or by the Assistant or an MCP client): new ones go on the map.
  useEffect(() => {
    fetchCustomStations().then(list => {
      setCustom(list);
      if (list.some(s => !shownCustom.has(s.id))) showCustom(list);
    }).catch(() => { /* an older server: no files */ });
    fetch('/catalog').then(r => r.json()).then(c => setAllowOpen(!!c.allow_open)).catch(() => setAllowOpen(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  /** Read files (picked here) or a server path; then list and show every loaded station. */
  const loadFiles = async (sources: ({ text: string; name: string } | { path: string })[]) => {
    setFileBusy(true);
    setFileError(null);
    const notes: string[] = [];
    const errors: string[] = [];
    let first: CustomGnssStation | null = null;
    for (const src of sources) {
      const label = 'path' in src ? src.path : src.name;
      try {
        const r = await loadGnssFile(src, units);
        notes.push(describeLoad(r), ...new Set(r.stations.flatMap(s => s.warnings)));
        first = first ?? r.stations[0] ?? null;
      } catch (err) {
        errors.push(`${label}: ${(err as Error).message}`);
      }
    }
    try {
      const list = await fetchCustomStations();
      setCustom(list);
      showCustom(list);
    } catch (err) {
      errors.push((err as Error).message);
    }
    if (first) setSelected(first);
    setLoads(n => n + 1);
    setFileNotes(notes);
    setFileError(errors.length ? errors.join(' · ') : null);
    setFileBusy(false);
  };

  const pickFiles = async (files: File[]) => {
    const read = await Promise.all(files.map(async f => ({ text: await f.text(), name: f.name })));
    await loadFiles(read);
  };

  const remove = async (s: CustomGnssStation) => {
    try {
      await removeCustomStation(s.id);
    } catch { /* already gone (server restarted): drop it here too */ }
    const list = custom.filter(c => c.id !== s.id);
    setCustom(list);
    if (customOnMap) showCustom(list);
    if (selected && gnssKey(selected) === gnssKey(s)) setSelected(null);
  };

  const zoomTo = (s: GnssStation) => {
    setSelected(s);
    dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [s.lat - ZOOM_DEG, s.lon - ZOOM_DEG, s.lat + ZOOM_DEG, s.lon + ZOOM_DEG] });
  };

  const [cx, cy] = state.viewBounds
    ? [(state.viewBounds[1] + state.viewBounds[3]) / 2, (state.viewBounds[0] + state.viewBounds[2]) / 2]
    : [0, 0];

  return (
    <>
      <div className="sidebar-section">
        <SectionHeader label="Open-source GNSS stations" />
        <div className="row-label" style={{ fontSize: '0.7em' }}>
          Source: UNR, the <a href={UNR_SITE} target="_blank" rel="noopener noreferrer">Nevada Geodetic Laboratory</a> (University of Nevada, Reno).
        </div>
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
                <button type="button" role="option" aria-selected={!!selected && gnssKey(selected) === gnssKey(s)}
                  className="gnss-item" onClick={() => setSelected(s)}>
                  <strong>{s.id}</strong>
                  <span>{los ? `${show(u, toLos(los, s.ve_mm_yr, s.vn_mm_yr, s.vu_mm_yr))} LOS` : `${show(u, s.vu_mm_yr)} up`}</span>
                  <span className="row-label">{distanceKm(cx, cy, s.lon, s.lat).toFixed(0)} km</span>
                </button>
                <button type="button" className="ov-icon-btn" title={`Zoom to ${s.id} and select it`} aria-label={`Zoom to ${s.id}`}
                  onClick={() => zoomTo(s)}>
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
          Velocities in {u.label}/yr (UNR MIDAS, North America fixed); LOS is towards the satellite. Nearest the map centre first.
        </div>
      </div>
      <div className="sidebar-section">
        <SectionHeader label="Load local GNSS file" />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="hist-btn" style={{ flex: 1 }} disabled={fileBusy}
            title="CSV (date, east, north, up, and the station's lon/lat) or NGL .tenv3; one station per file, or a station column"
            onClick={() => fileInput.current?.click()}>
            {fileBusy ? 'Reading…' : 'Load GNSS files…'}
          </button>
          <select className="sidebar-select" style={{ width: 'auto', fontSize: '0.76em' }} aria-label="Units of the files"
            title="Units of east, north and up: Auto reads them from the header or a '# units:' line" value={units}
            onChange={e => setUnits(e.target.value as Units)}>
            <option value="auto">Units: auto</option>
            <option value="m">m</option>
            <option value="mm">mm</option>
            <option value="cm">cm</option>
          </select>
          <input ref={fileInput} type="file" multiple accept={GNSS_ACCEPT} style={{ display: 'none' }} aria-label="GNSS files"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.currentTarget.value = ''; if (files.length) void pickFiles(files); }} />
        </div>
        <div className="row-label" style={{ fontSize: '0.7em' }}>
          <a href={GNSS_FORMAT_DOCS} target="_blank" rel="noopener noreferrer">File format and examples</a>
        </div>
        {allowOpen && (
          <div style={{ display: 'flex', gap: 4 }}>
            <input className="sidebar-input" style={{ flex: 1, minWidth: 0, textAlign: 'left' }} value={path} disabled={fileBusy}
              placeholder="/path/to/station.csv" aria-label="GNSS file path on the server"
              onChange={e => setPath(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && path.trim()) { void loadFiles([{ path: path.trim() }]); setPath(''); } }} />
            <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={fileBusy || !path.trim()}
              onClick={() => { void loadFiles([{ path: path.trim() }]); setPath(''); }}>
              Load
            </button>
          </div>
        )}
        {fileNotes.map((n, i) => <div key={i} className="row-label" style={{ fontSize: '0.72em' }}>{n}</div>)}
        {fileError && <div className="row-label" role="alert" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{fileError}</div>}
        {custom.length > 0 && (
          <>
            <div className="toggle-row">
              <span style={{ fontSize: '0.82em' }}>Show them on the map</span>
              <Switch checked={customOnMap} label="Show your GNSS stations on the map" onChange={() => {
                if (customOnMap) dispatch({ type: 'REMOVE_OVERLAY', payload: GNSS_CUSTOM_LAYER_ID });
                else showCustom(custom);
              }} />
            </div>
            <div className="gnss-list" role="listbox" aria-label="Local GNSS stations">
              {custom.map(s => (
                <div key={s.id} className="gnss-row">
                  <button type="button" role="option" aria-selected={!!selected && gnssKey(selected) === gnssKey(s)}
                    className="gnss-item" title={`${s.name} · ${s.source} · ${s.rows} rows${s.skipped ? `, ${s.skipped} skipped` : ''}`}
                    onClick={() => setSelected(s)}>
                    <strong>{s.id}</strong>
                    <span>{los ? `${show(u, toLos(los, s.ve_mm_yr, s.vn_mm_yr, s.vu_mm_yr))} LOS` : `${show(u, s.vu_mm_yr)} up`}</span>
                    <span className="row-label">{s.rows} rows</span>
                  </button>
                  <button type="button" className="ov-icon-btn" title={`Zoom to ${s.id} and select it`} aria-label={`Zoom to ${s.id}`}
                    onClick={() => zoomTo(s)}>
                    <i className="fa-solid fa-magnifying-glass-plus"></i>
                  </button>
                  <button type="button" className="ov-icon-btn" title={`Remove ${s.id}`} aria-label={`Remove ${s.id}`}
                    onClick={() => void remove(s)}>
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="row-label" style={{ fontSize: '0.7em' }}>
          A CSV per station: date (ISO, decimal year or MJD), east, north and up in m or mm, and the station's lon/lat as
          columns or <code>#&nbsp;lon:</code> / <code>#&nbsp;lat:</code> lines; NGL .tenv3 too. Rates are a straight-line fit; kept until the server stops.
        </div>
      </div>
      {selected && (
        <StationCompare u={u} key={`${gnssKey(selected)}:${selected.custom ? loads : ''}:${state.refMarkerPosition.join(',')}`} station={selected} dataset={ds} los={los}
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
        const res = await fetch(gnssSeriesUrl(s));
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
  }, [s.id, s.custom]);  // eslint-disable-line react-hooks/exhaustive-deps

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
        {u.label}/yr ({rateSource(s)}), {s.first.toFixed(1)}–{s.last.toFixed(1)}
        {series?.station_page && <> · <a href={series.station_page} target="_blank" rel="noopener noreferrer">UNR station page</a></>}
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
            : `Both start at 0 on the first InSAR date. InSAR is relative to the reference point, GNSS to ${s.custom ? "your file's frame" : 'North America'}: compare slopes and shapes, not offsets.`}
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
