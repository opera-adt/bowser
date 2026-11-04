/**
 * Marker shapes for vector point layers (ported from the OPERA DISP portal's style tools):
 * each shape is drawn once as a signed-distance-field image, which MapLibre recolours with
 * icon-color, so one image serves every layer colour.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

export const POINT_MARKERS = ['circle', 'square', 'triangle', 'diamond', 'star', 'pin'] as const;
export type PointMarker = (typeof POINT_MARKERS)[number];

/** The image is 48 px at pixel ratio 2; its shape's radius is this many CSS px at icon-size 1. */
export const MARKER_IMAGE_RADIUS = (48 * 0.36) / 2;

export const markerImageId = (shape: PointMarker) => `bowser-marker-${shape}`;

function markerImage(shape: PointMarker, size = 48): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const m = size / 2;
  const r = size * 0.36;
  g.fillStyle = '#000';
  g.beginPath();
  const poly = (pts: [number, number][]) => {
    g.moveTo(m + pts[0][0] * r, m + pts[0][1] * r);
    for (const [x, y] of pts.slice(1)) g.lineTo(m + x * r, m + y * r);
    g.closePath();
  };
  if (shape === 'circle') g.arc(m, m, r, 0, Math.PI * 2);
  else if (shape === 'square') poly([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]);
  else if (shape === 'triangle') poly([[0, -1], [0.95, 0.75], [-0.95, 0.75]]);
  else if (shape === 'diamond') poly([[0, -1.05], [0.8, 0], [0, 1.05], [-0.8, 0]]);
  else if (shape === 'star') poly(Array.from({ length: 10 }, (_, k) => {
    const a = (k * Math.PI) / 5 - Math.PI / 2;
    const rr = k % 2 ? 0.45 : 1.05;
    return [Math.cos(a) * rr, Math.sin(a) * rr] as [number, number];
  }));
  else {
    // pin: a round head with a point below
    g.arc(m, m - r * 0.35, r * 0.72, Math.PI * 0.85, Math.PI * 2.15);
    g.lineTo(m, m + r * 1.05);
    g.closePath();
  }
  g.fill();
  return g.getImageData(0, 0, size, size);
}

/** Add the shape's image to the map if it isn't there yet; returns its image id. */
export function ensureMarker(map: MapLibreMap, shape: PointMarker): string {
  const id = markerImageId(shape);
  if (!map.hasImage(id)) map.addImage(id, markerImage(shape), { sdf: true, pixelRatio: 2 });
  return id;
}
