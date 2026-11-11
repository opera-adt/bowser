import { useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { applyTheme, readThemeChoice, THEME_EVENT, type ThemeChoice } from '../../utils/theme';
import { SectionHeader } from './controls';
import ExportSection from './ExportSection';
import { saveFile } from '../../utils/saveFile';

const APPEARANCE: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const RECENT_KEY = 'bowser-recent-opens';
const FOLDER_KEY = 'bowser-search-folder';

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Open a GeoZarr cube by path or URL (POST /catalog/open), then reload the page on it. */
function OpenData() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [count, setCount] = useState(0);
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [folder, setFolder] = useState(() => { try { return localStorage.getItem(FOLDER_KEY) ?? ''; } catch { return ''; } });
  const [found, setFound] = useState<{ path: string; name: string; title: string | null }[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  // In the desktop app, pywebview offers a native folder chooser.
  const [hasChooser, setHasChooser] = useState(() => !!window.pywebview?.api?.pick_folder);
  useEffect(() => {
    const ready = () => setHasChooser(!!window.pywebview?.api?.pick_folder);
    window.addEventListener('pywebviewready', ready);
    return () => window.removeEventListener('pywebviewready', ready);
  }, []);

  useEffect(() => {
    fetch('/catalog').then(r => r.json())
      .then(c => { setAllowed(!!c.allow_open); setCount(c.datasets?.length ?? 0); })
      .catch(() => setAllowed(false));
  }, []);

  const open = async (target: string) => {
    const u = target.trim();
    if (!u) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/catalog/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: u }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify([u, ...recent.filter(r => r !== u)].slice(0, 5))); } catch { /* not kept */ }
      setRecent(readRecent());
      window.location.href = `/?dataset=${encodeURIComponent(body.id)}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  /** List the cubes under a folder on this computer (POST /catalog/scan). */
  const search = async (picked?: string) => {
    const dir = (picked ?? folder).trim();
    if (!dir) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch('/catalog/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      setFound(body.cubes);
      setTruncated(body.truncated);
      try { localStorage.setItem(FOLDER_KEY, dir); } catch { /* not kept */ }
    } catch (err) {
      setError((err as Error).message);
      setFound(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="sidebar-section">
      <SectionHeader label="Open data" />
      {allowed === false ? (
        <div className="row-label" style={{ fontSize: '0.76em' }}>
          Opening data from the page is off on this server. Run <code>bowser run</code> on your own computer to open local cubes.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4 }}>
            <input className="sidebar-input" style={{ flex: 1, minWidth: 0, textAlign: 'left' }} value={uri} disabled={busy || allowed === null}
              placeholder="/path/to/cube.zarr or s3://… or https://…" aria-label="GeoZarr path or URL"
              onChange={e => setUri(e.target.value)} onKeyDown={e => e.key === 'Enter' && open(uri)} />
            <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={busy || !uri.trim()} onClick={() => open(uri)}>
              {busy ? 'Opening…' : 'Open'}
            </button>
          </div>
          <div className="minmax-label">Search a folder for cubes</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <input className="sidebar-input" style={{ flex: 1, minWidth: 0, textAlign: 'left' }} value={folder} disabled={searching || allowed === null}
              placeholder="/path/to/folder" aria-label="Folder to search"
              onChange={e => setFolder(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} />
            {hasChooser && (
              <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={searching} title="Choose a folder on this computer"
                onClick={async () => { const picked = await window.pywebview!.api.pick_folder(); if (picked) { setFolder(picked); void search(picked); } }}>
                Choose…
              </button>
            )}
            <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={searching || !folder.trim()} onClick={() => search()}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {found && found.length === 0 && <div className="row-label" style={{ fontSize: '0.74em' }}>No .zarr cubes in this folder (4 levels down).</div>}
          {found && found.length > 0 && (
            <div className="found-cubes">
              {found.map(c => (
                <div key={c.path} className="found-cube" title={c.path}>
                  <div className="found-cube-text">
                    <span className="found-cube-name">{c.title ?? c.name}</span>
                    <span className="row-label">{c.path.startsWith(folder.trim()) ? c.path.slice(folder.trim().length).replace(/^\//, '') : c.path}</span>
                  </div>
                  <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={busy} onClick={() => open(c.path)}>Open</button>
                </div>
              ))}
              {truncated && <div className="row-label" style={{ fontSize: '0.72em' }}>Showing the first {found.length}; search a smaller folder for the rest.</div>}
            </div>
          )}
          {error && <div className="row-label" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{error}</div>}
          {recent.length > 0 && (
            <>
              <div className="minmax-label">Recent</div>
              {recent.map(r => (
                <button key={r} type="button" className="hist-btn" style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={r} disabled={busy} onClick={() => open(r)}>{r}</button>
              ))}
            </>
          )}
          <div className="row-label" style={{ fontSize: '0.72em' }}>A GeoZarr cube on this computer, or an s3:// or https:// URL. The page reloads on it.</div>
        </>
      )}
      {(count > 0 || allowed) && <a href="/picker" style={{ fontSize: '0.78em' }}>Browse all datasets{count ? ` (${count})` : ''}</a>}
    </div>
  );
}

export default function ProjectTab() {
  const { state, dispatch } = useAppContext();
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);
  useEffect(() => {
    const follow = (e: Event) => setTheme((e as CustomEvent<ThemeChoice>).detail);
    window.addEventListener(THEME_EVENT, follow);
    return () => window.removeEventListener(THEME_EVENT, follow);
  }, []);

  // ── Project save/load: persist points, reference, annotations and masks. ──
  const PROJECT_KEYS = [
    'currentDataset', 'currentTimeIndex', 'colormap', 'vmin', 'vmax',
    'opacity', 'dataMode',
    'refMarkerPosition', 'refEnabled', 'refMarkerVisible', 'refTimeIndex',
    'timeSeriesPoints', 'annotations', 'layerMasks', 'customMaskPath', 'overlays', 'units',
    'chartAreas', 'areaBand',
    // The chart's model: whether it and its residuals are shown, and its terms.
    'showTrends', 'showResiduals', 'fitSettings',
  ] as const;
  const saveProject = useCallback(() => {
    const project: Record<string, unknown> = { bowser_project: 1, saved: new Date().toISOString() };
    PROJECT_KEYS.forEach(k => {
      // Drop cached time-series/trend values from points — they refetch on load.
      project[k] = k === 'timeSeriesPoints'
        ? state.timeSeriesPoints.map(({ data, trendData, ...rest }) => rest)
        : (state as any)[k];
    });
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    void saveFile(blob, `bowser-project-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.json`);
  }, [state]);
  // Validate each field before merging it into state. LOAD_PROJECT spreads the
  // payload straight onto state, so a hand-edited/corrupt file with a wrong type
  // (e.g. timeSeriesPoints not an array, refMarkerPosition not a pair) would
  // crash rendering — a React render throw blanks the whole app. Drop any field
  // that doesn't match its expected shape rather than trusting the file.
  const loadProject = useCallback(async (file: File) => {
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const isStr = (v: unknown): v is string => typeof v === 'string';
    const isBool = (v: unknown) => typeof v === 'boolean';
    const isPair = (v: unknown) =>
      Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
    const obj = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object';
    const arrayOf = (pred: (x: unknown) => boolean) => (v: unknown) =>
      Array.isArray(v) && v.every(pred);
    const isPoint = (v: unknown) =>
      obj(v) && isStr(v.id) && isPair(v.position) && isStr(v.color) && isBool(v.visible);
    // An area keeps its name, colour, geometry and style (Style button); its statistics refetch.
    const isArea = (v: unknown) =>
      obj(v) && isStr(v.id) && isStr(v.name) && isStr(v.color) && isBool(v.visible)
      && obj(v.geometry) && ['Polygon', 'MultiPolygon'].includes(v.geometry.type as string) && Array.isArray(v.geometry.coordinates);
    const isAnnotation = (v: unknown) =>
      obj(v) && isStr(v.id) && isPair(v.position) && isStr(v.text);
    const isMask = (v: unknown) =>
      obj(v) && isStr(v.id) && isStr(v.dataset) && isNum(v.threshold);
    const isOverlay = (v: unknown) =>
      obj(v) && isStr(v.id) && isStr(v.name) && isBool(v.visible) && isNum(v.opacity)
      && ['geotiff', 'wms', 'wmts', 'vector', 'context', 'pmtiles'].includes(v.type as string)
      && (v.type !== 'vector' || (obj(v.data) && Array.isArray(v.data.features)));
    const validators: Record<(typeof PROJECT_KEYS)[number], (v: unknown) => boolean> = {
      currentDataset: isStr,
      currentTimeIndex: (v) => isNum(v) && v >= 0,
      colormap: isStr,
      vmin: isNum,
      vmax: isNum,
      opacity: (v) => isNum(v) && v >= 0 && v <= 1,
      dataMode: isStr,
      refMarkerPosition: isPair,
      refEnabled: isBool,
      refMarkerVisible: isBool,
      refTimeIndex: (v) => obj(v) && !Array.isArray(v) && Object.values(v).every(i => Number.isInteger(i) && (i as number) >= 0),
      timeSeriesPoints: arrayOf(isPoint),
      annotations: arrayOf(isAnnotation),
      layerMasks: arrayOf(isMask),
      customMaskPath: (v) => v === null || isStr(v),
      overlays: arrayOf(isOverlay),
      units: (v) => v === 'metric' || v === 'imperial',
      chartAreas: arrayOf(isArea),
      areaBand: (v) => v === 'std' || v === 'pct',
      showTrends: isBool,
      showResiduals: isBool,
      fitSettings: (v) => obj(v) && [0, 1, 2, 3].includes(v.polyOrder as number) && isBool(v.annual) && isBool(v.semiannual)
        && isBool(v.rejectOutliers) && arrayOf(isStr)(v.steps) && arrayOf(isStr)(v.breaks),
    };
    try {
      const p = JSON.parse(await file.text());
      if (!obj(p)) throw new Error('not a bowser project file');
      const payload: Record<string, unknown> = {};
      const skipped: string[] = [];
      PROJECT_KEYS.forEach(k => {
        if (!(k in p)) return;
        if (validators[k](p[k])) payload[k] = p[k];
        else skipped.push(k);
      });
      if (Object.keys(payload).length === 0) {
        throw new Error('no valid project fields found');
      }
      // Switching currentDataset fires the dataset-change effect, which restores
      // colormap/vmin/vmax from localStorage and would otherwise clobber the
      // project's values. Seed localStorage first so it reads back what we load.
      const ds = payload.currentDataset;
      if (typeof ds === 'string') {
        if ('colormap' in payload) localStorage.setItem(`${ds}-colormap_name`, String(payload.colormap));
        if ('vmin' in payload) localStorage.setItem(`${ds}-vmin`, String(payload.vmin));
        if ('vmax' in payload) localStorage.setItem(`${ds}-vmax`, String(payload.vmax));
      }
      dispatch({ type: 'LOAD_PROJECT', payload });
      if (skipped.length) alert(`Loaded project; ignored malformed fields: ${skipped.join(', ')}`);
    } catch (err) {
      alert(`Could not load project: ${(err as Error).message}`);
    }
  }, [dispatch]);

  return (
    <>
      <div className="sidebar-section">
        <SectionHeader label="Project" />
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="hist-btn" style={{ flex: 1 }} onClick={saveProject}
            title="Save points, reference, annotations, masks & overlays to a file">
            <i className="fa-solid fa-download" style={{ marginRight: 5 }}></i>Save
          </button>
          <label className="hist-btn" style={{ flex: 1, cursor: 'pointer', textAlign: 'center' }}
            title="Load a saved project">
            <i className="fa-solid fa-upload" style={{ marginRight: 5 }}></i>Load
            <input type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) loadProject(f); e.currentTarget.value = ''; }} />
          </label>
        </div>
        <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginTop: 4, textAlign: 'center' }}>
          points · reference · annotations · masks · overlays · model
        </div>
      </div>
      <OpenData />
      <ExportSection />
      <div className="sidebar-section">
        <SectionHeader label="Appearance" />
        <div className="toggle-row" style={{ gap: 8 }}>
          <span className="row-label">Ground motion in</span>
          <div className="segmented" role="radiogroup" aria-label="Units" style={{ flex: 1 }}>
            {(['metric', 'imperial'] as const).map(u => (
              <button key={u} type="button" role="radio" aria-checked={state.units === u}
                className={`segmented-item${state.units === u ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_UNITS', payload: u })}>
                {u === 'metric' ? 'Metric (m, mm/yr)' : 'Imperial (in, in/yr)'}
              </button>
            ))}
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Appearance">
          {APPEARANCE.map(({ value, label }) => (
            <button key={value} type="button" role="radio" aria-checked={theme === value}
              className={`segmented-item${theme === value ? ' active' : ''}`}
              onClick={() => { setTheme(value); applyTheme(value); }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
