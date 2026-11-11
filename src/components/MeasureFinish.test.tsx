/** The measure tool keeps its result after the finishing double-click, until a new measurement or tool off. */
import { act, cleanup, render } from '@testing-library/react';
import L from 'leaflet';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { FakePopup, leafletMap } = vi.hoisted(() => {
  class FakePopup {
    static open: FakePopup[] = [];
    html = '';
    setLngLat() { return this; }
    setHTML(h: string) { this.html = h; return this; }
    addTo() { FakePopup.open.push(this); return this; }
    remove() { FakePopup.open = FakePopup.open.filter(p => p !== this); }
  }
  return { FakePopup, leafletMap: { current: null as any } };
});
vi.mock('maplibre-gl', () => ({ Popup: FakePopup }));
vi.mock('react-leaflet', () => ({ useMap: () => leafletMap.current }));

import MapLibreMeasure, { MEASURE_SOURCE } from './MapLibreMeasure';
import MeasureTool from './MeasureTool';

class FakeMap {
  sources = new Map<string, any>();
  handlers = new Map<string, ((e: any) => void)[]>();
  canvas = { style: { cursor: '' } };
  on(ev: string, h: (e: any) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]); }
  off(ev: string, h: (e: any) => void) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter(x => x !== h)); }
  fire(ev: string, e: any) { (this.handlers.get(ev) ?? []).forEach(h => h(e)); }
  addSource(id: string, s: any) { const src = { ...s, setData(d: any) { src.data = d; } }; this.sources.set(id, src); }
  getSource(id: string) { return this.sources.get(id); }
  addLayer() {}
  getCanvas() { return this.canvas; }
}
const at = (lat: number, lng: number) => ({ lngLat: { lat, lng }, latlng: L.latLng(lat, lng), preventDefault() {} });
const A = at(34.75, -90.12), B = at(34.76, -90.11), C = at(34.74, -90.10);

afterEach(() => { cleanup(); FakePopup.open = []; leafletMap.current?.remove(); leafletMap.current = null; });

describe('MapLibre measure tool', () => {
  const nPoints = (map: FakeMap) => map.getSource(MEASURE_SOURCE).data.features.filter((f: any) => f.geometry.type === 'Point').length;

  it('keeps the result after the double-click, until a new measurement or tool off', () => {
    const map = new FakeMap();
    const view = render(<MapLibreMeasure map={map as never} ready active />);
    act(() => { map.fire('click', A); map.fire('click', B); map.fire('click', B); map.fire('dblclick', B); });
    expect(FakePopup.open).toHaveLength(1);
    const result = FakePopup.open[0].html;
    expect(result).toMatch(/km|m/);
    expect(nPoints(map)).toBe(3);
    expect(map.canvas.style.cursor).toBe('crosshair');   // still on

    act(() => { map.fire('click', C); });                // a new measurement
    expect(nPoints(map)).toBe(1);
    expect(FakePopup.open).toHaveLength(0);

    act(() => { map.fire('click', A); });
    expect(FakePopup.open).toHaveLength(1);
    view.rerender(<MapLibreMeasure map={map as never} ready active={false} />);   // tool off
    expect(FakePopup.open).toHaveLength(0);
    expect(nPoints(map)).toBe(0);
  });
});

describe('Leaflet measure tool', () => {
  // dots, segments and the label (not the SVG renderer Leaflet adds as a layer)
  const layers = () => { let n = 0; leafletMap.current.eachLayer((l: L.Layer) => { if (l instanceof L.Path || l instanceof L.Popup) n += 1; }); return n; };
  const popups = () => document.querySelectorAll('.leaflet-popup').length;

  it('keeps the result after the double-click, until a new measurement or tool off', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    leafletMap.current = L.map(div, { center: [34.75, -90.11], zoom: 13 });
    const view = render(<MeasureTool active />);
    act(() => { leafletMap.current.fire('click', A); leafletMap.current.fire('click', B); leafletMap.current.fire('dblclick', B); });
    expect(popups()).toBe(1);
    expect(layers()).toBe(4);  // two dots, one segment, the label

    act(() => { leafletMap.current.fire('click', C); });   // a new measurement
    expect(popups()).toBe(0);
    expect(layers()).toBe(1);

    act(() => { leafletMap.current.fire('click', A); });
    view.rerender(<MeasureTool active={false} />);          // tool off
    expect(popups()).toBe(0);
    expect(layers()).toBe(0);
  });
});
