/** MapLibre profile tool: draw, finish, fetch, drag a vertex, switch off (maplibre-gl faked). */
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeMarker, mockState } = vi.hoisted(() => {
  class FakeMarker {
    static all: FakeMarker[] = [];
    lngLat: [number, number] = [0, 0];
    handlers = new Map<string, () => void>();
    removed = false;
    constructor(public opts: { element: HTMLElement }) { FakeMarker.all.push(this); }
    setLngLat(ll: [number, number]) { this.lngLat = ll; return this; }
    getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
    addTo() { return this; }
    on(ev: string, h: () => void) { this.handlers.set(ev, h); return this; }
    remove() { this.removed = true; }
  }
  return { FakeMarker, mockState: {} as Record<string, any> };
});
vi.mock('maplibre-gl', () => ({ Marker: FakeMarker }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch: vi.fn() }) }));

import MapLibreProfile, { PROFILE_SOURCE } from './MapLibreProfile';
import { ProfileProvider, useProfileContext } from './ProfileTool';

class FakeMap {
  sources = new Map<string, any>();
  layers: string[] = [];
  handlers = new Map<string, ((e: any) => void)[]>();
  canvas = { style: { cursor: '' } };
  on(ev: string, h: (e: any) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]); }
  off(ev: string, h: (e: any) => void) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter(x => x !== h)); }
  fire(ev: string, e: any) { (this.handlers.get(ev) ?? []).forEach(h => h(e)); }
  addSource(id: string, s: any) { const src = { ...s, setData(d: any) { src.data = d; } }; this.sources.set(id, src); }
  getSource(id: string) { return this.sources.get(id); }
  addLayer(l: { id: string }) { this.layers.push(l.id); }
  getCanvas() { return this.canvas; }
  project([lng, lat]: [number, number]) { return { x: lng * 1e5, y: -lat * 1e5 }; }
}

const at = (lat: number, lng: number) => ({ lngLat: { lat, lng }, preventDefault() {} });
let bodies: any[] = [];

function Harness({ map, on }: { map: FakeMap; on: boolean }) {
  const { setActive } = useProfileContext();
  useEffect(() => { setActive(on); }, [on, setActive]);
  return <MapLibreProfile map={map as never} ready />;
}

beforeEach(() => {
  FakeMarker.all = [];
  bodies = [];
  Object.assign(mockState, { currentDataset: 'displacement', currentTimeIndex: 2 });
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ centre: [{ dist: 0, value: 1 }] }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const kinds = (map: FakeMap) => (map.getSource(PROFILE_SOURCE).data?.features ?? []).map((f: any) => f.properties.kind).sort();

describe('MapLibre profile tool', () => {
  it('click, click, double-click draws a line, fetches it and places numbered vertices', async () => {
    const map = new FakeMap();
    const view = render(<ProfileProvider><Harness map={map} on /></ProfileProvider>);
    expect(map.layers).toEqual(['profile-corridor', 'profile-preview', 'profile-line', 'profile-hover']);
    expect(map.canvas.style.cursor).toBe('crosshair');

    await act(async () => { map.fire('click', at(33.963, -117.680)); });
    await act(async () => { map.fire('mousemove', at(33.958, -117.675)); });
    expect(kinds(map)).toEqual(['preview']);
    await act(async () => { map.fire('click', at(33.954, -117.669)); });
    await act(async () => { map.fire('click', at(33.954, -117.669)); });   // the double-click's own click
    await act(async () => { map.fire('dblclick', at(33.954, -117.669)); });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].coords).toEqual([[-117.680, 33.963], [-117.669, 33.954]]);
    expect(bodies[0].time_index).toBe(2);
    const vertices = FakeMarker.all.filter(m => !m.removed);
    expect(vertices.map(m => m.opts.element.textContent)).toEqual(['1', '2']);
    expect(kinds(map)).toEqual(['line']);
    expect(map.canvas.style.cursor).toBe('');
    view.unmount();
  });

  it('dragging a vertex refetches the moved line; turning the tool off clears it', async () => {
    const map = new FakeMap();
    const view = render(<ProfileProvider><Harness map={map} on /></ProfileProvider>);
    for (const e of [at(33.963, -117.680), at(33.954, -117.669)]) await act(async () => { map.fire('click', e); });
    await act(async () => { map.fire('dblclick', at(33.954, -117.669)); });
    const end = FakeMarker.all.filter(m => !m.removed)[1];
    end.lngLat = [-117.660, 33.950];
    await act(async () => { end.handlers.get('drag')!(); end.handlers.get('dragend')!(); });
    expect(bodies[bodies.length - 1].coords).toEqual([[-117.680, 33.963], [-117.660, 33.950]]);

    view.rerender(<ProfileProvider><Harness map={map} on={false} /></ProfileProvider>);
    await act(async () => {});
    expect(kinds(map)).toEqual([]);
    expect(FakeMarker.all.every(m => m.removed)).toBe(true);
  });
});
