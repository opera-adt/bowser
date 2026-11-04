import type { LayerMask, RasterGroup } from '../types';

/** Masks a cube starts with: its recommended mask (1 = use the pixel), when it has one. */
export function defaultMasks(layers: { [key: string]: RasterGroup }): LayerMask[] {
  return 'recommended_mask' in layers
    ? [{ id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }]
    : [];
}
