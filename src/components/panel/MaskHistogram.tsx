import { useEffect, useState } from 'react';
import { cachedHistogram, fetchHistogram, type HistogramData } from '../../utils/colorPresets';
import { keptFraction, keptLabel } from '../../utils/maskThreshold';

/** Wait this long after the last change before asking for the histogram. */
const DEBOUNCE_MS = 250;
const HEIGHT = 22;

interface Props {
  /** The mask's layer. */
  dataset: string;
  threshold: number;
  mode: 'min' | 'max';
  /** The date the mask is read at (0 for a layer without dates). */
  timeIndex: number;
  /** The slider's ends, so the drawing lines up with it. */
  lo: number;
  hi: number;
  /** Do not ask while the dates play. */
  paused?: boolean;
}

/**
 * Under a mask's slider: the layer's values between the slider's ends, the part the
 * threshold keeps in the accent colour, and how much of the layer that is.
 */
export default function MaskHistogram({ dataset, threshold, mode, timeIndex, lo, hi, paused }: Props) {
  const [hist, setHist] = useState<HistogramData | null>(() => cachedHistogram(dataset, timeIndex) ?? null);
  const [of, setOf] = useState(dataset);

  useEffect(() => {
    const cached = cachedHistogram(dataset, timeIndex);
    if (cached) { setHist(cached); setOf(dataset); return; }
    if (paused) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchHistogram(dataset, timeIndex, controller.signal)
        .then(h => { if (!controller.signal.aborted) { setHist(h); setOf(dataset); } })
        .catch(() => { /* aborted, or no histogram: the row works without it */ });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [dataset, timeIndex, paused]);

  // The previous layer's histogram says nothing about this one.
  if (!hist || of !== dataset || !(hi > lo)) return null;
  const share = keptFraction(hist, threshold, mode);
  if (share === null) return null;

  const peak = Math.max(...hist.counts, 1);
  const x = (v: number) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const kept = (a: number, b: number) => (mode === 'min' ? (a + b) / 2 >= threshold : (a + b) / 2 <= threshold);
  const bars = hist.counts.map((count, i) => {
    const a = hist.bins[i];
    const b = hist.bins[i + 1];
    if (b <= lo || a >= hi || !count) return null;
    const h = Math.max(1, (count / peak) * HEIGHT);
    return (
      <rect key={i} x={x(a)} width={Math.max(0.3, x(b) - x(a))} y={HEIGHT - h} height={h}
        fill={kept(a, b) ? 'var(--sb-accent)' : 'var(--sb-border)'} />
    );
  });

  return (
    <div className="mask-histogram" data-testid="mask-histogram">
      <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" width="100%" height={HEIGHT} aria-hidden="true">
        {bars}
        <line x1={x(threshold)} x2={x(threshold)} y1={0} y2={HEIGHT} stroke="var(--sb-text)" strokeWidth={0.6} />
      </svg>
      <div className="row-label" style={{ fontSize: '0.7em' }} role="status">
        Keeps {keptLabel(share)} of this layer's pixels
      </div>
    </div>
  );
}
