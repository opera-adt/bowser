/**
 * Overlays › Layers › Load file: a raster or vector file on the server, by its path or
 * picked in a small folder browser (GET /files), when the server lets the page open files
 * (BOWSER_ALLOW_OPEN, as Project › Open data). Each is added with POST /data and converted
 * like an upload. Pinned by AddData.test.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useAddServerData } from '../../hooks/useAddFiles';
import { HttpError, listFolder, startData, type FolderEntry, type FolderListing } from '../../map/addData';
import { formatBytes } from './ExportSection';

/** Where Browse opens next time: the last folder listed. */
export const LAST_DIR_KEY = 'bowser.loadFile.dir';
/** "Add all" asks first above this many files, and adds at most ADD_ALL_MAX. */
export const ADD_ALL_CONFIRM = 10;
export const ADD_ALL_MAX = 50;

type Bounds = [number, number, number, number];

const readLastDir = (): string | null => {
  try { return localStorage.getItem(LAST_DIR_KEY); } catch { return null; }
};
const keepLastDir = (dir: string) => {
  try { localStorage.setItem(LAST_DIR_KEY, dir); } catch { /* not kept */ }
};
const datasetParam = () => new URLSearchParams(window.location.search).get('dataset');
const entryIcon = (e: FolderEntry) => (e.type === 'dir' ? 'fa-folder' : e.kind === 'raster' ? 'fa-image' : 'fa-draw-polygon');

