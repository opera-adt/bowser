/**
 * Tile request contract: the raster tilejson URL for every branch of the UI state.
 * Shared by the Leaflet layer and its MapLibre replacement; update on purpose with
 * `npx vitest run -u` and review the snapshot diff.
 */
import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
import { buildTileRequest, type TileState } from './tileParams';

const info = (over: Partial<RasterGroup> = {}): RasterGroup => ({
  name: 'displacement',
  file_list: ['a.tif', 'b.tif', 'c.tif'],
  mask_file_list: ['', 'mb.tif', ''],
  mask_min_value: 0.5,
  nodata: null,
  uses_spatial_ref: true,
  algorithm: 'shift',
  latlon_bounds: [-117.68, 33.95, -117.66, 33.97],
  x_values: ['2026-01-01', '2026-01-13', '2026-01-25'],
  available_mask_vars: ['temporal_coherence'],
  ...over,
});

const base: TileState = {
  complexMode: 'phase',
  wrapEnabled: false,
  wrapWavelength: null,
  wrapPeriod: 0.0277,
  refEnabled: false,
  refValues: {},
  refTimeIndex: {},
  dataMode: 'md',
  customMaskPath: null,
  layerMasks: [],
};

const req = (state: Partial<TileState> = {}, over: Partial<Parameters<typeof buildTileRequest>[0]> = {}) =>
  buildTileRequest({
    dataset: 'displacement', dsInfo: info(), timeIndex: 1, vmin: -0.02, vmax: 0.02,
    colormap: 'rdbu_r', state: { ...base, ...state }, datasetId: null, ...over,
  }).endpoint;

const cases: Record<string, string> = {
  md_shift_layer: req(),
  reference_point_shift: req({ refEnabled: true, refValues: { displacement: [0, 0.004, 0.008] } }),
  rewrap_by_period: req({ wrapEnabled: true }),
  rewrap_by_wavelength: req({ wrapEnabled: true, wrapWavelength: 0.0555 }),
  rewrap_with_reference: req({ wrapEnabled: true, refEnabled: true, refValues: { displacement: [0, 1, 2] } }),
  complex_phase: req({}, { dsInfo: info({ algorithm: 'phase' }) }),
  complex_amplitude: req({ complexMode: 'amplitude' }, { dsInfo: info({ algorithm: 'phase' }) }),
  complex_rewrap: req({ wrapEnabled: true }, { dsInfo: info({ algorithm: 'phase' }) }),
  no_algorithm: req({}, { dsInfo: info({ algorithm: null }) }),
  layer_masks: req({ layerMasks: [{ id: 'm', dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' }] }),
  md_custom_mask: req({ customMaskPath: '/tmp/mask.tif' }),
  cog_with_masks: req({ dataMode: 'cog', customMaskPath: '/tmp/mask.tif' }),
  catalog_dataset: req({}, { datasetId: 'prado-034-a-019' }),
  time_index_clamped_high: req({}, { timeIndex: 99 }),
  time_index_clamped_low: req({}, { timeIndex: -5 }),
};

describe('buildTileRequest', () => {
  it.each(['md', 'cog'])('requests explicit 256-pixel tiles in %s mode', (mode) => {
    const p = new URLSearchParams(req({ dataMode: mode }).split('?')[1]);
    expect(p.get('tilesize')).toBe('256');
  });

  it('matches the pinned request for every UI state', () => {
    expect(cases).toMatchSnapshot();
  });

  it('applies the reference shift for the clamped time step', () => {
    const p = new URLSearchParams(req({ refEnabled: true, refValues: { displacement: [0, 0.004, 0.008] } },
      { timeIndex: 7 }).split('?')[1]);
    expect(JSON.parse(p.get('algorithm_params')!)).toEqual({ shift: 0.008 });
    expect(p.get('time_idx')).toBe('2');
  });

  it('routes md and cog to their own tilers', () => {
    expect(req()).toMatch(/^\/md\/WebMercatorQuad\/tilejson\.json\?/);
    expect(req({ dataMode: 'cog' })).toMatch(/^\/cog\/WebMercatorQuad\/tilejson\.json\?/);
  });
});

describe('buildTileRequest relative to another date', () => {
  const params = (state: Partial<TileState>, over: Partial<Parameters<typeof buildTileRequest>[0]> = {}) =>
    new URLSearchParams(req(state, over).split('?')[1]);

  it('sends ref_time_idx for the chosen step, clamped', () => {
    expect(params({ refTimeIndex: { displacement: 0 } }).get('ref_time_idx')).toBe('0');
    expect(params({ refTimeIndex: { displacement: 9 } }).get('ref_time_idx')).toBe('2');
  });

  it('moves the reference point by the same difference', () => {
    const p = params({ refEnabled: true, refValues: { displacement: [0, 0.004, 0.009] }, refTimeIndex: { displacement: 2 } });
    expect(JSON.parse(p.get('algorithm_params')!).shift).toBeCloseTo(0.004 - 0.009);
  });

  it('leaves the request as it was without a choice, for other layers, other layer kinds and COG', () => {
    expect(params({}).has('ref_time_idx')).toBe(false);
    expect(params({ refTimeIndex: { velocity: 1 } }).has('ref_time_idx')).toBe(false);
    expect(params({ refTimeIndex: { displacement: 1 } }, { dsInfo: info({ uses_spatial_ref: false }) }).has('ref_time_idx')).toBe(false);
    expect(params({ refTimeIndex: { displacement: 1 }, dataMode: 'cog' }).has('ref_time_idx')).toBe(false);
  });

  it('leaves out the masks that cannot apply to the layer, so its map still draws', () => {
    const masks = [
      { id: 'r', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' as const },
      { id: 'c', dataset: 'temporal_coherence_min', threshold: 0.6, mode: 'min' as const },
    ];
    const sent = (dsInfo: RasterGroup) => new URLSearchParams(
      req({ layerMasks: masks }, { dataset: dsInfo.name, dsInfo }).split('?')[1]).get('layer_masks');
    // Displacement: both apply.
    const displacement = info({ mask_compatibility: { recommended_mask: null, temporal_coherence_min: null } });
    expect(JSON.parse(sent(displacement)!).map((m: { dataset: string }) => m.dataset))
      .toEqual(['recommended_mask', 'temporal_coherence_min']);
    // Velocity has no dates: the per-date recommended mask (on by default) is not sent.
    const velocity = info({ name: 'velocity', x_values: [], mask_compatibility: {
      recommended_mask: 'Dynamic mask requires matching acquisition coordinates', temporal_coherence_min: null } });
    expect(JSON.parse(sent(velocity)!)).toEqual([{ dataset: 'temporal_coherence_min', threshold: 0.6, mode: 'min' }]);
    // None applies: no layer_masks at all, not an empty list.
    const none = info({ name: 'velocity', x_values: [], mask_compatibility: { recommended_mask: 'no', temporal_coherence_min: 'no' } });
    expect(sent(none)).toBeNull();
    // A server that does not say (GeoTIFF mode, an older server): sent as before.
    expect(JSON.parse(sent(info())!)).toHaveLength(2);
  });
});
