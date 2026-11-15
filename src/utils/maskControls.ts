import type { LayerMaskMode } from '../types';

export const MASK_MODES: readonly LayerMaskMode[] = ['min', 'max', 'abs_min', 'abs_max'];
export interface MaskRange { min: number; max: number; p2?: number; p98?: number }
export const absoluteMask = (mode: LayerMaskMode): boolean => mode.startsWith('abs_');

/** Signed controls retain percentile limits; magnitudes start at zero. */
export function maskControlRange(range: MaskRange | undefined, mode: LayerMaskMode): [number, number] {
  if (absoluteMask(mode)) {
    const ends = [range?.min, range?.max].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return [0, ends.length ? Math.max(...ends.map(Math.abs)) : 1];
  }
  return [range?.p2 ?? range?.min ?? 0, range?.p98 ?? range?.max ?? 1];
}

export function maskDefaultThreshold(range: MaskRange | undefined, mode: LayerMaskMode, fallback = 0.5): number {
  if (!range) return absoluteMask(mode) ? Math.abs(fallback) : fallback;
  const [min, max] = maskControlRange(range, mode);
  return mode === 'max' || mode === 'abs_max' ? max : min;
}

/** Project files may predate explicit modes; missing mode retains legacy min. */
export function validMaskMode(mode: unknown, threshold: number): boolean {
  if (mode === undefined) return true;
  return MASK_MODES.includes(mode as LayerMaskMode)
    && (!String(mode).startsWith('abs_') || threshold >= 0);
}
