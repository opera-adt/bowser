/**
 * CF decoding as the servers' xarray does it (``_FillValue`` / ``missing_value`` to NaN,
 * then ``scale_factor`` / ``add_offset``), applied to each chunk by the decoder workers,
 * and the catalog routing of ``/zarr/`` requests.
 */

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
