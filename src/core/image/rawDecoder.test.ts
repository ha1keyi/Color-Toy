import { describe, expect, it } from 'vitest';

import { resolveDecodedDimensions, resolveLibRawImageDataPayload } from './rawDecoder';

describe('resolveLibRawImageDataPayload', () => {
  it('supports structured libraw imageData objects', () => {
    const payload = resolveLibRawImageDataPayload({
      width: 4284,
      height: 2844,
      colors: 3,
      bits: 16,
      data: new Uint16Array(4284 * 2844 * 3),
    });

    expect(payload.width).toBe(4284);
    expect(payload.height).toBe(2844);
    expect(payload.channels).toBe(3);
    expect(payload.buffer).toBeInstanceOf(Uint16Array);
    expect(payload.buffer.length).toBe(4284 * 2844 * 3);
  });

  it('supports legacy direct typed array payloads', () => {
    const payload = resolveLibRawImageDataPayload(new Uint16Array(12));

    expect(payload.width).toBeNull();
    expect(payload.height).toBeNull();
    expect(payload.channels).toBeNull();
    expect(payload.buffer.length).toBe(12);
  });
});

describe('resolveDecodedDimensions', () => {
  it('prefers explicit width height and channel hints from imageData', () => {
    const dims = resolveDecodedDimensions({}, 4284 * 2844 * 3, 4284, 2844, 3);

    expect(dims).toEqual({ width: 4284, height: 2844, channels: 3 });
  });

  it('falls back to metadata when imageData has no direct shape hints', () => {
    const dims = resolveDecodedDimensions({ width: 2, height: 2 }, 12);

    expect(dims).toEqual({ width: 2, height: 2, channels: 3 });
  });
});