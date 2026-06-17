import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

type GraticuleMode = 'off' | 'plain' | 'zebra';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Pick a "nice" graticule step (1/2/5 × 10ⁿ degrees) for the current span,
// targeting roughly `targetCount` divisions across the visible map.
function niceStep(span: number, targetCount: number): number {
  const rough = span / targetCount;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const norm = rough / base;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * base;
}

// Adaptive precision: enough decimals to distinguish two adjacent ticks.
function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.max(0, -Math.floor(Math.log10(step)));
}

function fmtLat(deg: number, decimals: number): string {
  const hemi = deg >= 0 ? 'N' : 'S';
  return `${Math.abs(deg).toFixed(decimals)}°${hemi}`;
}

function fmtLon(deg: number, decimals: number): string {
  const hemi = deg >= 0 ? 'E' : 'W';
  return `${Math.abs(deg).toFixed(decimals)}°${hemi}`;
}

function ticksInRange(min: number, max: number, step: number): number[] {
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // Avoid float drift: round each tick to a whole multiple of step.
  for (let i = 0; start + i * step <= max + 1e-9; i++) {
    ticks.push(start + i * step);
  }
  return ticks;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

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
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const size = map.getSize();
      svg.setAttribute('width', String(size.x));
      svg.setAttribute('height', String(size.y));
      svg.setAttribute('viewBox', `0 0 ${size.x} ${size.y}`);

      // The graticule pane is inside leaflet-map-pane which carries a CSS
      // translate for panning.  Offset the SVG by the inverse of that
      // translate so that latLngToContainerPoint() coordinates map directly
      // onto SVG pixel coordinates without any adjustment.
      const mapPane = map.getPanes().mapPane;
      const pos = L.DomUtil.getPosition(mapPane);
      svg.style.left = `${-pos.x}px`;
      svg.style.top = `${-pos.y}px`;

      const bounds = map.getBounds();
      const south = bounds.getSouth();
      const north = bounds.getNorth();
      const west = bounds.getWest();
      const east = bounds.getEast();

      // Pick step independently for lat and lon so highly-rectangular
      // viewports still get reasonable spacing on both axes.
      const latStep = niceStep(north - south, 6);
      const lonStep = niceStep(east - west, 6);
      const latDecimals = decimalsFor(latStep);
      const lonDecimals = decimalsFor(lonStep);
      const lats = ticksInRange(south, north, latStep);
      const lons = ticksInRange(west, east, lonStep);

      const project = (lat: number, lng: number) => map.latLngToContainerPoint([lat, lng]);

      const lineStroke = mode === 'zebra' ? 'rgba(0,0,0,0.65)' : 'rgba(40,40,40,0.75)';
      const lineWidth = 0.3;
      const haloStroke = 'rgba(255,255,255,0.6)';
      const haloWidth = 2.0;

      // ---- Grid lines (full-screen) — halo drawn first so dark line sits on top ----
      const addLine = (x1: number, y1: number, x2: number, y2: number) => {
        svg.appendChild(svgEl('line', {
          x1, y1, x2, y2,
          stroke: haloStroke, 'stroke-width': haloWidth,
          'shape-rendering': 'crispEdges',
        }));
        svg.appendChild(svgEl('line', {
          x1, y1, x2, y2,
          stroke: lineStroke, 'stroke-width': lineWidth,
          'shape-rendering': 'crispEdges',
        }));
      };

      for (const lat of lats) {
        const p1 = project(lat, west);
        const p2 = project(lat, east);
        addLine(p1.x, p1.y, p2.x, p2.y);
      }
      for (const lng of lons) {
        const p1 = project(south, lng);
        const p2 = project(north, lng);
        addLine(p1.x, p1.y, p2.x, p2.y);
      }

      const labelStyle = {
        'font-family': 'system-ui, sans-serif',
        'font-size': '11',
        fill: '#111',
      };
      const labelHaloStyle = {
        ...labelStyle,
        stroke: 'rgba(255,255,255,0.95)',
        'stroke-width': '3',
        'stroke-linejoin': 'round',
        'paint-order': 'stroke',
      } as Record<string, string>;

      const addLabel = (text: string, x: number, y: number, anchor: string, baseline: string) => {
        // Halo (drawn first, below).
        const halo = svgEl('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': baseline, ...labelHaloStyle });
        halo.textContent = text;
        svg.appendChild(halo);
        const fg = svgEl('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': baseline, ...labelStyle });
        fg.textContent = text;
        svg.appendChild(fg);
      };

      if (mode === 'zebra') {
        // ---- QGIS-style zebra border ----
        const W = 11; // border thickness in px
        const w = size.x;
        const h = size.y;

        // White backdrop frame. Drawn first so the alternating black ticks on
        // top read against a guaranteed white background — otherwise "black"
        // segments are invisible against a dark satellite basemap.
        svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: W, fill: '#fff' }));
        svg.appendChild(svgEl('rect', { x: 0, y: h - W, width: w, height: W, fill: '#fff' }));
        svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: h, fill: '#fff' }));
        svg.appendChild(svgEl('rect', { x: w - W, y: 0, width: W, height: h, fill: '#fff' }));

        // Build tick positions in pixel space.
        const xTicks = lons.map(l => ({ pos: project(south, l).x, label: fmtLon(l, lonDecimals) }))
          .filter(t => t.pos > W && t.pos < w - W);
        const yTicks = lats.map(l => ({ pos: project(l, west).y, label: fmtLat(l, latDecimals) }))
          .filter(t => t.pos > W && t.pos < h - W);

        const drawBlackTicks = (
          axis: 'x' | 'y',
          edge: 'start' | 'end',
          ticks: number[],
        ) => {
          const isX = axis === 'x';
          const length = isX ? w : h;
          const offset = edge === 'start' ? 0 : (isX ? h - W : w - W);
          // Sort ascending: in container coords, increasing latitude maps to
          // *decreasing* y, so the raw tick array isn't monotonic.
          const positions = [0, ...ticks, length].sort((p, q) => p - q);
          // Paint every other segment black on top of the white backdrop.
          for (let i = 0; i < positions.length - 1; i++) {
            if (i % 2 !== 0) continue;
            const a = positions[i];
            const b = positions[i + 1];
            svg.appendChild(svgEl('rect', {
              x: isX ? a : offset,
              y: isX ? offset : a,
              width: isX ? b - a : W,
              height: isX ? W : b - a,
              fill: '#000',
              'shape-rendering': 'crispEdges',
            }));
          }
        };

        drawBlackTicks('x', 'start', xTicks.map(t => t.pos));
        drawBlackTicks('x', 'end',   xTicks.map(t => t.pos));
        drawBlackTicks('y', 'start', yTicks.map(t => t.pos));
        drawBlackTicks('y', 'end',   yTicks.map(t => t.pos));

        // Inner + outer 1-px frames for crisp edges, drawn on top of the zebra.
        svg.appendChild(svgEl('rect', {
          x: W, y: W, width: w - 2 * W, height: h - 2 * W,
          fill: 'none', stroke: '#000', 'stroke-width': 1,
          'shape-rendering': 'crispEdges',
        }));
        svg.appendChild(svgEl('rect', {
          x: 0.5, y: 0.5, width: w - 1, height: h - 1,
          fill: 'none', stroke: '#000', 'stroke-width': 1,
          'shape-rendering': 'crispEdges',
        }));

        // Labels just inside the inner edge of the border (on the map),
        // relying on the white text halo for contrast — placing them on the
        // alternating zebra would clash on the black segments.
        for (const t of xTicks) {
          addLabel(t.label, t.pos, W + 10, 'middle', 'middle');
          addLabel(t.label, t.pos, h - W - 10, 'middle', 'middle');
        }
        for (const t of yTicks) {
          addLabel(t.label, W + 4, t.pos, 'start', 'middle');
          addLabel(t.label, w - W - 4, t.pos, 'end', 'middle');
        }
      } else {
        // ---- Plain mode: edge labels only ----
        for (const lng of lons) {
          const top = project(north, lng);
          if (top.x > 4 && top.x < size.x - 4) {
            addLabel(fmtLon(lng, lonDecimals), top.x, 12, 'middle', 'middle');
          }
        }
        for (const lat of lats) {
          const left = project(lat, west);
          if (left.y > 8 && left.y < size.y - 8) {
            addLabel(fmtLat(lat, latDecimals), 4, left.y, 'start', 'middle');
          }
        }
      }
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
