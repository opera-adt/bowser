import { describe, expect, it } from 'vitest';
import { LAYER_INFO_KEY, readLayerInfoShown, saveLayerInfoShown } from './layerInfoPref';

describe('layer description preference', () => {
  it('is shown until the viewer hides it, and remembers the choice', () => {
    expect(readLayerInfoShown()).toBe(true);
    saveLayerInfoShown(false);
    expect(localStorage.getItem(LAYER_INFO_KEY)).toBe('hidden');
    expect(readLayerInfoShown()).toBe(false);
    saveLayerInfoShown(true);
    expect(localStorage.getItem(LAYER_INFO_KEY)).toBeNull();
    expect(readLayerInfoShown()).toBe(true);
  });

  it('falls back to shown when storage throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true, writable: true });
    expect(readLayerInfoShown()).toBe(true);
    expect(() => saveLayerInfoShown(false)).not.toThrow();
    expect(() => saveLayerInfoShown(true)).not.toThrow();
  });
});
