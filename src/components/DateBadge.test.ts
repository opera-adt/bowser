import { describe, expect, it } from 'vitest';
import { dateLabel } from './DateBadge';

describe('dateLabel', () => {
  it('shows dates, date pairs and other steps as they read best', () => {
    expect(dateLabel('2016-07-26')).toBe('2016-07-26');
    expect(dateLabel('2016-07-26T00:00:00')).toBe('2016-07-26');
    expect(dateLabel('2016-07-14_2016-07-26')).toBe('2016-07-14 → 2016-07-26');
    expect(dateLabel(12)).toBe('12');
  });
});
