import { describe, expect, it, vi } from 'vitest';
import {
  answer, DecoderPool, poolSize, serveRequest, type DecodeRequest, type DecodeResponse, type DecodeSource, type WorkerLike,
} from './decoderPool';
import { halfToFloat } from './half';
import { codecNames, prewarmCodecs } from './zarrCube';

const store = { url: 'http://h/zarr/', datasetId: null };

function source(values: Float32Array, attrs: Record<string, unknown> = { units: 'meters' }): DecodeSource {
  return {
    open: async () => ({ levels: [], epsg: 32611 }),
    variable: async () => ({ ndim: 3, tChunk: 4, nTime: 6 }),
    chunk: async () => ({ values, layers: 1, attrs }),
  };
}

describe('serveRequest (the worker side)', () => {
  it('answers a chunk as float16 when asked and the values allow it, transferring its buffer', async () => {
    const values = new Float32Array([0.01, NaN, -0.2]);
    const req: DecodeRequest = { id: 7, op: 'chunk', store, path: '0/displacement', coords: [0, 1, 2], half: true };
    const { response, transfer } = await serveRequest(req, source(values));
    expect(response.ok).toBe(true);
    const r = (response as Extract<DecodeResponse, { ok: true }>).result as { buffer: ArrayBuffer; format: string; maxError: number };
    expect(r.format).toBe('f16');
    expect(transfer).toEqual([r.buffer]);
    const h = new Uint16Array(r.buffer);
    expect(h.length).toBe(3);
    expect(halfToFloat(h[0])).toBeCloseTo(0.01, 4);
    expect(halfToFloat(h[1])).toBeNaN();
    expect(r.maxError).toBeGreaterThan(0);
    expect(r.maxError).toBeLessThanOrEqual(1e-4);
  });

  it('keeps float32 for masks, for values float16 would round too much, and for other units', async () => {
    const small = new Float32Array([0.01]);
    for (const [values, half, attrs] of [
      [small, false, { units: 'meters' }],
      [new Float32Array([0.01, 3.3]), true, { units: 'meters' }],
      [small, true, { units: 'unitless' }],
    ] as const) {
      const req: DecodeRequest = { id: 1, op: 'chunk', store, path: 'v', coords: [0, 0, 0], half };
      const { response, transfer } = await serveRequest(req, source(values, attrs));
      const r = (response as Extract<DecodeResponse, { ok: true }>).result as { buffer: ArrayBuffer; format: string };
      expect(r.format).toBe('f32');
      expect(Array.from(new Float32Array(r.buffer))).toEqual(Array.from(values));
      expect(transfer).toEqual([r.buffer]);
    }
  });

  it('transfers a buffer of its own when the values are a view into a larger one', async () => {
    const big = new Float32Array(10).fill(5);
    const view = big.subarray(2, 4);
    const req: DecodeRequest = { id: 1, op: 'chunk', store, path: 'v', coords: [0, 0, 0], half: false };
    const { response, transfer } = await serveRequest(req, source(view, {}));
    const r = (response as Extract<DecodeResponse, { ok: true }>).result as { buffer: ArrayBuffer };
    expect(r.buffer.byteLength).toBe(8);
    expect(transfer[0]).not.toBe(big.buffer);
  });

  it('answers errors as messages', async () => {
    const failing: DecodeSource = { ...source(new Float32Array(1)), open: async () => { throw new Error('no zarr here'); } };
    const { response } = await serveRequest({ id: 3, op: 'open', store, probe: 'displacement' }, failing);
    expect(response).toEqual({ id: 3, ok: false, error: 'no zarr here' });
    const meta = await serveRequest({ id: 4, op: 'variable', store, path: '0/displacement' }, failing);
    expect(meta.response).toEqual({ id: 4, ok: true, result: { ndim: 3, tChunk: 4, nTime: 6 } });
  });
});

describe('answer (the worker posting back)', () => {
  it('sends an error answer when the chunk cannot be sent', async () => {
    const sent: unknown[] = [];
    const post = vi.fn((m: DecodeResponse, t: Transferable[]) => {
      if (t.length) throw new Error('DataCloneError');
      sent.push(m);
    });
    await answer({ id: 9, op: 'chunk', store, path: 'v', coords: [0, 0, 0], half: false }, source(new Float32Array(2), {}), post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([{ id: 9, ok: false, error: 'could not send the answer: DataCloneError' }]);
  });
});

/** A worker answering through serveRequest, as decode.worker.ts does. */
class FakeWorker implements WorkerLike {
  listeners: Record<string, ((ev: Event) => void)[]> = {};
  posted: unknown[] = [];
  terminated = false;
  constructor(private src: DecodeSource | null) {}
  addEventListener(type: string, fn: (ev: Event) => void) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string, ev: object) { for (const fn of this.listeners[type] ?? []) fn(ev as Event); }
  postMessage(msg: unknown) {
    this.posted.push(msg);
    if (this.src) {
      serveRequest(msg as DecodeRequest, this.src).then(({ response }) => this.emit('message', { data: response }));
    }
  }
  terminate() { this.terminated = true; }
}

