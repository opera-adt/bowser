import { useCallback, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { ACCEPT, useAddFiles } from '../../hooks/useAddFiles';
import { geologyOverlay, soilsOverlay } from '../../map/services';
import { inspectPmtiles, pmtilesOverlay } from '../../map/pmtiles';
import { CONTEXT_LAYERS, contextOverlay, LAND_COVER_YEARS, landCoverOverlay, type ContextKey } from '../../map/contextLayers';
import { DATA_ROW, DRAWINGS_ID, drawingIndexOf, drawingName, overlayRows, reorderOverlays } from '../../map/overlays';
import { downloadLayer } from '../../map/exportLayer';
import { browserHasWebGL2, chooseMap } from '../../map/mapChoice';
import OverlayRow from './OverlayRow';
import { SectionHeader, Switch } from './controls';

type View = 'layers' | 'services' | 'draw';
const VIEWS: { id: View; label: string }[] = [
  { id: 'layers', label: 'Layers' }, { id: 'services', label: 'Services' }, { id: 'draw', label: 'Draw' },
];

export default function OverlaysTab() {
  const [view, setView] = useState<View>('layers');
  return (
    <>
      <div className="panel-subtabs">
        <div className="segmented" role="tablist" aria-label="Overlays">
          {VIEWS.map(v => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id}
              className={`segmented-item${view === v.id ? ' active' : ''}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div hidden={view !== 'layers'}><LayersView /></div>
      <div hidden={view !== 'draw'}><DrawView /></div>
      <div hidden={view !== 'services'}><ContextView /><ServicesView onAdded={() => setView('layers')} /></div>
    </>
  );
}

/** Drop or pick files, then order, show and style what is on the map. */
function LayersView() {
  const { state, dispatch } = useAppContext();
  const addFiles = useAddFiles();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<{ id: string; below: boolean } | null>(null);
  const [zoneActive, setZoneActive] = useState(false);

  const drop = (target: string) => {
    if (dragging && dropOn) {
      dispatch({ type: 'SET_OVERLAYS', payload: reorderOverlays(state.overlays, dragging, target, dropOn.below) });
    }
    setDropOn(null);
  };
  const over = (id: string, below: boolean) => { if (dragging && dragging !== id) setDropOn({ id, below }); };
  const sideOf = (id: string) => (dropOn?.id === id ? (dropOn.below ? 'below' : 'above') : null);
  const dataSide = sideOf(DATA_ROW);

  return (
    <>
      <div className="sidebar-section">
        <SectionHeader label="Add data" />
        <label className={`ov-dropzone${zoneActive ? ' active' : ''}`}
          onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setZoneActive(true); } }}
          onDragLeave={() => setZoneActive(false)}
          onDrop={e => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setZoneActive(false);
            void addFiles(e.dataTransfer.files);
          }}>
          <strong>Drop files here or click to choose</strong>
          <small>Vector: GeoJSON, CSV, KML, GPX, Shapefile</small>
          <small>Raster: GeoTIFF</small>
          <input type="file" multiple accept={ACCEPT} aria-label="Add files" style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.length) void addFiles(Array.from(e.target.files)); e.currentTarget.value = ''; }} />
        </label>
        <div className="row-label" style={{ textAlign: 'center', fontSize: '0.72em' }}>You can also drop files on the map.</div>
      </div>
      <div className="sidebar-section">
        <SectionHeader label="Layers" />
        <div className="ov-list">
          {overlayRows(state.overlays).map(id => {
            if (id === DATA_ROW) {
              return (
                <div key={id} className={`ov-row ov-row-data${dataSide ? ` drop-${dataSide}` : ''}`}
                  onDragOver={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (dragging) { e.preventDefault(); over(id, e.clientY > rect.top + rect.height / 2); }
                  }}
                  onDragLeave={() => setDropOn(null)}
                  onDrop={e => { e.preventDefault(); drop(id); }}>
                  <span className="ov-name">Data layer</span>
                  <span className="ov-type" title={state.currentDataset}>{state.currentDataset}</span>
                </div>
              );
            }
            const overlay = state.overlays.find(o => o.id === id)!;
            return (
              <OverlayRow key={id} overlay={overlay} dropSide={sideOf(id)}
                onDragStart={() => setDragging(id)}
                onDragEnd={() => { setDragging(null); setDropOn(null); }}
                onDragOver={below => over(id, below)}
                onDragLeave={() => setDropOn(null)}
                onDrop={() => drop(id)} />
            );
          })}
        </div>
        {state.overlays.length === 0
          ? <div className="row-label" style={{ textAlign: 'center', fontSize: '0.72em' }}>Files and services you add appear here.</div>
          : <div className="row-label" style={{ textAlign: 'center', fontSize: '0.72em' }}>Drag ⋮⋮ to reorder, above or below the data layer.</div>}
      </div>
    </>
  );
}

/** Roads, boundaries, buildings and land cover; each one on is a row in Layers. */
function ContextView() {
  const { state, dispatch } = useAppContext();
  const rowOf = (key: ContextKey) => state.overlays.find(o => o.type === 'context' && o.contextKey === key);
  const toggle = (key: ContextKey) => {
    const row = rowOf(key);
    if (row) dispatch({ type: 'REMOVE_OVERLAY', payload: row.id });
    else dispatch({ type: 'ADD_OVERLAY', payload: contextOverlay(key, `ctx_${key}_${Date.now()}`) });
  };
  const landCover = state.overlays.find(o => o.landCoverYear);
  const serviceRow = (key: string) => state.overlays.find(o => o.serviceKey === key);
  const [loadingSoils, setLoadingSoils] = useState(false);
  const toggleSoils = async () => {
    const row = serviceRow('soils');
    if (row) { dispatch({ type: 'REMOVE_OVERLAY', payload: row.id }); return; }
    if (!state.viewBounds || loadingSoils) return;
    const [south, west, north, east] = state.viewBounds;
    setLoadingSoils(true);
    dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: 'Loading soils in this view…' });
    try {
      const { overlay, notes } = await soilsOverlay([west, south, east, north], `soils_${Date.now()}`);
      const n = overlay.data?.features.length ?? 0;
      if (n) dispatch({ type: 'ADD_OVERLAY', payload: overlay });
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: n
        ? `Soils: ${n.toLocaleString()} map units.${notes.length ? ` Left out: ${notes.join('; ')}.` : ''}`
        : 'No soil survey in this view (SSURGO covers the US).' });
    } catch (err) {
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: `Could not load soils: ${(err as Error).message}` });
    } finally {
      setLoadingSoils(false);
    }
  };
  const [year, setYear] = useState(LAND_COVER_YEARS[LAND_COVER_YEARS.length - 1]);
  const setLandCover = (on: boolean, y = year) => {
    if (landCover) dispatch({ type: 'REMOVE_OVERLAY', payload: landCover.id });
    if (on) dispatch({ type: 'ADD_OVERLAY', payload: landCoverOverlay(y, `landcover_${Date.now()}`) });
  };
  return (
    <div className="sidebar-section">
      <SectionHeader label="Context layers" />
      {CONTEXT_LAYERS.map(c => (
        <div key={c.key} className="toggle-row" style={{ gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: '0.82em' }}>{c.name}</span>
            <span className="row-label" style={{ fontSize: '0.7em' }}>{c.note}</span>
          </div>
          <Switch checked={!!rowOf(c.key)} label={c.name} onChange={() => toggle(c.key)} />
        </div>
      ))}
      <div className="toggle-row" style={{ gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: '0.82em' }}>Land cover</span>
          <span className="row-label" style={{ fontSize: '0.7em' }}>Sentinel-2 10 m, yearly (Impact Observatory)</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="sidebar-select" style={{ width: 'auto', fontSize: '0.76em' }} aria-label="Land cover year" value={year}
            onChange={e => { const y = Number(e.target.value); setYear(y); if (landCover) setLandCover(true, y); }}>
            {LAND_COVER_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <Switch checked={!!landCover} label="Land cover" onChange={() => setLandCover(!landCover)} />
        </div>
      </div>
      <div className="toggle-row" style={{ gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: '0.82em' }}>Geology</span>
          <span className="row-label" style={{ fontSize: '0.7em' }}>USGS state geologic maps (SGMC), conterminous US</span>
        </div>
        <Switch checked={!!serviceRow('geology')} label="Geology" onChange={() => {
          const row = serviceRow('geology');
          dispatch(row ? { type: 'REMOVE_OVERLAY', payload: row.id } : { type: 'ADD_OVERLAY', payload: geologyOverlay(`geology_${Date.now()}`) });
        }} />
      </div>
      <div className="toggle-row" style={{ gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: '0.82em' }}>Soils</span>
          <span className="row-label" style={{ fontSize: '0.7em' }}>USDA SSURGO in this view: peat, expansive clay, wet soils (US)</span>
        </div>
        <Switch checked={!!serviceRow('soils') || loadingSoils} label="Soils" onChange={toggleSoils} />
      </div>
      <div className="row-label" style={{ fontSize: '0.7em' }}>
        Roads, boundaries and buildings come from OpenStreetMap via OpenFreeMap. Soils load for the view when switched on;
        zoom in first, and switch off and on again after moving. All need an internet connection.
        Order, opacity and style are in Layers.
      </div>
    </div>
  );
}

const ON_MAPLIBRE = chooseMap(window.location.search, browserHasWebGL2) === 'maplibre';

const SHAPE_LABEL: Record<string, string> = {
  Polygon: 'Polygon', MultiPolygon: 'Polygon', LineString: 'Line', MultiLineString: 'Line', Point: 'Marker', MultiPoint: 'Marker',
};

/** GeoLibre's drawing and editing tools on the map; what is drawn is the Drawings layer, each shape named here. */
function DrawView() {
  const { state, dispatch } = useAppContext();
  const drawings = state.overlays.find(o => o.id === DRAWINGS_ID);
  const count = drawings?.data?.features.length ?? 0;
  if (!ON_MAPLIBRE) {
    return (
      <div className="sidebar-section">
        <SectionHeader label="Drawing" />
        <div className="row-label">Drawing needs the WebGL map, which this browser can't show.</div>
      </div>
    );
  }
  return (
    <div className="sidebar-section">
      <SectionHeader label="Drawing" />
      <div className="toggle-row">
        <span style={{ fontSize: '0.82em' }}>Drawing tools on the map</span>
        <Switch checked={state.drawingEnabled} label="Drawing tools"
          onChange={() => {
            dispatch({ type: 'SET_DRAWING_ENABLED', payload: !state.drawingEnabled });
            dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: state.drawingEnabled
              ? 'Drawing tools off: map clicks add time-series points again.'
              : 'Drawing tools on: map clicks draw shapes, not time-series points (Overlays › Draw to turn off).' });
          }} />
      </div>
      <div className="row-label" style={{ fontSize: '0.74em', lineHeight: 1.45 }}>
        Polygon, line, rectangle, circle, marker and freehand; then select, move, edit vertices, rotate, cut, scale,
        copy, split, union, difference, simplify and lasso. Double-click or right-click finishes a shape; Ctrl+Z undoes.
        While the tools are on, map clicks don't add time-series points.
      </div>
      <div className="row-label" style={{ fontSize: '0.78em' }}>
        {count === 0 ? 'Nothing drawn yet.' : `${count} shape${count === 1 ? '' : 's'} in the Drawings layer.`}
      </div>
      {count > 0 && (
        <div className="drawing-list" role="list" aria-label="Drawn shapes">
          {(drawings!.data!.features as Array<{ geometry?: { type?: string } | null }>).map((f, i) => {
            const kind = SHAPE_LABEL[f?.geometry?.type ?? ''] ?? 'Shape';
            const charted = state.chartAreas.find(a => drawingIndexOf(a, drawings!.data) === i);
            return (
              <div key={i} className="drawing-item" role="listitem">
                <span className="ov-swatch" style={{ background: charted?.color ?? drawings!.color }} title={charted ? 'In the chart' : undefined} />
                <input type="text" className="point-name-input" value={drawingName(f)} placeholder={`${kind} ${i + 1}`}
                  aria-label={`Name of ${kind.toLowerCase()} ${i + 1}`}
                  onChange={e => dispatch({ type: 'RENAME_DRAWING', payload: { index: i, name: e.target.value } })} />
                <i className="fa-solid fa-pen drawing-item-pen" aria-hidden="true"></i>
              </div>
            );
          })}
        </div>
      )}
      {count > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="hist-btn" onClick={() => downloadLayer('drawings', drawings!.data!.features as never, 'geojson')}>Save GeoJSON</button>
          <button type="button" className="hist-btn" disabled={state.drawingEnabled}
            title={state.drawingEnabled ? 'Turn the tools off first, or delete shapes with the eraser' : 'Remove every drawn shape'}
            onClick={() => { if (confirm(`Remove all ${count} drawn shapes?`)) dispatch({ type: 'REMOVE_OVERLAY', payload: DRAWINGS_ID }); }}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** External WMS / WMTS (XYZ template) layers and custom PMTiles archives. */
function ServicesView({ onAdded }: { onAdded: () => void }) {
  const { dispatch } = useAppContext();
  const [extType, setExtType] = useState<'wms' | 'wmts' | 'pmtiles'>('wms');
  const [pmBusy, setPmBusy] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);
  const [extUrl, setExtUrl] = useState('');
  const [extLayers, setExtLayers] = useState('');
  // Fetch a WMS's named layers (server-side proxy avoids browser CORS) so the
  // user can pick from a dropdown instead of knowing the layer name in advance.
  const [wmsLayerOptions, setWmsLayerOptions] = useState<{ name: string; title: string }[]>([]);
  const [wmsLoading, setWmsLoading] = useState(false);

  const addExternalOverlay = useCallback(() => {
    // Leaflet only substitutes lowercase {x}/{y}/{z}/{s}; normalize uppercase
    // placeholders (common in WMTS/ArcGIS docs) so they don't throw.
    const url = extUrl.trim()
      .replace(/\{Z\}/g, '{z}').replace(/\{Y\}/g, '{y}')
      .replace(/\{X\}/g, '{x}').replace(/\{S\}/g, '{s}');
    if (!url) return;
    if (extType === 'pmtiles') { void addPmtiles(url); return; }
    dispatch({
      type: 'ADD_OVERLAY',
      payload: {
        id: `ov_${Date.now()}`,
        name: (extType === 'wms' ? extLayers.trim() : '') || url.replace(/^https?:\/\//, '').slice(0, 30),
        type: extType,
        visible: true,
        opacity: 1,
        url,
        wmsLayers: extType === 'wms' ? extLayers.trim() : undefined,
        maxNativeZoom: 18,
      },
    });
    setExtUrl(''); setExtLayers('');
    setWmsLayerOptions([]);
    onAdded();
  }, [extType, extUrl, extLayers, dispatch, onAdded]);

  /** A .pmtiles archive by URL: its header says raster or vector (and the layers), then the map zooms to it. */
  const addPmtiles = async (url: string) => {
    setPmBusy(true);
    setPmError(null);
    try {
      const info = await inspectPmtiles(url);
      const overlay = pmtilesOverlay(url, info, `pm_${Date.now()}`);
      dispatch({ type: 'ADD_OVERLAY', payload: overlay });
      if (overlay.bounds) {
        const [w, s, e, n] = overlay.bounds;
        dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [Math.max(-85, s), w, Math.min(85, n), e] });
      }
      setExtUrl('');
      onAdded();
    } catch (err) {
      setPmError(`Could not read ${url}: ${(err as Error).message}. The server must allow range requests and CORS.`);
    } finally {
      setPmBusy(false);
    }
  };

  const fetchWmsLayers = useCallback(async () => {
    const u = extUrl.trim();
    if (!u) return;
    setWmsLoading(true);
    try {
      const res = await fetch(`/wms_capabilities?url=${encodeURIComponent(u)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const layers = (await res.json()).layers ?? [];
      setWmsLayerOptions(layers);
      if (layers.length) setExtLayers(layers[0].name);
      else alert('No named layers found in this WMS.');
    } catch (err) {
      alert(`Could not load WMS layers: ${(err as Error).message}`);
    } finally {
      setWmsLoading(false);
    }
  }, [extUrl]);

  return (
    <div className="sidebar-section">
      <SectionHeader label="Add a map service" />
      <div style={{ display: 'flex', gap: 4 }}>
        <select className="sidebar-select" style={{ width: 72, fontSize: '0.76em' }} value={extType}
          onChange={e => { setExtType(e.target.value as 'wms' | 'wmts' | 'pmtiles'); setPmError(null); }}>
          <option value="wms">WMS</option>
          <option value="wmts">WMTS</option>
          <option value="pmtiles">PMTiles</option>
        </select>
        <input className="sidebar-input" style={{ flex: 1, minWidth: 0, fontSize: '0.74em' }}
          placeholder={extType === 'wms' ? 'WMS base URL' : extType === 'wmts' ? 'WMTS/XYZ template …/{z}/{x}/{y}' : 'https://…/archive.pmtiles'}
          value={extUrl} onChange={e => { setExtUrl(e.target.value); setWmsLayerOptions([]); setPmError(null); }} />
      </div>
      {extType === 'pmtiles' && (
        <div className="row-label" style={{ fontSize: '0.72em' }}>
          A raster or vector PMTiles archive; vector layers are drawn in one colour you can change in Layers.
        </div>
      )}
      {pmError && <div className="row-label" style={{ fontSize: '0.74em', color: 'var(--sb-red)', wordBreak: 'break-word' }}>{pmError}</div>}
      {extType === 'wms' && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="hist-btn" style={{ whiteSpace: 'nowrap' }}
            disabled={!extUrl.trim() || wmsLoading} onClick={fetchWmsLayers}
            title="Read the available layers from this WMS">
            {wmsLoading ? '…' : 'Load layers'}
          </button>
          {wmsLayerOptions.length > 0 ? (
            <select className="sidebar-select" style={{ flex: 1, minWidth: 0, fontSize: '0.76em' }}
              value={extLayers} onChange={e => setExtLayers(e.target.value)}>
              {wmsLayerOptions.map(l => <option key={l.name} value={l.name}>{l.title}</option>)}
            </select>
          ) : (
            <input className="sidebar-input" style={{ flex: 1, minWidth: 0, fontSize: '0.74em' }}
              placeholder="WMS layer name" value={extLayers} onChange={e => setExtLayers(e.target.value)} />
          )}
        </div>
      )}
      <button className="hist-btn" style={{ width: '100%' }} disabled={!extUrl.trim() || pmBusy} onClick={addExternalOverlay}>
        <i className="fa-solid fa-plus" style={{ marginRight: 5 }}></i>{pmBusy ? 'Reading the archive…' : `Add ${extType === 'pmtiles' ? 'PMTiles' : extType.toUpperCase()}`}
      </button>
    </div>
  );
}
