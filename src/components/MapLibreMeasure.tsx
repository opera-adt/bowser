/**
 * Measure tool on the MapLibre map (behaviour as the Leaflet MeasureTool): click to
 * add points along a dashed path with a running total at the last point; double-click
 * ends the measurement. Maths shared via map/measure.
 */
import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import { formatDistance, pathLength } from '../map/measure';
import type { LatLng } from '../map/profileGeometry';

export const MEASURE_SOURCE = 'measure-tool';
const COLOR = '#4d9de0';

export function measureFeatures(pts: LatLng[]): GeoJSON.FeatureCollection {
  const coords = pts.map(([lat, lng]) => [lng, lat]);
  return {
    type: 'FeatureCollection',
    features: [
      ...coords.map(c => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: c } })),
      ...(coords.length > 1
        ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords } }]
        : []),
    ],
  };
}

export default function MapLibreMeasure({ map, ready, active, onDeactivate }: {
  map: maplibregl.Map | null;
  ready: boolean;
  active: boolean;
  onDeactivate: () => void;
}) {
  const onDeactivateRef = useRef(onDeactivate);
  onDeactivateRef.current = onDeactivate;

  useEffect(() => {
    if (!ready || !map || map.getSource(MEASURE_SOURCE)) return;
    map.addSource(MEASURE_SOURCE, { type: 'geojson', data: measureFeatures([]) });
    map.addLayer({ id: 'measure-line', type: 'line', source: MEASURE_SOURCE, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'measure-points', type: 'circle', source: MEASURE_SOURCE, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': COLOR, 'circle-stroke-color': COLOR, 'circle-stroke-width': 2 } });
  }, [ready, map]);

  useEffect(() => {
    const src = map?.getSource(MEASURE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!ready || !map || !src || !active) return;
    const pts: LatLng[] = [];
    let label: maplibregl.Popup | null = null;
    const canvas = map.getCanvas();
    canvas.style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => {
      pts.push([e.lngLat.lat, e.lngLat.lng]);
      src.setData(measureFeatures(pts));
      if (pts.length > 1) {
        label?.remove();
        label = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
          .setLngLat(e.lngLat).setHTML(`<b>${formatDistance(pathLength(pts))}</b>`).addTo(map);
      }
    };
    const onDbl = (e: maplibregl.MapMouseEvent) => { e.preventDefault(); onDeactivateRef.current(); };
    map.on('click', onClick);
    map.on('dblclick', onDbl);
    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDbl);
      canvas.style.cursor = '';
      label?.remove();
      src.setData(measureFeatures([]));
    };
  }, [ready, map, active]);

  return null;
}
