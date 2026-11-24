import { describe, expect, it } from 'vitest';
import { hasProjectWork } from './project';
import type { AppState, LayerMask, RasterGroup } from '../types';

const layers = { displacement: {}, recommended_mask: {} } as unknown as { [key: string]: RasterGroup };
const base = {
  timeSeriesPoints: [], chartAreas: [], annotations: [], overlays: [], layerMasks: [] as LayerMask[],
  customMaskPath: null, datasetInfo: layers,
} as unknown as AppState;
const RECOMMENDED: LayerMask = { id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' };

describe('work a reload would lose', () => {
  it('is none on a fresh page, even with the mask every cube starts with', () => {
    expect(hasProjectWork(base)).toBe(false);
    expect(hasProjectWork({ ...base, layerMasks: [RECOMMENDED] })).toBe(false);
  });
  it('counts a changed or added mask, an uploaded mask, points and overlays', () => {
    expect(hasProjectWork({ ...base, layerMasks: [{ ...RECOMMENDED, threshold: 0.8 }] })).toBe(true);
    expect(hasProjectWork({ ...base, layerMasks: [RECOMMENDED, { ...RECOMMENDED, id: 'm2', dataset: 'water_mask' }] })).toBe(true);
    expect(hasProjectWork({ ...base, customMaskPath: 'mask.tif' })).toBe(true);
    expect(hasProjectWork({ ...base, timeSeriesPoints: [{}] } as unknown as AppState)).toBe(true);
    expect(hasProjectWork({ ...base, overlays: [{}] } as unknown as AppState)).toBe(true);
  });
});
