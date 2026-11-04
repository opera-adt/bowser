/**
 * Map toolbars, shared by the Leaflet and MapLibre maps (they only dispatch app actions).
 * A map passes the features it can't do yet as ``unsupported``; those buttons render
 * disabled with a note instead of toggling state the map would ignore.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { useProfileContext } from './ProfileTool';

export type MapFeature = 'measure' | 'profile' | 'split' | 'graticule' | 'annotation';
const NONE: ReadonlySet<MapFeature> = new Set();

/** Props that disable a button for a feature this map doesn't support (nothing otherwise). */
function gate(unsupported: ReadonlySet<MapFeature>, f: MapFeature) {
  return unsupported.has(f)
    ? { disabled: true, 'aria-disabled': true, 'data-unsupported': f, style: { opacity: 0.35, cursor: 'not-allowed' } }
    : {};
}

export function MapLeftToolbar({ measureActive, onToggleMeasure, onMeasureOff, unsupported = NONE }: {
  measureActive: boolean;
  onToggleMeasure: () => void;
  onMeasureOff: () => void;
  unsupported?: ReadonlySet<MapFeature>;
}) {
  const { state, dispatch } = useAppContext();
  const { active: profileActive, setActive: setProfileActive } = useProfileContext();
  return (
    <div className="map-toolbar">
    <button
      className={`map-tool-btn${measureActive ? ' active' : ''}`}
      title="Measure distance (click points, double-click to finish)"
        {...gate(unsupported, 'measure')}
      onClick={() => { onToggleMeasure(); setProfileActive(false); }}
    >
      <i className="fa-solid fa-ruler"></i>
    </button>
    <button
      className={`map-tool-btn${profileActive ? ' active' : ''}`}
      title="Draw profile line (click start, click end, double-click to extract)"
        {...gate(unsupported, 'profile')}
      onClick={() => { setProfileActive(!profileActive); onMeasureOff(); }}
    >
      <i className="fa-solid fa-chart-area"></i>
    </button>
    <button
      className={`map-tool-btn${state.refEnabled ? ' active' : ''}`}
      onClick={() => dispatch({ type: 'TOGGLE_REF_ENABLED' })}
      title="Toggle spatial re-referencing"
    ><i className="fa-solid fa-crosshairs"></i></button>
    <button
      className={`map-tool-btn${!state.pointPickingEnabled ? ' active' : ''}`}
      onClick={() => dispatch({ type: 'TOGGLE_POINT_PICKING' })}
      title={state.pointPickingEnabled ? 'Point picking ON — click to disable' : 'Point picking OFF — click to enable'}
      style={!state.pointPickingEnabled ? { opacity: 0.5 } : undefined}
    ><i className="fa-solid fa-location-dot"></i></button>
  </div>
  );
}

