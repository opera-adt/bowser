/**
 * How a time-series point is drawn in the chart: its colour (shared with its map marker),
 * marker shape and line. Stored on the point, so a saved project keeps it.
 */
export const MARKERS = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'none'] as const;
export type MarkerShape = (typeof MARKERS)[number];

export const LINES = ['solid', 'dashed', 'none'] as const;
export type LineStyle = (typeof LINES)[number];

/** Chart.js names for the marker shapes. */
const POINT_STYLE: Record<MarkerShape, string> = {
  circle: 'circle', square: 'rect', triangle: 'triangle', diamond: 'rectRot', star: 'star', cross: 'crossRot', none: 'circle',
};

/** The Chart.js dataset fields for a series' marker and line ("none" for both draws nothing, so the line stays). */
export function seriesStyle(marker: MarkerShape = 'circle', line: LineStyle = 'solid', size: number) {
  const noMarker = marker === 'none' && line !== 'none';
  return {
    pointStyle: POINT_STYLE[marker],
    pointRadius: noMarker ? 0 : size,
    pointHoverRadius: noMarker ? 3 : size + 2,
    showLine: line !== 'none',
    borderDash: line === 'dashed' ? [6, 4] : [],
    // Shapes drawn as strokes (star, cross) need a line width to show; filled shapes keep a thin edge.
    pointBorderWidth: marker === 'star' || marker === 'cross' ? 2 : 1,
  };
}
