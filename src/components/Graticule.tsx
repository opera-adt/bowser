import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { drawGraticule, type GraticuleMode } from '../map/graticule';

const SVG_NS = 'http://www.w3.org/2000/svg';

export default function Graticule({ mode }: { mode: GraticuleMode }) {
  const map = useMap();

  useEffect(() => {
    if (mode === 'off') return;

    // Place the SVG inside a dedicated Leaflet pane so it participates in the
    // map-pane's stacking context: z-index 450 puts it above tile (200) and
    // overlay (400) panes, below shadow/marker (500/600+) panes.
    let pane = map.getPane('graticule') as HTMLElement | undefined;
    if (!pane) {
      pane = map.createPane('graticule');
      pane.style.zIndex = '450';
      pane.style.pointerEvents = 'none';
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'bowser-graticule');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    pane.appendChild(svg);

    function redraw() {
      // The graticule pane is inside leaflet-map-pane which carries a CSS
      // translate for panning.  Offset the SVG by the inverse of that
      // translate so that latLngToContainerPoint() coordinates map directly
      // onto SVG pixel coordinates without any adjustment.
      const pos = L.DomUtil.getPosition(map.getPanes().mapPane);
      svg.style.left = `${-pos.x}px`;
      svg.style.top = `${-pos.y}px`;
      const b = map.getBounds();
      drawGraticule(svg, mode as Exclude<GraticuleMode, 'off'>, {
        size: map.getSize(), south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast(),
        project: (lat, lng) => map.latLngToContainerPoint([lat, lng]),
      });
    }

    redraw();
    map.on('move zoom viewreset moveend resize', redraw);
    return () => {
      map.off('move zoom viewreset moveend resize', redraw);
      svg.remove();
    };
  }, [map, mode]);

  return null;
}
