/**
 * The bowser map on MapLibre GL (opt-in: ``?map=maplibre``).
 *
 * Everything that decides *what* the map asks for or does lives in map-agnostic
 * modules shared with the Leaflet map and pinned by tests:
 *   useRasterTileUrl / tileParams  -> which raster tiles to draw
 *   interactions                   -> click, marker drag/click/double-click, pixel inspect
 *   basemapStyle                   -> basemap sources
 * This file only translates those into MapLibre sources, layers, markers and events.
 *
 * Covered so far: toolbars (shared with Leaflet), 3D terrain with vertical exaggeration,
 * view sync (fit to dataset, sidebar view buttons), basemaps (primary/secondary, swap, opacity), the data raster layer
 * (double-buffered so a new time step never flashes blank), point picking, time-series
 * and reference markers, pixel inspect, cursor position, scale bar, fit to the data.
 * Still Leaflet-only (next commits): split screen, overlays/WMS, profile and measure
 * tools, graticule, annotations, buffer circles.
 */
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { baseMaps } from '../basemap';
import { basemapSource, basemapStack } from '../map/basemapStyle';
import { useRasterTileUrl } from '../map/useRasterTileUrl';
import {
  mapClickActions, markerPopupText, pixelInspectRequest, pixelInspectText,
  pointClickActions, pointDoubleClickActions, pointDragEndActions, refDragEnd, viewBoundsAction,
} from '../map/interactions';
import {
  EXAGGERATION_DEFAULT, EXAGGERATION_MAX, EXAGGERATION_MIN, TERRAIN_PITCH, TERRAIN_SOURCE, TERRAIN_SOURCE_ID,
  clampExaggeration, terrainSpec,
} from '../map/terrain';
import { MapLeftToolbar, MapTopRightToolbar, type MapFeature } from './MapToolbars';
import type { AppState } from '../types';

/** Toolbar features not ported to MapLibre yet: shown disabled with a note. */
const UNSUPPORTED: ReadonlySet<MapFeature> = new Set(['measure', 'profile', 'split', 'graticule', 'annotation']);

const TERRAIN_KEY = 'bowser.maplibre.terrain';
function loadTerrain(): { enabled: boolean; exaggeration: number } {
  try {
    const v = JSON.parse(localStorage.getItem(TERRAIN_KEY) ?? 'null');
    if (v && typeof v.enabled === 'boolean') return { enabled: v.enabled, exaggeration: clampExaggeration(v.exaggeration) };
  } catch { /* private mode or bad JSON: use defaults */ }
  return { enabled: false, exaggeration: EXAGGERATION_DEFAULT };
}

