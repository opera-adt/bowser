import { describe, expect, it } from 'vitest';
import { exportFilename } from './exportFilename';

describe('GeoTIFF server filenames', () => {
  it('uses actual server dates and masking rather than a browser index', () => {
    expect(exportFilename('attachment; filename="Displacement_20260101-20260201_masked.tif"', 'wrong'))
      .toBe('Displacement_20260101-20260201_masked.tif');
  });
  it('supports RFC 5987 filenames', () => {
    expect(exportFilename("attachment; filename*=UTF-8''Velocity%20map.tif", 'wrong')).toBe('Velocity-map.tif');
  });
  it.each([null, 'attachment; filename="../../private.tif"', 'attachment; filename="bad\n.tif"',
    "attachment; filename*=UTF-8''%ZZ", 'attachment; filename="image.exe"'])('safely handles %s', header => {
    expect(exportFilename(header, 'Velocity')).toBe('Velocity.tif');
  });
});

it('retains a safe GIF filename when explicitly requested, without accepting it as a numeric TIFF', () => {
  expect(exportFilename('attachment; filename="motion_20260101_20260125.gif"', 'motion', 'gif')).toBe('motion_20260101_20260125.gif');
  expect(exportFilename('attachment; filename="motion.gif"', 'motion')).toBe('motion.tif');
});
