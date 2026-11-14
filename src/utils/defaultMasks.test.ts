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


it('does not default to a time mask on a static layer', () => {
  const velocity = { mask_compatibility: { recommended_mask: 'Dynamic mask cannot apply to static layer' } } as unknown as RasterGroup;
  expect(defaultMasks({ velocity, recommended_mask: layer }, 'velocity')).toEqual([]);
});
