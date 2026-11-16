import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
const layer = (name = 'displacement'): RasterGroup => ({ name, file_list: [], mask_file_list: [], mask_min_value: 0.5,
  nodata: null, uses_spatial_ref: false, algorithm: null, x_values: [], latlon_bounds: [0,0,1,1], available_mask_vars: [] });
const polygonState = () => ({ dataMode: 'md' as 'md' | 'cog', datasetInfo: { displacement: layer() } as Record<string,RasterGroup>, customMaskPath: null as string | null });
import { chartMaskOptions } from './chartMasks';

describe('chart mask options', () => {
  it('keeps unmasked requests unchanged and applies uploaded masks in both modes', () => {
    const state = polygonState();
    expect(chartMaskOptions(state, 'displacement')).toEqual({});
    state.customMaskPath = '/tmp/custom.tif';
    for (const dataMode of ['md', 'cog'] as const) {
      expect(chartMaskOptions({ ...state, dataMode }, 'displacement')).toEqual({ custom_mask_path: '/tmp/custom.tif' });
    }
  });

  it('uses each chart layer own configured primary mask and threshold', () => {
    const state = polygonState();
    state.dataMode = 'cog';
    state.datasetInfo.displacement.mask_file_list = ['primary.tif'];
    state.datasetInfo.displacement.mask_min_value = 0;
    state.datasetInfo.other = layer('other');
    expect(chartMaskOptions(state, 'displacement')).toEqual({ primary_mask: true, mask_min_value: 0 });
    expect(chartMaskOptions(state, 'other')).toEqual({});
    expect(chartMaskOptions({ ...state, dataMode: 'md' }, 'displacement')).toEqual({});
  });
});
