import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
import { defaultMasks } from './defaultMasks';

const layer = {} as RasterGroup;

describe('defaultMasks', () => {
  it('keeps pixels where the recommended mask is 1', () => {
    expect(defaultMasks({ displacement: layer, recommended_mask: layer })).toEqual([
      { id: 'mask_recommended', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' },
    ]);
  });

  it('adds nothing to a cube without one', () => {
    expect(defaultMasks({ displacement: layer, temporal_coherence: layer })).toEqual([]);
  });
});
