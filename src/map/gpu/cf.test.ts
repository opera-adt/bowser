import { describe, expect, it } from 'vitest';
import { cfDecoding, cfNumber, decodeValues, withDataset } from './cf';

describe('CF decoding (as xarray on the servers)', () => {
  it("reads xarray's base64 fill values and plain numbers", () => {
    expect(cfNumber('AAAAAAAA+H8=')).toBeNaN();           // float64 NaN, as the cubes store it
    expect(cfNumber(btoa(String.fromCharCode(...new Uint8Array(new Float32Array([-9999]).buffer))))).toBe(-9999);
    expect(cfNumber(0)).toBe(0);
    expect(cfNumber('NaN')).toBeNaN();
    expect(cfNumber('nope!')).toBeNull();
    expect(cfNumber(undefined)).toBeNull();
  });

  it('masks fill values, then scales and offsets', () => {
    const cf = cfDecoding({ _FillValue: -32768, missing_value: [0], scale_factor: 0.001, add_offset: 1 });
    expect(cf).toEqual({ fill: [-32768, 0], scale: 0.001, offset: 1 });
    const out = decodeValues(new Int16Array([-32768, 0, 1000, -1000]), cf);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2, 6);
    expect(out[3]).toBeCloseTo(0, 6);
  });

  it('keeps float32 chunks as they are when nothing is to decode (NaN fill)', () => {
    const src = new Float32Array([1, NaN, 3]);
    const cf = cfDecoding({ _FillValue: 'AAAAAAAA+H8=' });
    expect(cf.fill).toEqual([]);
    expect(decodeValues(src, cf)).toBe(src);
  });

  it('converts other zarr types to float32', () => {
    const plain = cfDecoding({});
    expect(Array.from(decodeValues(new Float64Array([0.5, -2]), plain))).toEqual([0.5, -2]);
    expect(Array.from(decodeValues(new BigInt64Array([3n, -4n]), plain))).toEqual([3, -4]);
    expect(Array.from(decodeValues([true, false][Symbol.iterator]() as Iterable<boolean>, plain))).toEqual([1, 0]);
  });
});

describe('catalog routing', () => {
  it('adds ?dataset= to every store request, keeping the path', () => {
    expect(withDataset('http://h:1/zarr/displacement/c/0/0/0', 'frame 1'))
      .toBe('http://h:1/zarr/displacement/c/0/0/0?dataset=frame+1');
    expect(withDataset('http://h:1/zarr/zarr.json', null)).toBe('http://h:1/zarr/zarr.json');
  });
});
