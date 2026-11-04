import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { formatDistance, pathLength } from '../map/measure';

interface MeasureToolProps {
  active: boolean;
  onDeactivate: () => void;
}

export default function MeasureTool({ active, onDeactivate }: MeasureToolProps) {
  const map = useMap();
  const pointsRef = useRef<L.LatLng[]>([]);
  const linesRef = useRef<L.Polyline[]>([]);
  const markersRef = useRef<L.CircleMarker[]>([]);
  const labelRef = useRef<L.Popup | null>(null);


  const clearAll = () => {
    linesRef.current.forEach(l => l.remove());
    markersRef.current.forEach(m => m.remove());
    if (labelRef.current) labelRef.current.remove();
    pointsRef.current = [];
    linesRef.current = [];
    markersRef.current = [];
    labelRef.current = null;
  };

  useEffect(() => {
    if (!active) { clearAll(); return; }

    map.getContainer().style.cursor = 'crosshair';

    const onClick = (e: L.LeafletMouseEvent) => {
      const pts = pointsRef.current;
      pts.push(e.latlng);

      const dot = L.circleMarker(e.latlng, {
        radius: 4, color: '#4d9de0', fillColor: '#4d9de0', fillOpacity: 1, weight: 2,
      }).addTo(map);
      markersRef.current.push(dot);

      if (pts.length > 1) {
        const seg = L.polyline([pts[pts.length - 2], pts[pts.length - 1]], {
          color: '#4d9de0', weight: 2, dashArray: '6 4',
        }).addTo(map);
        linesRef.current.push(seg);

        const total = pathLength(pts.map(p => [p.lat, p.lng] as [number, number]));

        if (labelRef.current) labelRef.current.remove();
        labelRef.current = L.popup({ closeButton: false, autoClose: false, closeOnClick: false })
          .setLatLng(e.latlng)
          .setContent(`<b>${formatDistance(total)}</b>`)
          .openOn(map);
      }
    };

    const onDblClick = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      onDeactivate();
    };

    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    map.doubleClickZoom.disable();

    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
      map.doubleClickZoom.enable();
      map.getContainer().style.cursor = '';
      clearAll();
    };
  }, [active, map]);

  return null;
}
