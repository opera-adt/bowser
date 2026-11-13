import type { LayerMask, RasterGroup } from '../types';

/** Server-derived compatibility, without guessing from layer names or counts. */
export function maskProblem(info: RasterGroup | undefined, name: string): string | null {
  if (!info?.mask_compatibility) return null; // Older/COG servers retain their own rules.
  return Object.prototype.hasOwnProperty.call(info.mask_compatibility, name)
    ? info.mask_compatibility[name] : 'Mask layer unavailable';
}

export function maskProblems(info: RasterGroup | undefined, masks: LayerMask[]): string[] {
  return masks.flatMap(m => {
    const reason = maskProblem(info, m.dataset);
    return reason ? [`${m.dataset}: ${reason}. Remove this mask or choose a compatible static summary.`] : [];
  });
}
