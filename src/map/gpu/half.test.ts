import { describe, expect, it } from 'vitest';
import { encodeHalf, HALF_TOLERANCE_M, halfTolerance, halfToFloat, toHalfBits } from './half';

describe('float16 rounding (as numpy astype(float16))', () => {
  it('rounds known values to nearest, ties to even', () => {
    expect(toHalfBits(1)).toBe(0x3c00);
    expect(toHalfBits(-0)).toBe(0x8000);
    expect(toHalfBits(0.1)).toBe(0x2e66);
    expect(toHalfBits(-0.1)).toBe(0xae66);
    expect(toHalfBits(65504)).toBe(0x7bff);
    expect(toHalfBits(65520)).toBe(0x7c00);           // rounds up to Inf
    expect(toHalfBits(-Infinity)).toBe(0xfc00);
    expect(toHalfBits(NaN) & 0x7e00).toBe(0x7e00);
    expect(toHalfBits(1 + 2 ** -11)).toBe(0x3c00);    // tie: even
    expect(toHalfBits(1 + 3 * 2 ** -11)).toBe(0x3c02); // tie: even (up)
    expect(toHalfBits(2 ** -24)).toBe(1);             // smallest subnormal
    expect(toHalfBits(2 ** -25)).toBe(0);             // tie: even (zero)
    expect(toHalfBits(3 * 2 ** -25)).toBe(2);
    expect(toHalfBits(2 ** -26)).toBe(0);
    expect(toHalfBits(65519.996)).toBe(0x7bff);
  });

  it('round-trips every float16 and rounds every midpoint to the even neighbour', () => {
    const bad: string[] = [];
    for (let h = 0; h < 0x10000; h++) {
      const v = halfToFloat(h);
      const got = toHalfBits(v);
      if (Number.isNaN(v) ? (got & 0x7c00) !== 0x7c00 : got !== h) bad.push(`${h}: ${got}`);
    }
    for (let h = 0; h < 0x7bff; h++) {             // positive finite neighbours, and their negatives
      const mid = (halfToFloat(h) + halfToFloat(h + 1)) / 2;
      const even = h % 2 === 0 ? h : h + 1;
      if (toHalfBits(mid) !== even || toHalfBits(-mid) !== (even | 0x8000)) bad.push(`mid ${h}`);
    }
    expect(bad).toEqual([]);
  });

  it('matches the platform Float16Array where there is one', () => {
    const F16 = (globalThis as { Float16Array?: new (a: ArrayLike<number>) => { buffer: ArrayBuffer } }).Float16Array;
    if (!F16) return;
    const values = new Float32Array(20000);
    for (let i = 0; i < values.length; i++) values[i] = (Math.random() - 0.5) * 2 ** (Math.random() * 40 - 30);
    const native = new Uint16Array(new F16(values).buffer);
    const bad = Array.from(values).filter((v, i) => toHalfBits(v) !== native[i]);
    expect(bad).toEqual([]);
  });
});

describe('when a chunk is uploaded as float16', () => {
  it('lengths in metres or millimetres may round by 0.1 mm; other units stay float32', () => {
    expect(halfTolerance({ units: 'meters' })).toBe(HALF_TOLERANCE_M);
    expect(halfTolerance({ units: 'm/yr' })).toBe(HALF_TOLERANCE_M);
    expect(halfTolerance({ units: 'mm' })).toBeCloseTo(0.1);
    expect(halfTolerance({ units: 'unitless' })).toBeNull();
    expect(halfTolerance({})).toBeNull();
  });

  it('encodes values within ±0.25 m, keeping NaN (nodata) as NaN', () => {
    for (const f16 of [undefined, (globalThis as { Float16Array?: never }).Float16Array]) {
      const v = new Float32Array([0.0123, -0.2499, NaN, 0, 1e-7]);
      const out = encodeHalf(v, HALF_TOLERANCE_M, f16)!;
      expect(out).not.toBeNull();
      expect(Number.isNaN(halfToFloat(out.data[2]))).toBe(true);
      for (const i of [0, 1, 3, 4]) expect(Math.abs(halfToFloat(out.data[i]) - v[i])).toBeLessThanOrEqual(2 ** -14);
      expect(out.maxError).toBeGreaterThan(0);
      expect(out.maxError).toBeLessThanOrEqual(2 ** -14);
    }
  });

  it('keeps float32 when one value would round by more than the tolerance', () => {
    expect(encodeHalf(new Float32Array([0.01, 0.5 + 2 ** -12]), HALF_TOLERANCE_M, undefined)).toBeNull();   // off by 0.24 mm
    expect(encodeHalf(new Float32Array([0.01, 1e6]), HALF_TOLERANCE_M, undefined)).toBeNull();   // overflow
    expect(encodeHalf(new Float32Array([0.01, Infinity]), HALF_TOLERANCE_M, undefined)).toBeNull();
    expect(encodeHalf(new Float32Array([0.5 + 2 ** -12]), 1e-3, undefined)).not.toBeNull();
  });
});
