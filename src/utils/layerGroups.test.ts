import { describe, expect, it } from 'vitest';
import { groupLayers, layerGroup } from './layerGroups';

describe('layerGroup', () => {
  it.each([
    ['displacement', 'Displacement'],
    ['short_wavelength_displacement', 'Displacement'],
    ['velocity', 'Displacement'],
    ['Re-wrapped phase', 'Displacement'],
    ['unwrappedPhase', 'Displacement'],
    ['alongTrackOffset', 'Displacement'],
    ['temporal_coherence', 'Quality'],
    ['coherenceMagnitude', 'Quality'],
    ['estimated_phase_quality', 'Quality'],
    ['connected_component_labels', 'Quality'],
    ['timeseries_inversion_residuals', 'Quality'],
    ['stack_amplitude_dispersion', 'Quality'],
    ['crlb_displacement', 'Quality'],
    ['shp_counts', 'Quality'],
    ['mean_amplitude_db', 'Amplitude'],
    ['Ionospheric Delay', 'Corrections'],
    ['ionospherePhaseScreenUncertainty', 'Corrections'],
    ['Solid Earth Tide', 'Corrections'],
    ['Perpendicular Baseline', 'Radar geometry'],
    ['incidence_angle', 'Radar geometry'],
    ['los_east', 'Radar geometry'],
    ['water_mask', 'Masks'],
    ['Persistent Scatterer Mask', 'Masks'],
    ['recommended_mask', 'Masks'],
    ['something_new', 'Other'],
  ])('%s is in %s', (name, group) => {
    expect(layerGroup(name)).toBe(group);
  });
});

describe('groupLayers', () => {
  it('keeps every layer, in display order, without empty groups', () => {
    const names = ['water_mask', 'temporal_coherence', 'velocity', 'something_new', 'displacement'];
    const groups = groupLayers(names);
    expect(groups.map(g => g.group)).toEqual(['Displacement', 'Quality', 'Masks', 'Other']);
    expect(groups[0].names).toEqual(['velocity', 'displacement']);
    expect(groups.flatMap(g => g.names).sort()).toEqual([...names].sort());
  });
});
