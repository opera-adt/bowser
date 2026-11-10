/**
 * The time-series chart as the Assistant's chart tools read and change it (./chartTools.ts):
 * each chart window registers a handle (TimeSeriesChart.tsx), so the tools see exactly what the
 * chart draws (the Chart.js datasets it hands to <Line>, with each series tagged) and reach the
 * chart's own controls whose state lives in the component (Display options, the export buttons).
 */
import type { FitResult } from '../map/fit';
import type { FitSettings } from '../map/fitSettings';
import type { DisplayUnit } from '../utils/units';

/** Which series a Chart.js dataset draws, and which part of it (set as ``_series`` on the dataset). */
export interface SeriesTag {
  kind: 'point' | 'area';
  /** The point's or area's id. */
  id: string;
  name: string;
  layer: string;
  /** data: a point's values; model / residual: its fitted model and residuals; median / sample: a
   *  point in buffer mode; area_median, area_mean, band_upper, band_lower: an area. */
  role: 'data' | 'model' | 'residual' | 'median' | 'sample'
    | 'area_median' | 'area_mean' | 'band_upper' | 'band_lower';
}

/** A layer's Display options: offset, y limits (null = auto) and colour (null = the series' own). */
export interface LayerDisplay {
  offset: number;
  ymin: number | null;
  ymax: number | null;
  color: string | null;
}

export interface ChartSnapshot {
  /** ready: the datasets are drawn; loading: data is on its way; empty: nothing to draw (why in ``message``). */
  status: 'ready' | 'loading' | 'empty';
  message?: string;
  /** The layers in the chart, one y axis each (y0 first, on the left). */
  layers: string[];
  /** Exactly what the chart draws (Chart.js datasets; ``_series`` says which series each is). */
  datasets: Array<Record<string, unknown> & { _series?: SeriesTag }>;
  /** The fitted model per point series, keyed ``layer::pointId``, with the values it was fitted to. */
  fits: Record<string, { fit: FitResult | null; points: { x: string; y: number }[] }>;
  fitSettings: FitSettings;
  showTrends: boolean;
  showResiduals: boolean;
  /** The date range shown: chosen (null = all) and the dates the chart has. */
  dateRange: { start: string | null; end: string | null; first: string | null; last: string | null };
  /** Per layer: the reference date the values are relative to (chosen or as stored). */
  referenceDates: Record<string, string | null>;
  units: Record<string, DisplayUnit>;
  display: Record<string, LayerDisplay>;
}

export interface ChartHandle {
  windowId: string;
  snapshot: () => ChartSnapshot | null;
  /** As the Display options row of ``layer``: offset, y min/max (null = auto) and colour (null = reset). */
  setLayerDisplay: (layer: string, patch: Partial<LayerDisplay>) => void;
  /** Click the Export CSV / Save as PNG buttons; false when there is nothing to export. */
  exportCsv: () => boolean;
  exportPng: () => boolean;
}

/** The chart tools (./chartTools.ts), here so that pageTools.ts can list them without an import cycle at load. */
export const CHART_TOOL_NAMES = new Set([
  'get_chart_data', 'get_fit_results', 'set_fit', 'add_step', 'remove_step', 'set_residuals',
  'list_points', 'rename_point', 'remove_point', 'set_point_style',
  'list_areas', 'rename_area', 'set_area_style', 'set_area_band',
  'set_chart_layers', 'set_layer_display', 'set_date_range', 'export_chart', 'check_series',
]);

const charts = new Map<string, ChartHandle>();

/** Register a chart window; returns the function that unregisters it. */
export function registerChart(handle: ChartHandle): () => void {
  charts.set(handle.windowId, handle);
  return () => { if (charts.get(handle.windowId) === handle) charts.delete(handle.windowId); };
}

/** The chart window ``windowId``, or the first one open. */
export function getChart(windowId?: string): ChartHandle | null {
  if (windowId) return charts.get(windowId) ?? null;
  return charts.values().next().value ?? null;
}
