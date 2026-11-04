import { useEffect, useState } from 'react';
import { applyTheme, shownTheme, THEME_EVENT } from '../utils/theme';
import { useAppContext } from '../context/AppContext';
import MainTab from './panel/MainTab';
import OverlaysTab from './panel/OverlaysTab';
import ProjectTab from './panel/ProjectTab';
import GnssTab from './panel/GnssTab';
import operaEmblem from '../assets/opera-emblem.png';
import bowserMark from '../assets/bowser-mark.svg';

const svg = (body: JSX.Element) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
);

const TABS = [
  { id: 'main', label: 'Main', icon: svg(<><path d="M4 7h9M19 7h1M4 17h1M11 17h9" /><circle cx="16" cy="7" r="2.5" /><circle cx="8" cy="17" r="2.5" /></>) },
  { id: 'overlays', label: 'Overlays', icon: svg(<><path d="m12 3.5 8.5 5-8.5 5-8.5-5 8.5-5Z" /><path d="m3.5 12.5 8.5 5 8.5-5" /><path d="m3.5 16 8.5 5 8.5-5" /></>) },
  { id: 'gnss', label: 'GNSS', icon: svg(<><circle cx="12" cy="18" r="2" /><path d="M8.5 14.5a5 5 0 0 1 7 0M5.5 11.5a9.2 9.2 0 0 1 13 0M2.5 8.5a13.4 13.4 0 0 1 19 0" /></>) },
  { id: 'project', label: 'Project', icon: svg(<><path d="M6 3.5h8l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.500 19V5A1.5 1.5 0 0 1 6 3.5Z" /><path d="M14 3.5V8h4.500" /><path d="M8 13h7M8 16.500h7" /></>) },
] as const;

type TabId = (typeof TABS)[number]['id'];

const TAB_CONTENT: Record<TabId, () => JSX.Element> = {
  main: MainTab,
  overlays: OverlaysTab,
  gnss: GnssTab,
  project: ProjectTab,
};

export default function ControlPanel({ title, operaLogo }: { title: string; operaLogo: boolean }) {
  const { state, dispatch } = useAppContext();
  const [tab, setTab] = useState<TabId>('main');

  return (
    <div id="menu">
      <nav className="panel-rail" role="tablist" aria-orientation="vertical" aria-label="Panel">
        {operaLogo ? (
          <a className="panel-logo" href="https://www.jpl.nasa.gov/go/opera/" target="_blank" rel="noopener noreferrer"
            title="OPERA: Observational Products for End-Users from Remote Sensing Analysis">
            <img src={operaEmblem} alt="OPERA" />
          </a>
        ) : (
          <a className="panel-logo" href="https://github.com/opera-adt/bowser" target="_blank" rel="noopener noreferrer" title="Bowser">
            <img src={bowserMark} alt="Bowser" />
          </a>
        )}
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
            className="panel-rail-btn" onClick={() => setTab(t.id)}>
            {t.icon}
            <span className="panel-rail-label">{t.label}</span>
          </button>
        ))}
        <ThemeToggle />
      </nav>
      <div className="panel-body">
        {title && <div className="sidebar-title">{title}</div>}
        <div className="panel-scroll">
          {/* Every tab stays mounted: MainTab's effects keep the map's colormap, range and reference in step. */}
          {TABS.map(t => {
            const Content = TAB_CONTENT[t.id];
            return (
              <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>
                <Content />
              </div>
            );
          })}
        </div>

      {/* ── FOOTER ── */}
      <div className="sidebar-footer">
        <button className="chart-toggle-btn" onClick={() => dispatch({ type: 'TOGGLE_CHART' })}>
          <i className={`fa-solid ${state.showChart ? 'fa-chart-line' : 'fa-wave-square'}`}></i>
          {state.showChart ? 'Hide' : 'Show'} Time Series
        </button>
        {state.refBufferEnabled && (
          <button className="chart-toggle-btn" style={{ marginTop: 4 }}
            onClick={() => dispatch({ type: 'TOGGLE_REF_CHART' })}>
            <i className="fa-solid fa-crosshairs"></i>
            {state.showRefChart ? 'Hide' : 'Show'} Ref Buffer Chart
          </button>
        )}
      </div>
      </div>
    </div>
  );
}

/** Light or dark at the foot of the rail; Project › Appearance also offers "System". */
function ThemeToggle() {
  const [shown, setShown] = useState(shownTheme);
  useEffect(() => {
    const follow = () => setShown(shownTheme());
    window.addEventListener(THEME_EVENT, follow);
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener('change', follow);
    return () => { window.removeEventListener(THEME_EVENT, follow); media?.removeEventListener('change', follow); };
  }, []);
  const next = shown === 'light' ? 'dark' : 'light';
  return (
    <button type="button" className="panel-rail-btn panel-theme-btn" onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {shown === 'light'
        ? svg(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />)
        : svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>)}
    </button>
  );
}
