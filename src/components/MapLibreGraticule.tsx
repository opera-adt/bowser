/**
 * Lat/lon graticule on the MapLibre map: the shared map/graticule drawing in an SVG laid
 * over the map in screen space (above the split-screen right map), redrawn as the camera
 * moves. Grid lines are straight between projected end points, so they stay exact while
 * flat; tilted, they follow the ground plane (not the terrain relief).
 */
import { useEffect, useRef } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { drawGraticule, type GraticuleMode } from '../map/graticule';

export default function MapLibreGraticule({ map, ready, mode }: {
  map: maplibregl.Map | null;
  ready: boolean;
  mode: GraticuleMode;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!ready || !map || !svg || mode === 'off') return;
    const redraw = () => {
      const c = map.getContainer();
      const b = map.getBounds();
      drawGraticule(svg, mode, {
        size: { x: c.clientWidth, y: c.clientHeight },
        south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast(),
        project: (lat, lng) => map.project([lng, lat]),
      });
    };
    redraw();
    map.on('move', redraw);
    map.on('resize', redraw);
    return () => { map.off('move', redraw); map.off('resize', redraw); };
  }, [ready, map, mode]);

  if (mode === 'off') return null;
  return (
    <svg ref={svgRef} className="bowser-graticule" data-testid="maplibre-graticule"
      style={{ position: 'absolute', left: 0, top: 0, zIndex: 2, pointerEvents: 'none' }} />
  );
}
