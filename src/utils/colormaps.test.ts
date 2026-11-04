import { describe, expect, it } from 'vitest';
import { baseColormap, COLORMAP_OPTIONS, colormapLabel, isInverted, withInvert } from './colormaps';

describe('colormaps', () => {
  it('keeps every colormap the old picker offered', () => {
    const values = COLORMAP_OPTIONS.map(o => o.value);
    for (const name of ['rdbu', 'twilight', 'cfastie', 'rplumbo', 'schwarzwald', 'viridis', 'bugn', 'ylgn', 'magma', 'gist_earth', 'ocean', 'terrain', 'gray', 'jet']) {
      expect(values).toContain(name);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('inverts with the _r suffix the tile server reads', () => {
    expect(withInvert('rdbu', true)).toBe('rdbu_r');
    expect(withInvert('rdbu_r', true)).toBe('rdbu_r');
    expect(withInvert('rdbu_r', false)).toBe('rdbu');
    expect(isInverted('rdbu_r')).toBe(true);
    expect(baseColormap('rdbu_r')).toBe('rdbu');
  });

  it('labels known and unknown colormaps', () => {
    expect(colormapLabel('gist_earth_r')).toBe('Earth');
    expect(colormapLabel('saved_elsewhere')).toBe('saved_elsewhere');
  });
});
