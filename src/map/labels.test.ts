import { describe, expect, it, vi } from 'vitest';
import { ensureLabels, labelImageExpression, labelText, watchLabelImages } from './labels';
import { vectorLayerSpecs } from './overlays';
import { customGnssOverlay, gnssOverlay } from './contextServices';
import { GNSS_LABELS_KEY, loadGnssLabels, saveGnssLabels, type GnssStation } from './gnss';
import type { Overlay } from '../types';

const layer = (over: Partial<Overlay> = {}): Overlay => ({
  id: 'v', name: 'v', type: 'vector', visible: true, opacity: 0.5, data: { type: 'FeatureCollection', features: [] }, ...over,
});

describe('point labels', () => {
  it('a layer has no label layer unless it names a field', () => {
    expect(vectorLayerSpecs(layer()).map(l => l.id)).toEqual(['overlay-v-fill', 'overlay-v-line', 'overlay-v-point']);
  });

  it('a labelled layer draws the field beside its points, hiding labels that would overlap', () => {
    const label = vectorLayerSpecs(layer({ labelField: 'id' })).find(l => l.id === 'overlay-v-label')!;
    expect(label.type).toBe('symbol');
    expect(label.layout!['icon-image']).toEqual(labelImageExpression('id'));
    expect(label.layout!['icon-anchor']).toBe('left');
    expect(label.layout!['icon-allow-overlap']).toBeUndefined();
    expect(label.paint['icon-opacity']).toBe(0.5);
  });

  it('knows its own images by their id and leaves others alone', () => {
    expect(labelText('bowser-label:MKEA')).toBe('MKEA');
    expect(labelText('bowser-marker-square')).toBeNull();
  });

  it('listens once per map for the images it has to draw', () => {
    const map = { on: vi.fn(), hasImage: () => true, addImage: vi.fn() };
    watchLabelImages(map as never);
    watchLabelImages(map as never);
    expect(map.on).toHaveBeenCalledTimes(1);
    expect(map.on.mock.calls[0][0]).toBe('styleimagemissing');
    map.on.mock.calls[0][1]({ id: 'bowser-marker-square' });   // not a label: untouched
    expect(map.addImage).not.toHaveBeenCalled();
  });
});

describe('label images', () => {
  it('are drawn ahead for the features that have the field, once each', () => {
    const drawn = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    const ctx = { measureText: () => ({ width: 30 }), scale: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), getImageData: () => drawn };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const have = new Set<string>();
    const map = { hasImage: (id: string) => have.has(id), addImage: vi.fn((id: string) => { have.add(id); }) };
    ensureLabels(map as never, [{ properties: { id: 'MKEA' } }, { properties: { id: 'MKEA' } }, { properties: {} }, { properties: null }], 'id');
    expect(map.addImage.mock.calls.map(c => c[0])).toEqual(['bowser-label:MKEA']);
    expect(ctx.fillText.mock.calls[0][0]).toBe('MKEA');
    vi.restoreAllMocks();
  });
});

describe('GNSS station names', () => {
  const st = { id: 'MKEA', lon: -155.4, lat: 19.8 } as GnssStation;

  it('are off until asked for, and the choice is kept', () => {
    localStorage.clear();
    expect(loadGnssLabels()).toBe(false);
    expect(gnssOverlay([st]).labelField).toBeUndefined();
    saveGnssLabels(true);
    expect(localStorage.getItem(GNSS_LABELS_KEY)).toBe('on');
    expect(gnssOverlay([st]).labelField).toBe('id');
    expect(customGnssOverlay([]).labelField).toBe('id');
    saveGnssLabels(false);
    expect(localStorage.getItem(GNSS_LABELS_KEY)).toBeNull();
    expect(gnssOverlay([st]).labelField).toBeUndefined();
  });
});