/** Toolbar button + popover: 3D terrain on/off and vertical exaggeration. */
function TerrainButton({ enabled, exaggeration, onChange }: {
  enabled: boolean;
  exaggeration: number;
  onChange: (enabled: boolean, exaggeration: number) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.terrain-popover') && !t.closest('.terrain-trigger')) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <button
        className={`map-tool-btn terrain-trigger${enabled ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title={enabled ? `3D terrain ON (${exaggeration}× exaggeration)` : '3D terrain'}
      ><i className="fa-solid fa-mountain"></i></button>
      {open && (
        <div className="basemap-popover terrain-popover" style={{ minWidth: 220 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8em', marginBottom: 6 }}>
            <input type="checkbox" checked={enabled} onChange={e => onChange(e.target.checked, exaggeration)} />
            3D terrain
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>Exaggeration</span>
            <input type="range" min={EXAGGERATION_MIN} max={EXAGGERATION_MAX} step={0.5} value={exaggeration}
              aria-label="Terrain exaggeration" disabled={!enabled}
              onChange={e => onChange(enabled, parseFloat(e.target.value))} style={{ flex: 1 }} />
            <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', width: 30, textAlign: 'right' }}>{exaggeration}×</span>
          </div>
          <div style={{ fontSize: '0.68em', color: 'var(--sb-muted)', marginTop: 6 }}>
            Right-drag (or Ctrl+drag) to tilt and rotate.
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY_STYLE: maplibregl.StyleSpecification = { version: 8, sources: {}, layers: [] };
const BASEMAP_IDS = ['basemap-bottom', 'basemap-top'] as const;

function datasetBounds(state: AppState): [number, number, number, number] | null {
  const info = (state.currentDataset && state.datasetInfo[state.currentDataset]) || Object.values(state.datasetInfo)[0];
  return info ? info.latlon_bounds : null;
}

function pointElement(color: string, selected: boolean): HTMLElement {
  const size = selected ? 25 : 20;
  const el = document.createElement('div');
  el.className = 'custom-colored-marker';
  el.style.cssText = `width:${size}px;height:${size}px;background-color:${color};`
    + `border:${selected ? '3px' : '2px'} solid white;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3);cursor:pointer;`;
  return el;
}

function refElement(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = '<i class="fa-solid fa-location-dot fa-3x" style="color:#111; text-shadow: 0 0 4px white, 0 0 4px white;"></i>';
  el.title = 'Reference Location';
  return el;
}

export default function MapLibreMap({ toolbarsVisible = true, onToggleToolbars = () => {} }: {
  toolbarsVisible?: boolean;
  onToggleToolbars?: () => void;
}) {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── map ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const b = datasetBounds(state);
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: EMPTY_STYLE,
        center: b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0],
        zoom: 9,
        doubleClickZoom: false,
        attributionControl: { compact: true },
      });
    } catch (err) {
      // No WebGL (old GPU driver, remote desktop, some web views): say so instead of
      // taking the whole app down with an uncaught error.
      setMapError(`The MapLibre map needs WebGL, which this browser could not start (${(err as Error).message}). `
        + 'Open the page without ?map=maplibre to use the Leaflet map.');
      return;
    }
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // Compass + tilt (no zoom buttons, as on the Leaflet map); needed once terrain is tilted.
    map.addControl(new maplibregl.NavigationControl({ showZoom: false, visualizePitch: true }), 'bottom-right');
    mapRef.current = map;
    map.on('load', () => setReady(true));
    return () => { map.remove(); mapRef.current = null; setReady(false); };
    // The map is created once; data-dependent setup happens in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit to the data once it is known.
  const fittedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const b = datasetBounds(state);
    if (!ready || !map || !b || fittedRef.current) return;
    fittedRef.current = true;
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, animate: false });
  }, [ready, state.datasetInfo, state.currentDataset]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── view sync: sidebar / "fit to dataset" requests, and report where we are ─
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !state.viewBounds || state.viewBoundsApplySeq === 0) return;
    const [south, west, north, east] = state.viewBounds;
    map.fitBounds([[west, south], [east, north]], { animate: true });
  }, [ready, state.viewBoundsApplySeq]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onMoveEnd = () => {
      const b = map.getBounds();
      dispatch(viewBoundsAction(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()));
    };
    map.on('moveend', onMoveEnd);
    return () => { map.off('moveend', onMoveEnd); };
  }, [ready, dispatch]);

  // ── 3D terrain ─────────────────────────────────────────────────────────────
  const [terrain, setTerrain] = useState(loadTerrain);
  const setTerrainState = (enabled: boolean, exaggeration: number) => {
    const next = { enabled, exaggeration: clampExaggeration(exaggeration) };
    setTerrain(next);
    try { localStorage.setItem(TERRAIN_KEY, JSON.stringify(next)); } catch { /* not persisted */ }
  };
  const terrainWasOn = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (terrain.enabled && !map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
    map.setTerrain(terrainSpec(terrain.enabled, terrain.exaggeration));
    // MapLibre 6 rebuilds the terrain (reading the new exaggeration) but schedules no
    // frame, so without this the slider only shows after the next pan or zoom.
    map.triggerRepaint();
    // Tilt in when terrain comes on (unless already tilted), back to flat when it goes off.
    if (terrain.enabled && !terrainWasOn.current && map.getPitch() < 10) map.easeTo({ pitch: TERRAIN_PITCH });
    if (!terrain.enabled && terrainWasOn.current) map.easeTo({ pitch: 0, bearing: 0 });
    terrainWasOn.current = terrain.enabled;
  }, [ready, terrain]);

  // ── basemaps ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const primary = baseMaps[state.selectedBasemap] || baseMaps.esriSatellite;
    const secondary = state.secondaryBasemap ? baseMaps[state.secondaryBasemap] : null;
    const stack = basemapStack(primary, secondary, state.basemapSwapped, state.basemapOpacity,
      state.secondaryBasemapOpacity);
    const firstOther = map.getStyle().layers.find((l: { id: string }) => !BASEMAP_IDS.includes(l.id as typeof BASEMAP_IDS[number]))?.id;
    ([['basemap-bottom', stack.bottom, stack.bottomOpacity], ['basemap-top', stack.top, stack.topOpacity]] as const)
      .forEach(([id, item, opacity]) => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        if (!item) return;
        map.addSource(id, basemapSource(item));
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } }, firstOther);
      });
  }, [ready, state.selectedBasemap, state.secondaryBasemap, state.basemapSwapped, state.basemapOpacity,
    state.secondaryBasemapOpacity]);

  // ── data raster (double-buffered) ──────────────────────────────────────────
  const tileUrl = useRasterTileUrl();
  const dataLayerRef = useRef<string | null>(null);
  const nextIdRef = useRef(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const previous = dataLayerRef.current;
    if (!tileUrl) {
      if (previous) { map.removeLayer(previous); map.removeSource(previous); dataLayerRef.current = null; }
      return;
    }
    const id = `data-${++nextIdRef.current}`;
    map.addSource(id, { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 22 });
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': stateRef.current.opacity,
      'raster-fade-duration': 0 } });
    dataLayerRef.current = id;
    if (!previous) return;
    // Keep the previous layer underneath until the new one has drawn, then drop it.
    const swap = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId !== id || !map.isSourceLoaded(id)) return;
      map.off('sourcedata', swap);
      if (map.getLayer(previous)) map.removeLayer(previous);
      if (map.getSource(previous)) map.removeSource(previous);
    };
    map.on('sourcedata', swap);
    return () => { map.off('sourcedata', swap); };
  }, [ready, tileUrl]);

  useEffect(() => {
    const map = mapRef.current;
    const id = dataLayerRef.current;
    if (ready && map && id && map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', state.opacity);
  }, [ready, state.opacity, tileUrl]);

  // Loading indicator: any source still loading.
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const on = () => setLoading(true);
    const off = () => setLoading(false);
    map.on('dataloading', on);
    map.on('idle', off);
    return () => { map.off('dataloading', on); map.off('idle', off); };
  }, [ready]);

  // ── point picking ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const decision = mapClickActions(stateRef.current, [e.lngLat.lat, e.lngLat.lng],
        { toolActive: false, profileActive: false });
      if (decision.kind === 'actions') decision.actions.forEach(dispatch);
      // Annotation mode on MapLibre comes with the annotations commit.
    };
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [ready, dispatch]);

  // ── time-series markers ────────────────────────────────────────────────────
  const markersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = state.timeSeriesPoints.filter(p => p.visible).map(point => {
      const el = pointElement(point.color, state.selectedPointId === point.id);
      el.title = `${point.name} - Double-click to remove`;
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([point.position[1], point.position[0]])
        .addTo(map);
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        new maplibregl.Popup().setLngLat([point.position[1], point.position[0]])
          .setText(markerPopupText(point.position, point.name)).addTo(map);
        pointClickActions(point.id).forEach(dispatch);
      });
      el.addEventListener('dblclick', ev => { ev.stopPropagation(); pointDoubleClickActions(point.id).forEach(dispatch); });
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        pointDragEndActions(point.id, [ll.lat, ll.lng]).forEach(dispatch);
      });
      return marker;
    });
    return () => { markersRef.current.forEach(m => m.remove()); markersRef.current = []; };
  }, [ready, state.timeSeriesPoints, state.selectedPointId, dispatch]);

  // ── reference marker ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !state.refMarkerVisible) return;
    const [lat, lng] = state.refMarkerPosition;
    const el = refElement();
    const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(map);
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      new maplibregl.Popup().setLngLat([lng, lat]).setText(markerPopupText([lat, lng])).addTo(map);
    });
    marker.on('dragend', () => {
      const ll = marker.getLngLat();
      void refDragEnd(stateRef.current, [ll.lat, ll.lng], { fetchPointTimeSeries, fetchBufferTimeSeries }, dispatch);
    });
    return () => { marker.remove(); };
  }, [ready, state.refMarkerVisible, state.refMarkerPosition, dispatch, fetchPointTimeSeries, fetchBufferTimeSeries]);

  // ── cursor position + pixel inspect ────────────────────────────────────────
  const [cursor, setCursor] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const cancel = () => { if (timer) clearTimeout(timer); if (controller) controller.abort(); timer = null; controller = null; };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      setCursor(`${e.lngLat.lat.toFixed(5)} : ${e.lngLat.lng.toFixed(5)}`);
      const s = stateRef.current;
      cancel();
      if (!s.pixelInspectEnabled) { setTooltip(null); return; }
      const req = pixelInspectRequest(s, [e.lngLat.lat, e.lngLat.lng], e.point.x, map.getContainer().clientWidth);
      if (!req) return;
      const { x, y } = e.point;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const res = await fetch(req.url, { signal: controller.signal });
          if (!res.ok) return;
          const values: number[] = await res.json();
          const unit = s.datasetInfo[req.dataset]?.unit ?? '';
          setTooltip({ x, y, text: pixelInspectText(values[0], unit, s.splitScreen, req.onRight) });
        } catch (err) {
          if ((err as Error).name !== 'AbortError') setTooltip(null);
        }
      }, 150);
    };
    const onOut = () => { cancel(); setTooltip(null); setCursor(null); };
    map.on('mousemove', onMove);
    map.on('mouseout', onOut);
    return () => { cancel(); map.off('mousemove', onMove); map.off('mouseout', onOut); };
  }, [ready]);

  return (
    <div className="map-container" style={{ position: 'relative' }}>
      {toolbarsVisible ? (
        <>
          <MapLeftToolbar measureActive={false} onToggleMeasure={() => {}} onMeasureOff={() => {}} unsupported={UNSUPPORTED} />
          <MapTopRightToolbar onToggleToolbars={onToggleToolbars} unsupported={UNSUPPORTED}>
            <TerrainButton enabled={terrain.enabled} exaggeration={terrain.exaggeration} onChange={setTerrainState} />
          </MapTopRightToolbar>
        </>
      ) : (
        <button
          className="map-tool-btn"
          title="Show toolbar"
          onClick={onToggleToolbars}
          style={{ position: 'absolute', top: 10, right: 10, zIndex: 3000 }}
        ><i className="fa-solid fa-bars"></i></button>
      )}
      <div ref={containerRef} data-testid="maplibre-map" style={{ height: '100%', width: '100%' }} />
      {mapError && (
        <div role="alert" style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 40, textAlign: 'center', background: '#1b1b1b', color: '#e8e6e3', zIndex: 4000,
        }}>{mapError}</div>
      )}
      {loading && (
        <div style={{
          position: 'absolute', bottom: 28, right: 10, zIndex: 3000, background: 'rgba(0,0,0,0.55)', color: '#fff',
          borderRadius: 20, padding: '3px 10px', fontSize: '0.72em', display: 'flex', alignItems: 'center', gap: 6,
          pointerEvents: 'none',
        }}>
          <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '0.9em' }} /> Loading…
        </div>
      )}
      <div className="leaflet-control-mouseposition" style={{
        position: 'absolute', left: 10, bottom: 34, zIndex: 3000, background: 'rgba(255,255,255,0.8)', padding: '0 5px',
        fontSize: 11,
      }}>{cursor ?? 'Unavailable'}</div>
      {state.pixelInspectEnabled && tooltip && (
        <div style={{
          position: 'absolute', left: tooltip.x + 14, top: tooltip.y - 10, background: 'rgba(10,10,10,0.88)',
          color: '#e8e6e3', padding: '3px 8px', borderRadius: 4, fontSize: '0.78em',
          fontFamily: 'var(--font-mono, monospace)', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 3500,
          border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        }}>{tooltip.text}</div>
      )}
    </div>
  );
}
