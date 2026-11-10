import { describe, expect, it } from 'vitest';
import { refDateMarker, refMarkColor } from './refDate';

const data = [{ x: '2026-01-01' }, { x: '2026-01-13' }, { x: '2026-01-25' }];

describe('reference-date marker', () => {
  it('is black, or red on a black series', () => {
    expect(refMarkColor('#1f77b4')).toBe('#000000');
    expect(refMarkColor('#000000')).toBe('#e53935');
    expect(refMarkColor('#000')).toBe('#e53935');
  });

  it('marks only the point on the reference date, one size larger', () => {
    const m = refDateMarker(data, '2026-01-13', '#1f77b4', '#1f77b433', 4);
    expect(m.pointBorderColor).toEqual(['#1f77b4', '#000000', '#1f77b4']);
    expect(m.pointBackgroundColor).toEqual(['#1f77b433', '#000000', '#1f77b433']);
    expect(m.pointRadius).toEqual([4, 5, 4]);
  });

  it('marks a series drawn without markers too', () => {
    expect(refDateMarker(data, '2026-01-01', '#000000', '#00000033', 0).pointRadius).toEqual([4, 0, 0]);
  });

  it('adds nothing when the series has no point on that date', () => {
    expect(refDateMarker(data, '2025-12-01', '#1f77b4', '#1f77b4', 4)).toEqual({});
    expect(refDateMarker(data, null, '#1f77b4', '#1f77b4', 4)).toEqual({});
  });
});
