/**
 * Open another dataset without leaving the app: the rail's Open button (and Ctrl/Cmd+O, and the
 * desktop app's File menu) lists the catalog's datasets, links to Project › Open data for a cube
 * by path or folder search, and goes back to the dataset picker. Switching reloads the page, so
 * when there is work on it (points, areas, annotations, masks, overlays) it offers to save the
 * project first.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppDispatch, useGetAppState } from '../context/AppContext';
import { nav, OPEN_EVENT } from '../utils/openDataset';
import { hasProjectWork, saveProjectFile } from '../utils/project';

type Entry = { id: string; name: string; description?: string | null };
type Catalog = { datasets: Entry[]; allow_open: boolean };

const currentId = () => new URLSearchParams(window.location.search).get('dataset');

export default function OpenDataset({ icon }: { icon: JSX.Element }) {
  const dispatch = useAppDispatch();
  const getState = useGetAppState();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where the page would go, while asking whether to save first.
  const [pending, setPending] = useState<{ href: string; label: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 70, bottom: 12 });

  const show = useCallback(() => {
    setOpen(true);
    setPending(null);
    setError(null);
    fetch('/catalog').then(r => r.json())
      .then((c: Catalog) => setCatalog({ datasets: c.datasets ?? [], allow_open: !!c.allow_open }))
      .catch(() => setError('Could not list the datasets.'));
  }, []);
  const close = useCallback(() => { setOpen(false); setPending(null); }, []);

  /** Go to ``href`` (a dataset or the picker), asking to save first when there is work on the page. */
  const go = useCallback((href: string, label: string) => {
    if (hasProjectWork(getState())) { setOpen(true); setPending({ href, label }); return; }
    nav.go(href);
  }, [getState]);

  // Next to the button, rising from its foot: the rail's lower end is where it sits.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPos({ left: r.right + 6, bottom: Math.max(8, window.innerHeight - r.bottom) });
  }, [open]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);

  // Ctrl/Cmd+O, and the desktop app's File menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); show(); }
    };
    const onMenu = (e: Event) => {
      e.preventDefault();
      if ((e as CustomEvent<string>).detail === 'picker') go('/picker', 'the dataset picker');
      else show();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onMenu);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onMenu); };
  }, [show, go]);

  const save = async () => {
    if (!pending) return;
    setSaving(true);
    const saved = await saveProjectFile(getState()).catch(() => false);
    setSaving(false);
    if (saved) nav.go(pending.href);
  };

  const openData = () => {
    close();
    dispatch({ type: 'SET_PANEL_TAB', payload: 'project' });
    // After the tab shows: bring Project › Open data into view and put the cursor in its path box.
    setTimeout(() => {
      const section = document.getElementById('open-data');
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLInputElement>('input')?.focus();
    }, 0);
  };

  // Only where there is somewhere else to go: a catalog, or a server that may open cubes
  // (as Project › Open data's "Browse all datasets"). A single-cube server has neither.
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    fetch('/catalog').then(r => r.json())
      .then((c: Catalog) => setAvailable((c.datasets?.length ?? 0) > 0 || !!c.allow_open)).catch(() => setAvailable(false));
  }, []);
  if (!available) return null;

  const here = currentId();
  return (
    <>
      {open && (
        <div ref={box} className="basemap-popover open-dataset-popover" role="dialog" aria-label="Open another dataset"
          style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, top: 'auto', right: 'auto' }}>
          {pending ? (
            <>
              <div className="open-dataset-heading">Save the project first?</div>
              <div className="open-dataset-note">
                Opening {pending.label} reloads the page. Points, areas, annotations, masks and overlays are kept only in a saved project.
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" className="hist-btn" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save and open'}</button>
                <button type="button" className="hist-btn" disabled={saving} onClick={() => nav.go(pending.href)}>Don't save</button>
                <button type="button" className="hist-btn" disabled={saving} onClick={() => setPending(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="open-dataset-heading">Datasets</div>
              {error && <div className="open-dataset-note" style={{ color: 'var(--sb-red)' }}>{error}</div>}
              {!catalog && !error && <div className="open-dataset-note">Loading…</div>}
              {catalog && catalog.datasets.length === 0 && <div className="open-dataset-note">No datasets in the catalog yet.</div>}
              {catalog && catalog.datasets.length > 0 && (
                <div className="open-dataset-list" role="listbox" aria-label="Datasets">
                  {catalog.datasets.map(d => (
                    <button key={d.id} type="button" role="option" aria-selected={d.id === here}
                      className={`basemap-option${d.id === here ? ' active' : ''}`} title={d.description ?? d.name}
                      onClick={() => { if (d.id === here) close(); else go(`/?dataset=${encodeURIComponent(d.id)}`, d.name); }}>
                      {d.name}{d.id === here ? ' (open)' : ''}
                    </button>
                  ))}
                </div>
              )}
              <div className="open-dataset-sep" />
              {catalog?.allow_open && (
                <button type="button" className="basemap-option" onClick={openData}>Open a cube or search a folder…</button>
              )}
              <button type="button" className="basemap-option" onClick={() => go('/picker', 'the dataset picker')}>Show the dataset picker</button>
            </>
          )}
        </div>
      )}
      {/* After the popover: the rail keeps Open next to the theme button below it. */}
      <button ref={button} type="button" className="panel-rail-btn panel-open-btn" aria-haspopup="dialog" aria-expanded={open}
        title="Open another dataset (Ctrl+O)" onClick={() => (open ? close() : show())}>
        {icon}
        <span className="panel-rail-label">Open</span>
      </button>
    </>
  );
}
