/**
 * The GeoZarr cube as the GPU renderer reads it from the server's ``/zarr/`` route:
 * levels, grid, CRS, and one chunk at a time as float32 (zarrita: zarr v3, sharding,
 * blosc/zstd). Values are decoded as the servers' xarray does (CF ``_FillValue`` /
 * ``missing_value`` to NaN, then ``scale_factor`` / ``add_offset``), so both renderers
 * see the same numbers.
 */
import * as zarr from 'zarrita';
import { affineFromCentres, type Affine, type LevelGrid } from './geometry';
import { epsgFromCrs, utmZoneFromEpsg, type UtmZone } from './projection';

type AnyArray = zarr.Array<zarr.DataType, zarr.FetchStore>;

export interface ChunkData {
  /** [layers, rows, cols] float32, NaN for nodata. */
  data: Float32Array;
  layers: number;
}

export interface CubeVariable {
  ndim: number;
  /** Dates per chunk (1 for 2-D variables). */
  tChunk: number;
  nTime: number;
}

/** CF decoding of one variable (xarray's mask_and_scale). */
export interface CfDecoding {
  /** Raw values shown as NaN (``_FillValue``, ``missing_value``); NaN itself is always nodata. */
  fill: number[];
  scale: number;
  offset: number;
}

/**
 * A CF attribute value as a number: a number, or xarray's zarr v3 encoding of a float
 * fill value (base64 of the little-endian float64/float32 bytes); null if neither.
 */
export function cfNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  if (v === 'NaN') return NaN;
  try {
    const bytes = Uint8Array.from(atob(v), ch => ch.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    if (bytes.length === 8) return view.getFloat64(0, true);
    if (bytes.length === 4) return view.getFloat32(0, true);
  } catch { /* not base64 */ }
  return null;
}

/** The CF decoding an array's attributes ask for. */
export function cfDecoding(attrs: Record<string, unknown>): CfDecoding {
  const fill: number[] = [];
  for (const key of ['_FillValue', 'missing_value']) {
    const raw = attrs[key];
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      const n = cfNumber(v);
      if (n !== null && !Number.isNaN(n)) fill.push(n);
    }
  }
  return { fill, scale: cfNumber(attrs.scale_factor) ?? 1, offset: cfNumber(attrs.add_offset) ?? 0 };
}

/** Raw chunk values (any zarr numeric or bool type) as float32, CF-decoded; no copy when none is needed. */
export function decodeValues(src: ArrayLike<number | bigint> | Iterable<boolean>, cf: CfDecoding): Float32Array {
  const plain = cf.fill.length === 0 && cf.scale === 1 && cf.offset === 0;
  if (plain && src instanceof Float32Array) return src;
  const values: ArrayLike<number | bigint> = ArrayBuffer.isView(src) || Array.isArray(src)
    ? (src as ArrayLike<number | bigint>)
    : Array.from(src as Iterable<boolean>, Number);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = Number(values[i]);
    out[i] = cf.fill.includes(raw) ? NaN : raw * cf.scale + cf.offset;
  }
  return out;
}

/** ``url`` with ``?dataset=<id>`` (how the servers route a catalog entry), or unchanged. */
export function withDataset(url: string, datasetId: string | null): string {
  if (!datasetId) return url;
  const u = new URL(url);
  u.searchParams.set('dataset', datasetId);
  return u.toString();
}

export class GpuCube {
  readonly levels: LevelGrid[];
  readonly zone: UtmZone;
  private arrays = new Map<string, Promise<AnyArray>>();
  private store: zarr.FetchStore;

  private constructor(store: zarr.FetchStore, levels: LevelGrid[], zone: UtmZone) {
    this.store = store;
    this.levels = levels;
    this.zone = zone;
  }

  /**
   * Open the store at ``url`` (``${origin}/zarr/``) and read its geometry from
   * ``probeVariable``. ``datasetId`` is the catalog entry (``?dataset=``), or null.
   */
  static async open(url: string, probeVariable: string, datasetId: string | null): Promise<GpuCube> {
    const store = new zarr.FetchStore(url, {
      fetch: (request: Request) => fetch(datasetId ? new Request(withDataset(request.url, datasetId), request) : request),
    });
    const root = zarr.root(store);
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
        const arr = await zarr.open.v3(root.resolve(`${asset}/${probeVariable}`), { kind: 'array' });
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
      const arr = await zarr.open.v3(root.resolve(probeVariable), { kind: 'array' });
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
    const zone = epsg !== null ? utmZoneFromEpsg(epsg) : null;
    if (!zone) throw new Error(`the GPU path draws UTM cubes only (EPSG ${epsg ?? 'unknown'})`);
    return new GpuCube(store, levels, zone);
  }

  private array(level: number, variable: string): Promise<AnyArray> {
    const path = `${this.levels[level].prefix}${variable}`;
    let p = this.arrays.get(path);
    if (!p) {
      p = zarr.open.v3(zarr.root(this.store).resolve(path), { kind: 'array' }) as Promise<AnyArray>;
      this.arrays.set(path, p);
      p.catch(() => this.arrays.delete(path));
    }
    return p;
  }

  async variable(level: number, variable: string): Promise<CubeVariable> {
    const arr = await this.array(level, variable);
    const ndim = arr.shape.length;
    return { ndim, tChunk: ndim === 3 ? arr.chunks[0] : 1, nTime: ndim === 3 ? arr.shape[0] : 1 };
  }

  /** Chunk (tb, cy, cx) of ``variable`` at ``level`` as float32 [layers, rows, cols]. */
  async chunk(level: number, variable: string, tb: number, cy: number, cx: number): Promise<ChunkData> {
    const arr = await this.array(level, variable);
    const ndim = arr.shape.length;
    const c = await arr.getChunk(ndim === 3 ? [tb, cy, cx] : [cy, cx]);
    const data = decodeValues(c.data as unknown as ArrayLike<number>, cfDecoding(arr.attrs as Record<string, unknown>));
    return { data, layers: ndim === 3 ? c.shape[0] : 1 };
  }
}
