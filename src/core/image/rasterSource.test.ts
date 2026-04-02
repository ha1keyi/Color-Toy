import { describe, expect, it } from 'vitest';

import { getScaledRasterDimensions, scaleRawRgba16, scaleRasterSourceToMaxDim } from './rasterSource';

describe('rasterSource helpers', () => {
  it('scales dimensions to the requested max edge', () => {
    expect(getScaledRasterDimensions(4000, 2000, 1000)).toEqual({
      width: 1000,
      height: 500,
      scale: 0.25,
    });
  });

  it('returns a copy when raw scaling keeps the original size', () => {
    const source = new Uint16Array([0, 1024, 2048, 65535]);
    const scaled = scaleRawRgba16(source, 1, 1, 1, 1);
    expect(Array.from(scaled)).toEqual(Array.from(source));
    expect(scaled).not.toBe(source);
  });

  it('bilinearly downsamples 16-bit RGBA data', () => {
    const source = new Uint16Array([
      0, 0, 0, 65535,
      65535, 0, 0, 65535,
      0, 65535, 0, 65535,
      65535, 65535, 0, 65535,
    ]);

    const scaled = scaleRawRgba16(source, 2, 2, 1, 1);

    expect(Array.from(scaled)).toEqual([32768, 32768, 0, 65535]);
  });

  it('preserves RAW transfer metadata when scaling raster sources', () => {
    const scaled = scaleRasterSourceToMaxDim({
      kind: 'raw-rgba16',
      data: new Uint16Array([
        0, 0, 0, 65535,
        65535, 0, 0, 65535,
        0, 65535, 0, 65535,
        65535, 65535, 0, 65535,
      ]),
      width: 2,
      height: 2,
      transfer: 'linear-srgb',
      metadata: { camera: 'test' },
    }, 1);

    expect(scaled).toMatchObject({
      kind: 'raw-rgba16',
      width: 1,
      height: 1,
      transfer: 'linear-srgb',
      metadata: { camera: 'test' },
    });
  });
});