export function MapTopRightToolbar({ onToggleToolbars, unsupported = NONE, children }: {
  onToggleToolbars: () => void;
  /** Features this map can't do yet: shown disabled, not silently ignored. */
  unsupported?: ReadonlySet<MapFeature>;
  /** Map-specific buttons, placed before the hide-toolbar button. */
  children?: ReactNode;
}) {
  const { state, dispatch } = useAppContext();
  const [basemapOpen, setBasemapOpen] = useState(false);
  const info = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;

  const fitDataset = () => {
    if (!info) return;
    const b = info.latlon_bounds; // [w, s, e, n]
    dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [b[1], b[0], b[3], b[2]] });
  };

  // Close basemap popover on outside click
  useEffect(() => {
    if (!basemapOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.basemap-popover') && !t.closest('.basemap-trigger')) setBasemapOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [basemapOpen]);

  return (
    <div className="map-toolbar-right">
      <button className="map-tool-btn" onClick={fitDataset} title="Fit view to dataset" disabled={!info}>
        <i className="fa-solid fa-arrows-to-circle"></i>
      </button>
      <div style={{ position: 'relative' }}>
        <button className="map-tool-btn basemap-trigger" onClick={() => setBasemapOpen(v => !v)} title="Basemap">
          <i className="fa-solid fa-map"></i>
        </button>
        {basemapOpen && (
          <div className="basemap-popover" style={{ minWidth: 220 }}>
            {/* ── Layer 1 (bottom) ── */}
            <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginBottom: 4 }}>
              Layer 1 {state.basemapSwapped ? '(top)' : '(bottom)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {Object.entries(baseMaps).map(([key, bm]) => (
                <button
                  key={key}
                  className={`basemap-option${state.selectedBasemap === key ? ' active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_BASEMAP', payload: key })}
                  style={{ padding: '2px 7px', fontSize: '0.78em' }}
                >{bm.label ?? key}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>Opacity</span>
              <input type="range" min={0} max={1} step={0.05}
                value={state.basemapOpacity}
                onChange={e => dispatch({ type: 'SET_BASEMAP_OPACITY', payload: parseFloat(e.target.value) })}
                style={{ flex: 1 }} />
              <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', width: 28, textAlign: 'right' }}>
                {Math.round(state.basemapOpacity * 100)}%
              </span>
            </div>

            {/* ── Swap button ── */}
            <button
              onClick={() => dispatch({ type: 'TOGGLE_BASEMAP_SWAP' })}
              title="Swap layer order"
              style={{
                width: '100%', marginBottom: 8, padding: '3px 0',
                background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)',
                borderRadius: 4, color: 'var(--sb-text)', cursor: 'pointer', fontSize: '0.75em',
              }}
            >⇅ Swap order</button>

            {/* ── Layer 2 (top) ── */}
            <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginBottom: 4 }}>
              Layer 2 {state.basemapSwapped ? '(bottom)' : '(top)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              <button
                className={`basemap-option${state.secondaryBasemap === null ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_SECONDARY_BASEMAP', payload: null })}
                style={{ padding: '2px 7px', fontSize: '0.78em' }}
              >None</button>
              {Object.entries(baseMaps).map(([key, bm]) => (
                <button
                  key={key}
                  className={`basemap-option${state.secondaryBasemap === key ? ' active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_SECONDARY_BASEMAP', payload: key })}
                  style={{ padding: '2px 7px', fontSize: '0.78em' }}
                >{bm.label ?? key}</button>
              ))}
            </div>
            {state.secondaryBasemap && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>Opacity</span>
                  <input type="range" min={0} max={1} step={0.05}
                    value={state.secondaryBasemapOpacity}
                    onChange={e => dispatch({ type: 'SET_SECONDARY_BASEMAP_OPACITY', payload: parseFloat(e.target.value) })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', width: 28, textAlign: 'right' }}>
                    {Math.round(state.secondaryBasemapOpacity * 100)}%
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <button
        className={`map-tool-btn${state.splitScreen ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_SPLIT_SCREEN' })}
        title="Split screen — compare two layers"
        {...gate(unsupported, 'split')}
      ><i className="fa-solid fa-table-columns"></i></button>
      <button
        className={`map-tool-btn${state.showColorbar ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_COLORBAR' })}
        title="Toggle colorbar on map"
      ><i className="fa-solid fa-palette"></i></button>
      <button
        className={`map-tool-btn${state.showLosIndicator ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_LOS_INDICATOR' })}
        title="Toggle LOS geometry indicator"
      ><i className="fa-solid fa-satellite"></i></button>
      <button
        className={`map-tool-btn${state.graticuleMode !== 'off' ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'CYCLE_GRATICULE' })}
        title={`Lat/lon grid: ${state.graticuleMode} (click to cycle)`}
        {...gate(unsupported, 'graticule')}
      ><i className="fa-solid fa-border-all"></i></button>
      <button
        className={`map-tool-btn${state.annotationMode ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_ANNOTATION_MODE' })}
        title={state.annotationMode ? 'Annotation mode ON — click map to place label (double-click label to delete)' : 'Toggle annotation mode'}
        {...gate(unsupported, 'annotation')}
      ><i className="fa-solid fa-pen-to-square"></i></button>
      <button
        className={`map-tool-btn${state.pixelInspectEnabled ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_PIXEL_INSPECT' })}
        title="Inspect pixel value on hover"
      ><i className="fa-solid fa-eye-dropper"></i></button>
      {children}
      <button
        className="map-tool-btn"
        onClick={onToggleToolbars}
        title="Hide toolbar"
        style={{ marginTop: 4, opacity: 0.6 }}
      ><i className="fa-solid fa-chevron-right"></i></button>
    </div>
  );
}
