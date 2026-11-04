import { describe, expect, it } from 'vitest';
import { categoricalColor, classColorExpression, MAX_CLASSES, OTHER_COLOR, soilColoring } from './soilClasses';

const feats = (field: string, values: unknown[]) => values.map(v => ({ properties: { [field]: v } }));

describe('soilColoring', () => {
  it('keeps the InSAR classes by default', () => {
    expect(soilColoring([], 'class', 5).legend?.map(([l]) => l)).toEqual(['Organic (peat, muck)', 'Expansive clay', 'Wet (hydric)', 'Other soil']);
  });

  it('shows the most common values, the rest as Other', () => {
    const f = feats('order', ['Alfisols', 'Alfisols', 'Alfisols', 'Inceptisols', 'Inceptisols', 'Vertisols', 'Entisols']);
    const all = soilColoring(f, 'order', 6);
    expect(all.classColors?.classes.map(([l]) => l)).toEqual(['Alfisols', 'Inceptisols', 'Vertisols', 'Entisols']);
    const two = soilColoring(f, 'order', 2);
    expect(two.classColors?.classes.map(([l]) => l)).toEqual(['Alfisols']);
    expect(two.legend?.[two.legend.length - 1]).toEqual(['Other (3 more)', OTHER_COLOR]);
  });

  it('gives each value its own class when there are few', () => {
    const c = soilColoring(feats('hydric_pct', [0, 0, 0, 0, 0, 100, 100, null]), 'hydric_pct', 6).classColors!;
    expect(c.classes.map(([l]) => l)).toEqual(['0', '100']);
    expect(c.breaks).toEqual([100]);
  });

  it('falls back to equal steps when ties collapse the quantiles', () => {
    const c = soilColoring(feats('lep', [0, 0, 0, 0, 0, 0, 0, 3, 6, 9]), 'shrink_swell_lep_pct' as never, 3).classColors;
    expect(c?.property).toBe('shrink_swell_lep_pct');
    const d = soilColoring(feats('shrink_swell_lep_pct', [0, 0, 0, 0, 0, 0, 0, 3, 6, 9]), 'shrink_swell_lep_pct', 3).classColors!;
    expect(d.breaks).toEqual([3, 6]);
    expect(d.classes.map(([l]) => l)).toEqual(['0–3', '3–6', '6–9']);
  });

  it('bins numbers by quantile, with no data apart', () => {
    const f = feats('hydric_pct', [0, 0, 5, 10, 20, 40, 60, 80, 100, null]);
    const c = soilColoring(f, 'hydric_pct', 4).classColors!;
    // nine values with data, four classes: breaks at the 25th, 50th and 75th percentiles
    expect(c.breaks).toEqual([5, 20, 60]);
    expect(c.classes.map(([l]) => l)).toEqual(['0–5', '5–20', '20–60', '60–100']);
  });
});

describe('classColorExpression', () => {
  it('matches text classes and steps numeric ones', () => {
    expect(classColorExpression({ property: 'order', classes: [['Alfisols', '#111111']] }, '#999999'))
      .toEqual(['match', ['to-string', ['get', 'order']], 'Alfisols', '#111111', '#999999']);
    const e = classColorExpression({ property: 'h', classes: [['a', '#1'], ['b', '#2']], breaks: [10], other: '#0' }, '#9') as unknown[];
    expect(e[0]).toBe('case');
    expect(e[2]).toEqual(['step', ['to-number', ['get', 'h']], '#1', 10, '#2']);
    expect(e[3]).toBe('#0');
  });
});

describe('many classes', () => {
  it('shows up to 60 classes, each with its own colour', () => {
    const values = Array.from({ length: 80 }, (_, i) => `unit ${i}`);
    const c = soilColoring(feats('map_unit', values), 'map_unit', 100).classColors!;
    expect(c.classes).toHaveLength(MAX_CLASSES - 1);  // and "Other (21 more)"
    expect(new Set(c.classes.map(([, color]) => color)).size).toBe(c.classes.length);
    expect(categoricalColor(0)).toBe('#1f77b4');
    expect(categoricalColor(30)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gives numeric classes distinct shades too', () => {
    const vals = Array.from({ length: 200 }, (_, i) => i);
    const c = soilColoring(feats('organic_matter_pct', vals), 'organic_matter_pct', 20).classColors!;
    expect(c.classes).toHaveLength(20);
    expect(new Set(c.classes.map(([, color]) => color)).size).toBe(20);
  });
});
