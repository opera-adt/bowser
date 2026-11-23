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
    return reason ? [`${m.dataset} is not applied to this layer: ${reason}.`] : [];
  });
}

/**
 * The masks that can apply to a layer. The others are not sent with its requests: the server
 * refuses a mask it cannot match to the layer's dates, and a mask that fits one layer (the
 * default ``recommended_mask`` on displacement) would otherwise blank the map, the charts and
 * the exports of the next layer selected. The Masking panel says which are left out.
 */
export function applicableMasks(info: RasterGroup | undefined, masks: LayerMask[]): LayerMask[] {
  return masks.filter(m => !maskProblem(info, m.dataset));
}

/**
 * How many dates of ``mask`` the server combines for ``info``: a dated mask on a layer without
 * dates (a velocity, a coherence summary) keeps a pixel only where it passes on every date.
 * 0 when the mask applies as it is (a single map, or date by date on a dated layer).
 */
export function combinedDates(info: RasterGroup | undefined, mask: RasterGroup | undefined): number {
  const dates = (layer: RasterGroup | undefined) => layer?.x_values?.length ?? 0;
  return info && dates(info) <= 1 && dates(mask) > 1 ? dates(mask) : 0;
}
