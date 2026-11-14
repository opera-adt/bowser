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
