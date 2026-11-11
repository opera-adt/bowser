import { describe, expect, it, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import type { GpuCube } from './cube';
import type { LevelGrid } from './geometry';
import { GpuCubeLayer } from './layer';
import type { GpuParams } from './params';
import { utmToLonLat } from './projection';

// A WebGL2 context that records texture uploads and deletions (no drawing).
function fakeGl() {
  let next = 1;
  const uploads: { internal: number; type: number; bytes: number }[] = [];
  const live = new Set<number>();
  const own: Record<string, unknown> = {
    R16F: 0x822d, R32F: 0x822e, HALF_FLOAT: 0x140b, FLOAT: 0x1406,
    createTexture: () => { const t = next++; live.add(t); return { t }; },
    deleteTexture: (tex: { t: number } | null) => { if (tex) live.delete(tex.t); },
    texImage3D: (_target: number, _lvl: number, internal: number, w: number, h: number, d: number,
      _b: number, _f: number, type: number, data: ArrayBufferView) => {
      if (d > 1) uploads.push({ internal, type, bytes: data.byteLength });
      expect(data.byteLength).toBe(w * h * d * (type === 0x140b ? 2 : 4));
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => false,
  };
  const gl = new Proxy(own, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) return 0x1000 + prop.length;
      return () => ({});
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, uploads, live };
}

const z15 = { zone: 15, south: false };
const level: LevelGrid = { prefix: '0/', transform: [30, 0, 71970, 0, -30, 3385920], shape: [7733, 9464], chunk: [256, 256] };
const [centreLon, centreLat] = utmToLonLat(71970 + 30 * 256 * 10.5, 3385920 - 30 * 256 * 10.5, z15);

function fakeMap(span = 0.05) {
  const bounds = { w: centreLon - span, s: centreLat - span, e: centreLon + span, n: centreLat + span };
  return {
    bounds,
    getZoom: () => 12,
    getBounds: () => ({ getWest: () => bounds.w, getSouth: () => bounds.s, getEast: () => bounds.e, getNorth: () => bounds.n }),
    triggerRepaint: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

// A 269-date cube in blocks of 8: displacement may be float16, the mask never is.
function fakeCube() {
  const calls: { variable: string; tb: number; cy: number; cx: number; half: boolean }[] = [];
  let fail: ((r: string) => void) | null = null;
  const cube = {
    levels: [level],
    zone: z15,
    variable: async () => ({ ndim: 3, tChunk: 8, nTime: 269 }),
    chunk: async (_l: number, variable: string, tb: number, cy: number, cx: number, half: boolean) => {
      calls.push({ variable, tb, cy, cx, half });
      const n = 8 * 256 * 256;
      return half
        ? { data: new Uint16Array(n), format: 'f16' as const, layers: 8, maxError: 3e-5 }
        : { data: new Float32Array(n), format: 'f32' as const, layers: 8, maxError: 0 };
    },
    onFailure: (fn: (r: string) => void) => { fail = fn; },
    close: vi.fn(),
  };
  return { cube, calls, workerDies: (r: string) => fail?.(r) };
}

const params = (over: Partial<GpuParams> = {}): GpuParams => ({
  variable: 'displacement', timeIdx: 0, refTimeIdx: null, shift: 0, vmin: -0.1, vmax: 0.1, colormap: 'viridis', mask: null, ...over,
});
const render = { modelViewProjectionMatrix: new Float32Array(16) } as unknown as maplibregl.CustomRenderMethodInput;
const settle = () => new Promise(r => setTimeout(r, 0));

/** Draw frames until nothing is left to load. */
async function frames(layer: GpuCubeLayer, gl: WebGL2RenderingContext, n = 40) {
  for (let i = 0; i < n; i++) { layer.render(gl, render); await settle(); }
}

function setup(budgetBytes: number, span = 0.05) {
  const { gl, uploads, live } = fakeGl();
  const map = fakeMap(span);
  const { cube, calls, workerDies } = fakeCube();
  const onFailure = vi.fn();
  const layer = new GpuCubeLayer(cube as unknown as GpuCube, { onFailure, watchSlowFrames: false, budgetBytes });
  layer.onAdd(map as unknown as maplibregl.Map, gl);
  return { gl, uploads, live, map, cube, calls, layer, onFailure, workerDies };
}

const MB = 1024 * 1024;

describe('GpuCubeLayer', () => {
  it('uploads displacement as R16F (half the bytes) and the mask as R32F', async () => {
    const { gl, uploads, layer, calls } = setup(512 * MB);
    layer.setParams(params({ mask: { dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' } }), 1);
    await frames(layer, gl);
    const disp = calls.filter(c => c.variable === 'displacement' && c.tb === 0);
    expect(disp.length).toBeGreaterThan(0);
    expect(disp.every(c => c.half)).toBe(true);
    expect(calls.filter(c => c.variable === 'temporal_coherence').every(c => !c.half)).toBe(true);
    expect(uploads.some(u => u.internal === 0x822d && u.type === 0x140b && u.bytes === 8 * 256 * 256 * 2)).toBe(true);
    expect(uploads.some(u => u.internal === 0x822e && u.type === 0x1406)).toBe(true);
    const s = layer.stats();
    expect(s.f16).toBeGreaterThan(0);
    expect(s.f32).toBeGreaterThan(0);
    expect(s.maxHalfError).toBe(3e-5);
  });

  it('stays within its texture budget while playing through all 269 dates', async () => {
    const budget = 24 * MB;
    const { gl, layer, live, uploads } = setup(budget);
    let inView = 0;
    for (let t = 0; t < 269; t += 2) {
      layer.setParams(params({ timeIdx: t }), 1);
      await frames(layer, gl, 6);
      inView = Math.max(inView, layer.stats().textureBytes);
    }
    const s = layer.stats();
    expect(uploads.length).toBeGreaterThan(100);
    expect(s.evicted).toBeGreaterThan(50);
    // What one view needs (a few chunks of one date block, plus the next block's prefetch)
    // is all that may go over the budget.
    const chunk = 8 * 256 * 256 * 2;
    expect(s.peakTextureBytes).toBeLessThanOrEqual(budget + 2 * 25 * chunk);
    expect(live.size).toBeLessThan(budget / chunk + 2 * 25 + 4);   // textures really deleted
  }, 30_000);

  it('evicts chunks away from the view before older dates of the view', async () => {
    const chunk = 8 * 256 * 256 * 2;
    const { gl, layer, map } = setup(1000 * chunk);   // no eviction while setting up
    const textures = (layer as unknown as { textures: Map<string, { state: string }> }).textures;
    const ready = () => new Set([...textures].filter(([, e]) => e.state === 'ready').map(([k]) => k));
    layer.setParams(params({ timeIdx: 0 }), 1);
    await frames(layer, gl);
    const here = ready();
    // Pan far away (other chunks), then come back and play on.
    map.bounds.w += 1; map.bounds.e += 1;
    layer.setParams(params({ timeIdx: 9 }), 1);
    await frames(layer, gl);
    const away = [...ready()].filter(k => !here.has(k));
    map.bounds.w -= 1; map.bounds.e -= 1;
    layer.setParams(params({ timeIdx: 17 }), 1);
    await frames(layer, gl);
    expect(here.size).toBeGreaterThan(0);
    expect(away.length).toBeGreaterThan(0);
    // Just over the budget: eviction goes down to 80% of it, more than the panned-away chunks.
    const total = layer.stats().textureBytes;
    (layer as unknown as { budget: number }).budget = total - 1;
    layer.render(gl, render);
    const left = ready();
    const evicted = layer.stats().evicted;
    expect(evicted).toBeGreaterThan(away.length);
    expect(away.filter(k => left.has(k))).toEqual([]);    // all the chunks away from the view went
    // then the view's oldest dates, only as many as needed; the date shown stays
    expect([...here].filter(k => !left.has(k)).length).toBe(evicted - away.length);
    expect([...left].filter(k => k.startsWith('0|displacement|2|')).length).toBe(here.size / 2);
    expect(layer.stats().textureBytes).toBeLessThanOrEqual(0.8 * (total - 1));
  });

  it('drops queued chunks for dates played past before fetching them', async () => {
    const { gl, layer, calls } = setup(512 * MB, 0.15);
    layer.setParams(params({ timeIdx: 0 }), 1);
    layer.render(gl, render);
    await settle();                 // the variable's shape is known
    for (let t = 0; t < 64; t += 8) {
      layer.setParams(params({ timeIdx: t }), 1);
      layer.render(gl, render);     // one frame per date: no time to load them all
    }
    await frames(layer, gl);
    expect(layer.stats().dropped).toBeGreaterThan(0);
    // Far fewer fetches than 8 date blocks of the whole view.
    const perBlock = calls.filter(c => c.tb === 7).length;
    expect(calls.length).toBeLessThan(8 * perBlock);
  });

  it('falls back when the decoder workers fail, and stops them when closed', async () => {
    const { layer, onFailure, workerDies, cube } = setup(512 * MB);
    workerDies('decoder worker failed: boom');
    expect(onFailure).toHaveBeenCalledWith('decoder worker failed: boom');
    layer.close();
    expect(cube.close).toHaveBeenCalled();
  });
});
