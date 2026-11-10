/**
 * Showing a layer relative to another date (Main › Layers › ref): value(t) − value(t_ref), per
 * pixel on the map (the tiler's ``ref_time_idx``) and per series in the chart (here).
 */
import type { MultiPointTimeSeriesData, RasterGroup } from '../types';
import { dateLabel } from '../components/DateBadge';
import { clampTimeIndex } from './timeStep';

/** Displacement-like layers with a time axis: the ones the spatial reference applies to. */
export function canReReference(info: RasterGroup | null | undefined): info is RasterGroup {
  return !!info?.uses_spatial_ref && info.x_values.length > 1;
}

/**
 * The time step a layer is shown relative to, or null when it is shown as stored: nothing chosen,
 * not a displacement-like layer, or COG mode (whose tiler has no ``ref_time_idx``).
 */
export function activeRefTime(info: RasterGroup | null | undefined, chosen: number | undefined, dataMode: string): number | null {
  if (chosen === undefined || dataMode !== 'md' || !canReReference(info)) return null;
  return clampTimeIndex(chosen, info.x_values.length);
}

/** The date a time step is relative to: the date itself, or a pair's secondary date. */
export function refDateLabel(value: unknown): string {
  const s = String(value ?? '');
  const pair = s.split('_');
  if (pair.length === 2 && pair.every(p => /^\d{4}-?\d{2}-?\d{2}/.test(p))) return pair[1].slice(0, 10);
  return dateLabel(s);
}

/** A series minus its value at ``refX``; empty when it has no value there (NaN − anything). */
export function relativeTo<T extends { x: unknown; y: number }>(data: T[], refX: unknown): T[] {
  const ref = data.find(p => String(p.x) === String(refX));
  if (!ref || !Number.isFinite(ref.y)) return [];
  return data.map(p => ({ ...p, y: p.y - ref.y }));
}

/** Every series of each re-referenced layer minus its own value at that layer's reference step. */
export function relativeChartData(
  map: { [ds: string]: MultiPointTimeSeriesData },
  refX: { [ds: string]: unknown },
): { [ds: string]: MultiPointTimeSeriesData } {
  const out: { [ds: string]: MultiPointTimeSeriesData } = {};
  for (const [ds, cd] of Object.entries(map)) {
    out[ds] = ds in refX
      ? { ...cd, datasets: cd.datasets.map(d => ({ ...d, data: relativeTo(d.data, refX[ds]) })) }
      : cd;
  }
  return out;
}
