/**
 * Reading the GeoZarr cube from the server's ``/zarr/`` route with zarrita, inside the
 * decoder worker (decode.worker.ts): the levels, grid and CRS, and one chunk at a time
 * as float32. zarrita loads a compressor's decoder (blosc, zstd, ...) only when an
 * array uses it; the first ``zarr.json`` naming one starts loading it, so it is ready
 * when the first chunk arrives.
 */
import * as zarr from 'zarrita';
import { cfDecoding, decodeValues, withDataset } from './cf';
import type { DecodeSource, OpenResult, StoreRef, VariableResult } from './decoderPool';
import { affineFromCentres, type Affine, type LevelGrid } from './geometry';
import { epsgFromCrs } from './projection';

type AnyArray = zarr.Array<zarr.DataType, zarr.FetchStore>;

/** The compressor and other codec names an array's ``zarr.json`` uses (sharding's inner ones too). */
export function codecNames(meta: unknown): string[] {
  const out: string[] = [];
  const walk = (codecs: unknown) => {
    if (!Array.isArray(codecs)) return;
    for (const c of codecs as { name?: unknown; configuration?: Record<string, unknown> }[]) {
      if (typeof c?.name === 'string') out.push(c.name);
      walk(c?.configuration?.codecs);
      walk(c?.configuration?.index_codecs);
    }
  };
  walk((meta as { codecs?: unknown } | null)?.codecs);
  return out;
}

/** Start loading the decoders of ``names`` (zarrita's registry; each loads once). */
export function prewarmCodecs(names: string[], registry: Map<string, () => unknown> = zarr.registry as never) {
  for (const n of new Set(names)) {
    try {
      const r = registry.get(n)?.();
      if (r instanceof Promise) r.catch(() => { /* the chunk read will report it */ });
    } catch { /* idem */ }
  }
}

class Cube {
  readonly store: zarr.FetchStore;
  private arrays = new Map<string, Promise<AnyArray>>();

  constructor(ref: StoreRef) {
    this.store = new zarr.FetchStore(ref.url, {
      fetch: async (request: Request) => {
        const res = await fetch(ref.datasetId ? new Request(withDataset(request.url, ref.datasetId), request) : request);
        if (res.ok && request.url.split('?')[0].endsWith('zarr.json')) {
          res.clone().json().then(m => prewarmCodecs(codecNames(m)), () => {});
        }
        return res;
      },
    });
  }

  array(path: string): Promise<AnyArray> {
    let p = this.arrays.get(path);
    if (!p) {
      p = zarr.open.v3(zarr.root(this.store).resolve(path), { kind: 'array' }) as Promise<AnyArray>;
      this.arrays.set(path, p);
      p.catch(() => this.arrays.delete(path));
    }
    return p;
  }
}

/** The zarrita DecodeSource the worker answers with (one store per cube URL). */
export class ZarrSource implements DecodeSource {
  private cubes = new Map<string, Cube>();

  private cube(ref: StoreRef): Cube {
    const key = `${ref.url}\n${ref.datasetId ?? ''}`;
    let c = this.cubes.get(key);
    if (!c) { c = new Cube(ref); this.cubes.set(key, c); }
    return c;
  }

  async open(ref: StoreRef, probe: string): Promise<OpenResult> {
    const cube = this.cube(ref);
    const root = zarr.root(cube.store);
    let attrs: Record<string, unknown>;
    try {
      attrs = (await zarr.open.v3(root, { kind: 'group' })).attrs as Record<string, unknown>;
    } catch {
      throw new Error('the server does not serve this cube at /zarr/ (not a local zarr v3 store, or turned off)');
    }
    const ms = attrs.multiscales as { layout?: { asset: string }[] } | undefined;
    const levels: LevelGrid[] = [];
    let epsg: number | null = epsgFromCrs(attrs['proj:code'] as string | undefined);
    if (ms?.layout?.length) {
      for (const { asset } of ms.layout) {
        const g = await zarr.open.v3(root.resolve(asset), { kind: 'group' });
        const ga = g.attrs as Record<string, unknown>;
        const arr = await cube.array(`${asset}/${probe}`);
        const chunks = arr.chunks;
        levels.push({
          prefix: `${asset}/`,
          transform: ga['spatial:transform'] as Affine,
          shape: (ga['spatial:shape'] as [number, number]) ?? [arr.shape[arr.shape.length - 2], arr.shape[arr.shape.length - 1]],
          chunk: [chunks[chunks.length - 2], chunks[chunks.length - 1]],
        });
        epsg ??= epsgFromCrs(ga['proj:code'] as string | undefined);
      }
    } else {
      const arr = await cube.array(probe);
      const x = await zarr.get(await zarr.open.v3(root.resolve('x'), { kind: 'array' }), [zarr.slice(0, 2)]);
      const y = await zarr.get(await zarr.open.v3(root.resolve('y'), { kind: 'array' }), [zarr.slice(0, 2)]);
      const xs = x.data as unknown as ArrayLike<number>, ys = y.data as unknown as ArrayLike<number>;
      const n = arr.shape.length;
      levels.push({
        prefix: '',
        transform: affineFromCentres(Number(xs[0]), Number(xs[1]), Number(ys[0]), Number(ys[1])),
        shape: [arr.shape[n - 2], arr.shape[n - 1]],
        chunk: [arr.chunks[n - 2], arr.chunks[n - 1]],
      });
      if (epsg === null) {
        const gm = (arr.attrs as Record<string, unknown>).grid_mapping as string | undefined;
        if (gm) {
          const sr = await zarr.open.v3(root.resolve(gm), { kind: 'array' });
          const sa = sr.attrs as Record<string, unknown>;
          epsg = epsgFromCrs((sa.crs_wkt ?? sa.spatial_ref) as string | undefined);
        }
      }
    }
    return { levels, epsg };
  }

  async variable(ref: StoreRef, path: string): Promise<VariableResult> {
    const arr = await this.cube(ref).array(path);
    const ndim = arr.shape.length;
    return { ndim, tChunk: ndim === 3 ? arr.chunks[0] : 1, nTime: ndim === 3 ? arr.shape[0] : 1 };
  }

  async chunk(ref: StoreRef, path: string, [tb, cy, cx]: [number, number, number]) {
    const arr = await this.cube(ref).array(path);
    const ndim = arr.shape.length;
    const c = await arr.getChunk(ndim === 3 ? [tb, cy, cx] : [cy, cx]);
    const attrs = arr.attrs as Record<string, unknown>;
    const values = decodeValues(c.data as unknown as ArrayLike<number>, cfDecoding(attrs));
    return { values, layers: ndim === 3 ? c.shape[0] : 1, attrs };
  }
}
