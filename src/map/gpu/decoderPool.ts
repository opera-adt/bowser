/**
 * The GPU renderer reads and decodes zarr chunks off the main thread: a small pool of
 * Web Workers (decode.worker.ts) fetches each chunk, decompresses it (blosc, zstd or
 * gzip, loaded only when the cube uses it), CF-decodes it and, where the values allow
 * it, rounds it to float16 (half.ts). The buffer comes back transferred, not copied, so
 * the main thread only uploads it as a texture.
 *
 * This module is the message protocol and the main thread's side of it. The worker's
 * side is ``serveRequest`` (pure, with the zarr reading behind ``DecodeSource``).
 * When a worker can't start or dies, every request fails and the pool calls its
 * ``onBroken`` listeners, so the layer falls back to tiles as for any other failure.
 */
import { encodeHalf, halfTolerance } from './half';
import type { LevelGrid } from './geometry';

/** The cube's store as the page reaches it: ``${origin}/zarr/`` and the catalog entry. */
export interface StoreRef { url: string; datasetId: string | null }

export type DecodeOp =
  | { op: 'open'; store: StoreRef; probe: string }
  | { op: 'variable'; store: StoreRef; path: string }
  /** ``coords`` are [dateBlock, row, col]; a 2-D variable ignores the date block. */
  | { op: 'chunk'; store: StoreRef; path: string; coords: [number, number, number]; half: boolean };

export type DecodeRequest = DecodeOp & { id: number };

export interface OpenResult { levels: LevelGrid[]; epsg: number | null }
export interface VariableResult { ndim: number; tChunk: number; nTime: number }
export interface ChunkResult {
  buffer: ArrayBuffer;
  /** f32: Float32Array; f16: Uint16Array of float16 bits. */
  format: 'f32' | 'f16';
  layers: number;
  /** Largest float16 rounding error (0 for f32). */
  maxError: number;
}

export type DecodeResponse =
  | { id: number; ok: true; result: OpenResult | VariableResult | ChunkResult }
  | { id: number; ok: false; error: string };

/** What the worker reads the cube with (zarrCube.ts in the worker; fakes in tests). */
export interface DecodeSource {
  open(store: StoreRef, probe: string): Promise<OpenResult>;
  variable(store: StoreRef, path: string): Promise<VariableResult>;
  /** Chunk values as float32 [layers, rows, cols] (NaN for nodata) and the variable's attributes. */
  chunk(store: StoreRef, path: string, coords: [number, number, number]):
    Promise<{ values: Float32Array; layers: number; attrs: Record<string, unknown> }>;
}

/** Answer one request (the worker's side): the response and the buffers to transfer. */
export async function serveRequest(req: DecodeRequest, source: DecodeSource):
  Promise<{ response: DecodeResponse; transfer: ArrayBuffer[] }> {
  try {
    if (req.op === 'open') return { response: { id: req.id, ok: true, result: await source.open(req.store, req.probe) }, transfer: [] };
    if (req.op === 'variable') return { response: { id: req.id, ok: true, result: await source.variable(req.store, req.path) }, transfer: [] };
    const { values, layers, attrs } = await source.chunk(req.store, req.path, req.coords);
    const tol = req.half ? halfTolerance(attrs) : null;
    const half = tol !== null ? encodeHalf(values, tol) : null;
    let out: Float32Array | Uint16Array = half ? half.data : values;
    // Transfer a whole buffer of its own (a view into a larger one would carry the rest).
    if (out.byteOffset !== 0 || out.byteLength !== out.buffer.byteLength || !(out.buffer instanceof ArrayBuffer)) out = out.slice();
    const buffer = out.buffer as ArrayBuffer;
    const result: ChunkResult = { buffer, format: half ? 'f16' : 'f32', layers, maxError: half ? half.maxError : 0 };
    return { response: { id: req.id, ok: true, result }, transfer: [buffer] };
  } catch (e) {
    return { response: { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}

/**
 * Answer ``req`` with ``post`` (the worker's postMessage). If the answer can't be sent
 * (a buffer that can't be transferred, say), an error answer is sent instead, so the
 * page's request never waits forever.
 */
export async function answer(req: DecodeRequest, source: DecodeSource,
  post: (message: DecodeResponse, transfer: Transferable[]) => void) {
  const { response, transfer } = await serveRequest(req, source);
  try {
    post(response, transfer);
  } catch (e) {
    post({ id: req.id, ok: false, error: `could not send the answer: ${(e as Error).message}` }, []);
  }
}

/** The part of a Worker the pool uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (ev: Event) => void): void;
  terminate(): void;
}

interface Slot { worker: WorkerLike; pending: Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }> }

/**
 * Workers to start: one less than the cores, at most 4. A worker decodes one chunk at a
 * time, so a view's chunks arriving together decode up to 4 at once.
 */
export function poolSize(cores: number | undefined): number {
  return Math.max(1, Math.min(4, (cores ?? 2) - 1));
}

export class DecoderPool {
  private slots: Slot[] = [];
  private nextId = 1;
  private brokenReason: string | null = null;
  private listeners: ((reason: string) => void)[] = [];

  constructor(factory: () => WorkerLike, size: number) {
    try {
      for (let i = 0; i < size; i++) {
        const slot: Slot = { worker: factory(), pending: new Map() };
        slot.worker.addEventListener('message', ev => this.onMessage(slot, (ev as MessageEvent<DecodeResponse>).data));
        slot.worker.addEventListener('error', ev => {
          (ev as ErrorEvent).preventDefault?.();
          this.break(`decoder worker failed${(ev as ErrorEvent).message ? `: ${(ev as ErrorEvent).message}` : ''}`);
        });
        slot.worker.addEventListener('messageerror', () => this.break('decoder worker message could not be read'));
        this.slots.push(slot);
      }
    } catch (e) {
      this.break(`decoder worker could not start: ${(e as Error).message}`);
    }
  }

  /** Why the pool stopped (null while it works). */
  get broken(): string | null { return this.brokenReason; }

  /** Requests waiting for an answer. */
  get pending(): number { return this.slots.reduce((n, s) => n + s.pending.size, 0); }

  /** Called once if a worker fails (not after close()). */
  onBroken(fn: (reason: string) => void) {
    if (this.brokenReason !== null) fn(this.brokenReason);
    else this.listeners.push(fn);
  }

  request<T>(op: DecodeOp): Promise<T> {
    if (this.brokenReason !== null) return Promise.reject(new Error(this.brokenReason));
    const slot = this.slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      slot.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      try {
        slot.worker.postMessage({ ...op, id }, []);
      } catch (e) {
        slot.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Stop the workers; requests still waiting fail. */
  close() {
    this.listeners = [];
    this.fail('decoder closed');
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }

  private onMessage(slot: Slot, msg: DecodeResponse) {
    const p = slot.pending.get(msg?.id);
    if (!p) return;
    slot.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result as never);
    else p.reject(new Error(msg.error));
  }

  private break(reason: string) {
    if (this.brokenReason !== null) return;
    this.fail(reason);
    for (const fn of this.listeners.splice(0)) fn(reason);
  }

  private fail(reason: string) {
    this.brokenReason ??= reason;
    for (const s of this.slots) {
      for (const p of s.pending.values()) p.reject(new Error(reason));
      s.pending.clear();
    }
  }
}
