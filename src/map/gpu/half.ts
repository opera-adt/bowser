/**
 * Half-float (R16F) textures for the GPU renderer: float32 chunk values rounded to
 * IEEE float16 (round to nearest, ties to even, as numpy's ``astype(float16)``), and
 * the rule for when that rounding is small enough to draw from.
 *
 * float16 keeps 11 significant bits: a value v is off by at most |v| * 2^-11 after
 * rounding (2^-14 m = 0.06 mm below 0.25 m, 0.24 mm below 1 m, 0.49 mm below 2 m).
 * A chunk is uploaded as float16 only when the largest rounding error over all its
 * values is within the variable's tolerance; otherwise it stays float32. NaN (nodata)
 * stays NaN, so the shader's ``isnan`` test and the masks behave as with float32.
 */

/**
 * Largest rounding error allowed for a length in metres (or metres per year): 0.1 mm.
 * That is 50 times below OPERA DISP-S1's 5 mm displacement accuracy requirement, and
 * below one colour step (1/256 of the colour range) for any range wider than ±13 mm;
 * a reference date subtracts two rounded values, at most 0.2 mm off, still below a
 * step for ranges wider than ±26 mm. In practice it means: chunks whose values all
 * stay within ±0.25 m (±0.25 m/yr) are float16, larger ones float32.
 */
export const HALF_TOLERANCE_M = 1e-4;

const METRES = new Set(['m', 'meter', 'meters', 'metre', 'metres', 'm/yr', 'm/year', 'm yr-1', 'm/y',
  'meters/year', 'metres/year', 'meters per year', 'metres per year']);
const MILLIMETRES = new Set(['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'mm/yr', 'mm/year']);

/**
 * The float16 rounding a variable with these attributes may take, in its own units,
 * or null for float32 only: lengths (and rates) in metres or millimetres. Anything
 * else (coherence, counts, unknown units) stays float32, since a threshold mask or an
 * index must compare exactly as the server does.
 */
export function halfTolerance(attrs: Record<string, unknown>): number | null {
  const units = typeof attrs.units === 'string' ? attrs.units.trim().toLowerCase() : '';
  if (METRES.has(units)) return HALF_TOLERANCE_M;
  if (MILLIMETRES.has(units)) return HALF_TOLERANCE_M * 1000;
  return null;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The float16 bits of ``v`` (round to nearest even; overflow to ±Inf; NaN to a quiet NaN). */
export function toHalfBits(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 112;                      // float16 exponent field (bias 15)
  if (e >= 0x1f) return sign | 0x7c00;      // too large: Inf
  let shift: number;
  let base: number;
  if (e <= 0) {                             // float16 subnormal (or zero)
    if (e < -10) return sign;
    mant |= 0x800000;
    shift = 14 - e;
    base = mant >>> shift;
  } else {
    shift = 13;
    base = (e << 10) | (mant >>> 13);
  }
  const rem = mant & ((1 << shift) - 1);
  const mid = 1 << (shift - 1);
  // A carry out of the mantissa rounds up into the exponent (and to Inf at the top).
  if (rem > mid || (rem === mid && (base & 1))) base++;
  return sign | base;
}

let table: Float32Array | null = null;

/** float16 bits -> the float32 value (exact). */
export function halfToFloat(h: number): number {
  if (!table) {
    table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const s = i & 0x8000 ? -1 : 1;
      const e = (i >>> 10) & 0x1f;
      const m = i & 0x3ff;
      table[i] = e === 0 ? s * m * 2 ** -24
        : e === 0x1f ? (m ? NaN : s * Infinity)
          : s * (1 + m / 1024) * 2 ** (e - 15);
    }
  }
  return table[h & 0xffff];
}

export interface HalfChunk {
  data: Uint16Array;
  /** Largest |float16 - float32| over the finite values. */
  maxError: number;
}

type Float16Ctor = new (src: ArrayLike<number>) => ArrayLike<number> & { buffer: ArrayBufferLike };

/**
 * ``values`` as float16 when every value rounds within ``tolerance``, else null.
 * Uses the platform's Float16Array (the same rounding) when there is one.
 */
export function encodeHalf(values: Float32Array, tolerance: number,
  float16: Float16Ctor | undefined = (globalThis as { Float16Array?: Float16Ctor }).Float16Array): HalfChunk | null {
  const n = values.length;
  let data: Uint16Array;
  if (float16) {
    data = new Uint16Array(new float16(values).buffer as ArrayBuffer, 0, n);
  } else {
    data = new Uint16Array(n);
    for (let i = 0; i < n; i++) data[i] = toHalfBits(values[i]);
  }
  let maxError = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== v) continue;                  // NaN: nodata, stays NaN
    const err = Math.abs(halfToFloat(data[i]) - v);
    if (!(err <= tolerance)) return null;   // also catches ±Inf after overflow
    if (err > maxError) maxError = err;
  }
  return { data, maxError };
}
