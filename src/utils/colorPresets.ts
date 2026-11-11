/**
 * The histogram's colour-range buttons (Main › Visualization: 2–98%, ±1σ, ±2σ, Full, ±0), as
 * pure functions shared by the buttons (components/Histogram.tsx) and the Assistant's
 * set_color_range, so both set exactly the same range.
 */
import { withDataset } from '../hooks/useApi';

export interface HistogramData {
  bins: number[];
  counts: number[];
  min: number;
  max: number;
  p2: number;
  p98: number;
  p16: number;
  p84: number;
  p23: number;
  p977: number;
}

export type RangePreset = '2-98%' | '1sigma' | '2sigma' | 'full' | 'symmetric';
export const RANGE_PRESETS: RangePreset[] = ['2-98%', '1sigma', '2sigma', 'full', 'symmetric'];

const r4 = (v: number) => parseFloat(v.toFixed(4));

/**
 * The range a button sets, or null when the histogram lacks what it needs.
 * 2-98%: 2nd–98th percentile; 1sigma: 16th–84th (±1σ); 2sigma: 2.3rd–97.7th (±2σ);
 * full: min–max; symmetric (±0): ±max(|vmin|, |vmax|) of the current range.
 */
export function presetRange(
  preset: RangePreset, hist: HistogramData | null, vmin: number, vmax: number,
): [number, number] | null {
  if (preset === 'symmetric') {
    const m = r4(Math.max(Math.abs(vmin), Math.abs(vmax)));
    return [-m, m];
  }
  if (!hist) return null;
  const pair: Record<Exclude<RangePreset, 'symmetric'>, [number | undefined, number | undefined]> = {
    '2-98%': [hist.p2, hist.p98],
    '1sigma': [hist.p16, hist.p84],
    '2sigma': [hist.p23, hist.p977],
    full: [hist.min, hist.max],
  };
  const [lo, hi] = pair[preset];
  if (lo == null || hi == null) return null;
  return [r4(lo), r4(hi)];
}

// Module-level cache: persists for the lifetime of the page, shared across remounts.
// Key = "dataset:timeIndex". Avoids re-fetching histograms the user has already seen when
// scrubbing the time slider back and forth.
const histogramCache = new Map<string, HistogramData>();

export function cachedHistogram(dataset: string, timeIndex: number): HistogramData | undefined {
  return histogramCache.get(`${dataset}:${timeIndex}`);
}

/** The layer's histogram at a date (GET /histogram), cached. */
export async function fetchHistogram(dataset: string, timeIndex: number, signal?: AbortSignal): Promise<HistogramData | null> {
  const key = `${dataset}:${timeIndex}`;
  const hit = histogramCache.get(key);
  if (hit) return hit;
  const params = withDataset(new URLSearchParams({ time_index: String(timeIndex) }));
  const res = await fetch(`/histogram/${encodeURIComponent(dataset)}?${params}`, { signal });
  if (!res.ok) return null;
  const data = await res.json() as HistogramData;
  histogramCache.set(key, data);
  return data;
}
