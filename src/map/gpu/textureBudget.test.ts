import { describe, expect, it } from 'vitest';
import { evictionPlan, parseBudgetOverride, positionOf, textureBudgetBytes, type BudgetEntry } from './textureBudget';

const MB = 1024 * 1024;
const e = (lastUsed: number, bytes = 10, state = 'ready'): BudgetEntry => ({ state, bytes, lastUsed });

describe('evictionPlan', () => {
  it('evicts nothing within the budget', () => {
    expect(evictionPlan([['0|d|0|0|0|h', e(1)]], 10, 10, new Set(), new Set())).toEqual([]);
  });

  it('drops chunks away from the view before older ones of other dates in view, down to 80%', () => {
    const entries: [string, BudgetEntry][] = [
      ['0|d|0|1|1|h', e(1)],     // in view, old date block, oldest of all
      ['0|d|0|9|9|h', e(5)],     // panned away
      ['1|d|3|1|1|h', e(4)],     // another level
      ['0|d|3|1|1|h', e(9)],     // drawn now
      ['0|d|2|1|1|h', e(2)],     // in view, older date block
    ];
    const plan = evictionPlan(entries, 50, 40, new Set(['0|d|3|1|1|h']), new Set(['0|1|1']));
    // 50 -> 30 bytes (<= 80% of 40): the two away from the view, oldest first.
    expect(plan).toEqual(['1|d|3|1|1|h', '0|d|0|9|9|h']);
    // A smaller budget then takes the oldest date block in view.
    const more = evictionPlan(entries, 50, 30, new Set(['0|d|3|1|1|h']), new Set(['0|1|1']));
    expect(more).toEqual(['1|d|3|1|1|h', '0|d|0|9|9|h', '0|d|0|1|1|h']);
  });

  it('never drops what the frame draws, nor chunks still loading', () => {
    const entries: [string, BudgetEntry][] = [['0|d|0|0|0|h', e(1)], ['0|d|1|0|0|h', e(2, 10, 'decoded')]];
    expect(evictionPlan(entries, 100, 10, new Set(['0|d|0|0|0|h']), new Set())).toEqual([]);
  });

  it('keeps memory bounded while playing through every date of a large cube', () => {
    // 34 date blocks x 40 chunks in view, 1 MB each, 16 MB budget: what the frame
    // draws (40 MB) can exceed the budget, but nothing else stays.
    const tex = new Map<string, BudgetEntry>();
    let total = 0, peak = 0, clock = 0;
    const view = new Set<string>();
    for (let i = 0; i < 40; i++) view.add(`0|0|${i}`);
    for (let tb = 0; tb < 34; tb++) {
      const keep = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const k = `0|d|${tb}|0|${i}|h`;
        keep.add(k);
        tex.set(k, e(++clock, MB));
        total += MB;
        // The next block's prefetch, as the layer does.
        const p = `0|d|${tb + 1}|0|${i}|h`;
        if (!tex.has(p)) { tex.set(p, e(++clock, MB)); total += MB; }
      }
      for (const k of evictionPlan(tex, total, 16 * MB, keep, view)) { total -= tex.get(k)!.bytes; tex.delete(k); }
      peak = Math.max(peak, total);
    }
    expect(peak).toBeLessThanOrEqual(40 * MB + 16 * MB);
    expect(tex.size).toBeLessThanOrEqual(56);
  });

  it('reads level, row and column from a key', () => {
    expect(positionOf('2|displacement|7|3|4|h')).toBe('2|3|4');
  });
});

describe('textureBudgetBytes', () => {
  it('follows device memory between 128 and 768 MB, else 384 MB', () => {
    expect(textureBudgetBytes(null, 8)).toBe(768 * MB);
    expect(textureBudgetBytes(null, 4)).toBe(384 * MB);
    expect(textureBudgetBytes(null, 2)).toBe(192 * MB);
    expect(textureBudgetBytes(null, 0.5)).toBe(128 * MB);
    expect(textureBudgetBytes(null, undefined)).toBe(384 * MB);
  });

  it('takes ?gpu_mb= (clamped to 64..2048 MB)', () => {
    expect(parseBudgetOverride('?render=gpu&gpu_mb=200')).toBe(200);
    expect(parseBudgetOverride('?gpu_mb=lots')).toBeNull();
    expect(parseBudgetOverride('?gpu_mb=')).toBeNull();
    expect(parseBudgetOverride('')).toBeNull();
    expect(textureBudgetBytes(200, 8)).toBe(200 * MB);
    expect(textureBudgetBytes(1, 8)).toBe(64 * MB);
    expect(textureBudgetBytes(1e9, 8)).toBe(2048 * MB);
  });
});
