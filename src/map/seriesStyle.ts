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

/** How an area is drawn: its median line, the dashed mean, and the band. Stored on the area. */
export interface AreaStyle {
  /** Width of the median and mean lines, px. */
  lineWidth: number;
  /** The median's line (the mean is always dashed). */
  line: LineStyle;
  showMean: boolean;
  showBand: boolean;
  /** Band fill opacity, 0–1. */
  bandOpacity: number;
}

export const AREA_STYLE: AreaStyle = { lineWidth: 2, line: 'solid', showMean: true, showBand: true, bandOpacity: 0.2 };

/** An area's style with the defaults filled in. */
export function areaStyle(a: Partial<AreaStyle>): AreaStyle {
  return {
    lineWidth: a.lineWidth ?? AREA_STYLE.lineWidth,
    line: a.line ?? AREA_STYLE.line,
    showMean: a.showMean ?? AREA_STYLE.showMean,
    showBand: a.showBand ?? AREA_STYLE.showBand,
    bandOpacity: a.bandOpacity ?? AREA_STYLE.bandOpacity,
  };
}

/** A #rrggbb colour with an opacity, as #rrggbbaa. */
export function withOpacity(color: string, opacity: number): string {
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${a}` : color;
}