describe('DecoderPool (the page side)', () => {
  it('spreads requests over its workers and matches answers by id', async () => {
    const workers: FakeWorker[] = [];
    const pool = new DecoderPool(() => { const w = new FakeWorker(source(new Float32Array([1, 2]), {})); workers.push(w); return w; }, 2);
    const [a, b] = await Promise.all([
      pool.request<{ format: string }>({ op: 'chunk', store, path: 'v', coords: [0, 0, 0], half: true }),
      pool.request<{ epsg: number }>({ op: 'open', store, probe: 'v' }),
    ]);
    expect(a.format).toBe('f32');
    expect(b.epsg).toBe(32611);
    expect(workers.map(w => w.posted.length)).toEqual([1, 1]);
    expect(pool.pending).toBe(0);
  });

  it('rejects an error answer without breaking', async () => {
    const failing: DecodeSource = { ...source(new Float32Array(1)), open: async () => { throw new Error('nope'); } };
    const pool = new DecoderPool(() => new FakeWorker(failing), 1);
    await expect(pool.request({ op: 'open', store, probe: 'v' })).rejects.toThrow('nope');
    expect(pool.broken).toBeNull();
  });

  it('fails every request and tells its listeners when a worker dies', async () => {
    const w = new FakeWorker(null);   // never answers
    const pool = new DecoderPool(() => w, 1);
    const broken = vi.fn();
    pool.onBroken(broken);
    const waiting = pool.request({ op: 'open', store, probe: 'v' });
    w.emit('error', { message: 'SyntaxError in worker', preventDefault: () => {} });
    await expect(waiting).rejects.toThrow('decoder worker failed: SyntaxError in worker');
    expect(broken).toHaveBeenCalledWith('decoder worker failed: SyntaxError in worker');
    await expect(pool.request({ op: 'open', store, probe: 'v' })).rejects.toThrow('decoder worker failed');
    const late = vi.fn();
    pool.onBroken(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it('breaks at once when workers cannot start (no Worker, blocked script)', async () => {
    const pool = new DecoderPool(() => { throw new Error('Worker is not defined'); }, 2);
    expect(pool.broken).toBe('decoder worker could not start: Worker is not defined');
    await expect(pool.request({ op: 'open', store, probe: 'v' })).rejects.toThrow('could not start');
  });

  it('close() stops the workers and fails what is waiting, without reporting a failure', async () => {
    const w = new FakeWorker(null);
    const pool = new DecoderPool(() => w, 1);
    const broken = vi.fn();
    pool.onBroken(broken);
    const waiting = pool.request({ op: 'open', store, probe: 'v' });
    pool.close();
    await expect(waiting).rejects.toThrow('decoder closed');
    expect(w.terminated).toBe(true);
    expect(broken).not.toHaveBeenCalled();
  });

  it('starts one worker less than the cores, 1 to 2', () => {
    expect(poolSize(undefined)).toBe(1);
    expect(poolSize(1)).toBe(1);
    expect(poolSize(3)).toBe(2);
    expect(poolSize(16)).toBe(2);
  });
});

describe('decoders the cube uses', () => {
  it('reads codec names from zarr.json, sharding included', () => {
    const meta = {
      node_type: 'array',
      codecs: [{ name: 'sharding_indexed', configuration: {
        codecs: [{ name: 'bytes' }, { name: 'blosc', configuration: { cname: 'zstd' } }],
        index_codecs: [{ name: 'bytes' }, { name: 'crc32c' }],
      } }],
    };
    expect(codecNames(meta)).toEqual(['sharding_indexed', 'bytes', 'blosc', 'bytes', 'crc32c']);
    expect(codecNames({ node_type: 'group' })).toEqual([]);
    expect(codecNames(null)).toEqual([]);
  });

  it('loads only those decoders, each once', () => {
    const zstd = vi.fn(async () => ({}));
    const blosc = vi.fn(async () => ({}));
    const registry = new Map<string, () => unknown>([['zstd', zstd], ['blosc', blosc], ['bytes', () => ({})]]);
    prewarmCodecs(['bytes', 'zstd', 'zstd', 'unknown'], registry);
    expect(zstd).toHaveBeenCalledOnce();
    expect(blosc).not.toHaveBeenCalled();
  });
});