export default function LoadFile() {
  const { dispatch } = useAppContext();
  const addServerData = useAddServerData();
  const [allowed, setAllowed] = useState(false);
  const [canBrowse, setCanBrowse] = useState(true);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The folder browser: what is listed, the editable folder path, hidden files shown.
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [dirInput, setDirInput] = useState('');
  const [hidden, setHidden] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // A long folder path shows its end, the folder itself.
  const dirBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dirBox.current) dirBox.current.scrollLeft = dirBox.current.scrollWidth;
  }, [listing?.dir]);
  useEffect(() => {
    fetch('/catalog').then(r => r.json()).then(c => setAllowed(!!c.allow_open)).catch(() => setAllowed(false));
  }, []);
  if (!allowed) return null;

  const fit = (b: Bounds | null) => {
    if (!b) return;
    const [w, s, e, n] = b;
    dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [s, w, n, e] });
  };

  /**
   * Open the browser on ``dir`` (or the server's default folder); true when it is a folder.
   * ``quiet``: only a probe (is this path a folder?), so a failure is not shown.
   */
  const browse = async (dir?: string, { showHidden = hidden, quiet = false } = {}): Promise<boolean> => {
    setListingBusy(true);
    if (!quiet) setBrowseError(null);
    try {
      const out = await listFolder(dir, { hidden: showHidden, dataset: datasetParam() });
      setListing(out);
      setDirInput(out.dir);
      keepLastDir(out.dir);
      return true;
    } catch (err) {
      // An older server, or one that cannot add server files: no Browse.
      if (err instanceof HttpError && (err.status === 404 || err.status === 501)) setCanBrowse(false);
      else if (!quiet) setBrowseError((err as Error).message);
      return false;
    } finally {
      setListingBusy(false);
    }
  };

  /** Browse: the last folder used, else the cube's folder, else home (the server's default). */
  const startBrowsing = async () => {
    const last = readLastDir();
    if (last && await browse(last)) return;
    await browse();
  };

  const add = async (raw: string = path) => {
    const p = raw.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // A folder (typed, pasted or dropped): open the browser there instead.
      if (canBrowse && p.endsWith('/') && await browse(p)) { setPath(''); return; }
      const o = addServerData(await startData(p));
      fit(o.bounds ?? null);
      setPath('');
    } catch (err) {
      if (canBrowse && await browse(p, { quiet: true })) {
        setBrowseError(null);
        setPath('');
        return;
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const files = listing?.entries.filter(e => e.type === 'file') ?? [];
  const addAll = async () => {
    if (!files.length) return;
    const take = files.slice(0, ADD_ALL_MAX);
    const what = files.length > ADD_ALL_MAX
      ? `the first ${ADD_ALL_MAX} of the ${files.length} files`
      : `all ${files.length} files`;
    if (files.length > ADD_ALL_CONFIRM && !confirm(`Add ${what} in this folder as layers?`)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const problems: string[] = [];
    let bounds: Bounds | null = null;
    let added = 0;
    for (const f of take) {
      try {
        const o = addServerData(await startData(f.path));
        added += 1;
        const b = o.bounds as Bounds | undefined;
        if (b) bounds = bounds ? [Math.min(bounds[0], b[0]), Math.min(bounds[1], b[1]), Math.max(bounds[2], b[2]), Math.max(bounds[3], b[3])] : b;
      } catch (err) {
        problems.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    fit(bounds);
    setBusy(false);
    const capped = files.length > ADD_ALL_MAX
      ? ` Added the first ${ADD_ALL_MAX} of ${files.length}; add the rest one by one or from a smaller folder.` : '';
    setNote(`Added ${added} ${added === 1 ? 'layer' : 'layers'}.${capped}`);
    if (problems.length) setError(`Could not add ${problems.length === 1 ? problems[0] : `${problems.length} files. ${problems.join(' · ')}`}`);
  };

  const open = (e: FolderEntry) => {
    if (e.type === 'dir') void browse(e.path);
    else setPath(e.path);
  };

  return (
    <>
      <div className="minmax-label">Load file</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input className="sidebar-input" style={{ flex: 1, minWidth: 0, textAlign: 'left' }} value={path} disabled={busy}
          placeholder="/path/to/dem.tif or a folder" aria-label="File path on the server"
          onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
        {canBrowse && (
          <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={busy || listingBusy}
            title="Choose a file in a folder on the server" aria-expanded={!!listing}
            onClick={() => (listing ? setListing(null) : void startBrowsing())}>
            Browse…
          </button>
        )}
        <button type="button" className="hist-btn" style={{ flex: 'none' }} disabled={busy || !path.trim()} onClick={() => void add()}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {listing && (
        <div className="load-file-browser" aria-label="Folder on the server">
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <button type="button" className="ov-icon-btn" title="Up" aria-label="Up" disabled={!listing.parent || listingBusy}
              onClick={() => listing.parent && void browse(listing.parent)}>
              <i className="fa-solid fa-arrow-up"></i>
            </button>
            <input ref={dirBox} className="sidebar-input" style={{ flex: 1, minWidth: 0, textAlign: 'left' }} value={dirInput}
              aria-label="Folder path" title={listing.dir}
              onChange={e => setDirInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void browse(dirInput.trim()); }} />
            <button type="button" className={`ov-icon-btn${hidden ? ' on' : ''}`} aria-pressed={hidden}
              title={hidden ? 'Hide hidden files' : 'Show hidden files'} aria-label="Show hidden files"
              onClick={() => { const next = !hidden; setHidden(next); void browse(listing.dir, { showHidden: next }); }}>
              <i className={`fa-solid ${hidden ? 'fa-eye' : 'fa-eye-slash'}`}></i>
            </button>
            <button type="button" className="ov-icon-btn" title="Close" aria-label="Close the folder" onClick={() => setListing(null)}>
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div className="found-cubes" role="listbox" aria-label="Files and folders">
            {listing.entries.map(e => (
              <div key={e.path} role="option" aria-selected={e.type === 'file' && path === e.path} tabIndex={0}
                className={`found-cube load-file-entry${e.type === 'file' && path === e.path ? ' selected' : ''}`} title={e.path}
                onClick={() => open(e)} onDoubleClick={() => { if (e.type === 'file') void add(e.path); }}
                onKeyDown={k => { if (k.key === 'Enter') { if (e.type === 'file') void add(e.path); else open(e); } }}>
                <i className={`fa-solid ${entryIcon(e)}`} style={{ flex: 'none', width: 14, color: 'var(--sb-muted)', fontSize: '0.8em' }}></i>
                <span className="found-cube-text"><span>{e.name}</span></span>
                {e.size !== null && <span className="row-label" style={{ flex: 'none', fontSize: '0.72em' }}>{formatBytes(e.size)}</span>}
              </div>
            ))}
            {listing.entries.length === 0 && (
              <div className="row-label" style={{ fontSize: '0.74em' }}>No folders or files Bowser can add here.</div>
            )}
          </div>
          {(listing.truncated || listing.skipped > 0) && (
            <div className="row-label" style={{ fontSize: '0.72em' }}>
              {listing.truncated && `Showing the first ${listing.entries.length}. `}
              {listing.skipped > 0 && `${listing.skipped} could not be read.`}
            </div>
          )}
          {files.length > 0 && (
            <button type="button" className="hist-btn" disabled={busy} onClick={() => void addAll()}>
              Add all supported files in this folder ({files.length})
            </button>
          )}
        </div>
      )}
      {browseError && <div className="row-label" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{browseError}</div>}
      {error && <div className="row-label" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{error}</div>}
      {note && <div className="row-label" style={{ fontSize: '0.74em' }}>{note}</div>}
      <div className="row-label" style={{ fontSize: '0.72em' }}>
        A GeoTIFF that is not cloud-optimized, or a large vector, is converted once in the background and cached.
      </div>
    </>
  );
}
