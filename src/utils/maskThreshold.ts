/**
 * Helpers for a layer mask's threshold: its default for a layer, and how much of
 * the layer a threshold keeps (from the layer's histogram).
 */
import type { HistogramData } from './colorPresets';

export interface ValueRange { min: number; max: number; p2?: number; p98?: number }

/** True for a layer of 0/1 flags (a recommended, water or scatterer mask): nothing between the two. */
function isFlags(range: ValueRange): boolean {
  const ends = (v: number | undefined) => v === 0 || v === 1;
  return range.min === 0 && range.max === 1 && ends(range.p2) && ends(range.p98);
}

/**
 * A mask's first threshold on a layer: the low end of its range for "≥" (keeps
 * everything, so the user tightens it), the high end for "≤". In the layer's units.
 * A layer of 0/1 flags starts at 0.5: at either end it would keep every pixel and mask nothing.
 */
export function defaultThreshold(range: ValueRange, mode: 'min' | 'max'): number {
  if (isFlags(range)) return 0.5;
  return mode === 'max' ? (range.p98 ?? range.max) : (range.p2 ?? range.min);
}

/**
 * The share (0–1) of the layer's valid pixels a threshold keeps: values ≥ threshold
 * for ``min``, ≤ threshold for ``max``. A bin the threshold cuts counts by the part
 * on the kept side. Null without a histogram.
 */
export function keptFraction(hist: HistogramData | null | undefined, threshold: number, mode: 'min' | 'max'): number | null {
  if (!hist || !hist.counts.length || hist.bins.length !== hist.counts.length + 1) return null;
  const total = hist.counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let below = 0;   // pixels with a value < threshold
  for (let i = 0; i < hist.counts.length; i++) {
    const lo = hist.bins[i];
    const hi = hist.bins[i + 1];
    if (threshold >= hi) below += hist.counts[i];
    else if (threshold > lo) below += hist.counts[i] * ((threshold - lo) / (hi - lo));
  }
  const share = mode === 'max' ? below / total : 1 - below / total;
  return Math.min(1, Math.max(0, share));
}

/** "63%", "<1%" or ">99%": a kept share for the mask row. */
export function keptLabel(share: number): string {
  if (share > 0 && share < 0.01) return '<1%';
  if (share < 1 && share > 0.99) return '>99%';
  return `${Math.round(share * 100)}%`;
}
