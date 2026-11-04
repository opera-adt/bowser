/**
 * Profile tool on the MapLibre map. Drawing state (profileReducer), geometry
 * (corridorRing, pointAtDistance, dropTrailingDuplicates) and fetching
 * (useProfileFetch) are shared with the Leaflet tool; this draws them with a GeoJSON
 * source and numbered, draggable vertex markers.
 *
 * Click adds vertices, double-click finishes and fetches; a click on a finished line
 * starts a new one; dragging a vertex refetches; hovering the chart moves a dot along the line.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { useProfileContext, useProfileFetch } from './ProfileTool';
import {
  PROFILE_IDLE, corridorRing, pointAtDistance, profileReducer, type LatLng,
} from '../map/profileGeometry';

export const PROFILE_SOURCE = 'profile-tool';
const COLOR = '#f0a500';
const START = '#2ca02c';
const END = '#d62728';

const ll = ([lat, lng]: LatLng): [number, number] => [lng, lat];

function vertexElement(index: number, total: number): HTMLElement {
  const bg = index === 0 ? START : total > 1 && index === total - 1 ? END : COLOR;
  const el = document.createElement('div');
  el.className = 'profile-vertex';
  el.title = 'Drag to move';
  el.textContent = String(index + 1);
  el.style.cssText = `width:18px;height:18px;border-radius:50%;background:${bg};color:white;border:2px solid white;`
    + 'box-sizing:border-box;cursor:grab;display:flex;align-items:center;justify-content:center;font-size:10px;'
    + 'font-weight:700;box-shadow:0 0 3px rgba(0,0,0,0.4);user-select:none;';
  return el;
}

type Feature = GeoJSON.Feature<GeoJSON.Geometry, { kind: string }>;

/** GeoJSON for the line, the dashed preview, the corridor and the chart-hover dot. */
export function profileFeatures(
  pts: LatLng[], preview: LatLng | null, drawing: boolean, radius: number, hover: LatLng | null,
): GeoJSON.FeatureCollection<GeoJSON.Geometry, { kind: string }> {
  const f: Feature[] = [];
  if (pts.length >= 2) f.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: pts.map(ll) } });
  if (drawing && preview && pts.length >= 1) {
    f.push({ type: 'Feature', properties: { kind: 'preview' },
      geometry: { type: 'LineString', coordinates: [...pts, preview].map(ll) } });
  }
  const ring = !drawing ? corridorRing(pts, radius) : [];
  if (ring.length) {
    f.push({ type: 'Feature', properties: { kind: 'corridor' },
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(ll)] } });
  }
  if (hover) f.push({ type: 'Feature', properties: { kind: 'hover' }, geometry: { type: 'Point', coordinates: ll(hover) } });
  return { type: 'FeatureCollection', features: f };
}

export default function MapLibreProfile({ map, ready }: { map: maplibregl.Map | null; ready: boolean }) {
  const { active, radius, hoverDist, data, clearAll } = useProfileContext();
  const [draw, send] = useReducer(profileReducer, PROFILE_IDLE);
  const [preview, setPreview] = useState<LatLng | null>(null);
  const [lineId, setLineId] = useState(0);   // bumped per finished line: rebuilds the vertex markers
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const fetchLine = useProfileFetch(() => (drawRef.current.mode === 'ready' ? drawRef.current.pts : null));

  // Source + layers, once.
  useEffect(() => {
    if (!ready || !map || map.getSource(PROFILE_SOURCE)) return;
    map.addSource(PROFILE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'profile-corridor', type: 'fill', source: PROFILE_SOURCE, filter: ['==', ['get', 'kind'], 'corridor'],
      paint: { 'fill-color': COLOR, 'fill-opacity': 0.12, 'fill-outline-color': COLOR } });
    map.addLayer({ id: 'profile-preview', type: 'line', source: PROFILE_SOURCE, filter: ['==', ['get', 'kind'], 'preview'],
      paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'profile-line', type: 'line', source: PROFILE_SOURCE, filter: ['==', ['get', 'kind'], 'line'],
      paint: { 'line-color': COLOR, 'line-width': 2.5 } });
    map.addLayer({ id: 'profile-hover', type: 'circle', source: PROFILE_SOURCE, filter: ['==', ['get', 'kind'], 'hover'],
      paint: { 'circle-radius': 7, 'circle-color': '#888888', 'circle-opacity': 0.9, 'circle-stroke-color': 'white',
        'circle-stroke-width': 2 } });
  }, [ready, map]);

  // Draw.
  const hover = hoverDist !== null && draw.mode === 'ready' ? pointAtDistance(draw.pts, hoverDist) : null;
  useEffect(() => {
    const src = map?.getSource(PROFILE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!ready || !src) return;
    // The corridor is drawn once a profile has come back, as on the Leaflet map.
    src.setData(profileFeatures(draw.pts, preview, draw.mode === 'drawing', data ? radius : 0, hover));
  }, [ready, map, draw, preview, radius, data, hover?.[0], hover?.[1]]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Turning the tool off clears everything.
  useEffect(() => {
    if (active) return;
    send({ type: 'clear' });
    setPreview(null);
    clearAll();
  }, [active, clearAll]);

  // Clicks, preview, double-click to finish.
  useEffect(() => {
    if (!ready || !map || !active) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => send({ type: 'click', at: [e.lngLat.lat, e.lngLat.lng] });
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (drawRef.current.mode === 'drawing') setPreview([e.lngLat.lat, e.lngLat.lng]);
    };
    const onDbl = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      const next = profileReducer(drawRef.current, {
        type: 'finish', toPixel: p => { const c = map.project(ll(p)); return [c.x, c.y]; },
      });
      send({ type: 'finish', toPixel: p => { const c = map.project(ll(p)); return [c.x, c.y]; } });
      if (next.mode === 'ready') { setPreview(null); setLineId(n => n + 1); canvas.style.cursor = ''; void fetchLine(next.pts); }
    };
    map.on('click', onClick);
    map.on('mousemove', onMove);
    map.on('dblclick', onDbl);
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
      map.off('dblclick', onDbl);
      canvas.style.cursor = '';
    };
  }, [ready, map, active, fetchLine]);

  // Numbered, draggable vertices on a finished line.
  useEffect(() => {
    if (!ready || !map || draw.mode !== 'ready') return;
    const markers = draw.pts.map((p, i) => {
      const m = new maplibregl.Marker({ element: vertexElement(i, draw.pts.length), draggable: true })
        .setLngLat(ll(p)).addTo(map);
      m.on('drag', () => { const q = m.getLngLat(); send({ type: 'move', index: i, at: [q.lat, q.lng] }); });
      m.on('dragend', () => {
        const q = m.getLngLat();
        const pts = drawRef.current.pts.map((x, j) => (j === i ? [q.lat, q.lng] as LatLng : x));
        void fetchLine(pts);
      });
      return m;
    });
    return () => { markers.forEach(m => m.remove()); };
    // Rebuild only when a line is finished or replaced, not on every drag step.
  }, [ready, map, draw.mode, lineId, fetchLine]);  // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
