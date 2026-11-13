import { maskProblem } from './maskCompatibility';
import type { LayerMask, RasterGroup } from '../types';

/** Masks a cube starts with: its recommended mask (1 = use the pixel), when it has one. */
export function defaultMasks(layers: { [key: string]: RasterGroup }, variable?: string): LayerMask[] {
  const target = variable ?? ('displacement' in layers ? 'displacement' : Object.keys(layers)[0]);
  return 'recommended_mask' in layers && !maskProblem(layers[target], 'recommended_mask')
    ? [{ id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }]
    : [];
}
