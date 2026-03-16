import { describe, expect, it } from 'vitest';

import {
    clamp,
    compressLinearGamutVec3,
    hsvToRgb,
    linearToSrgb,
    rgbToHsv,
    srgbToLinear,
} from './conversions';

function closeToArray(actual: number[], expected: number[], precision = 6): void {
    actual.forEach((value, index) => {
        expect(value).toBeCloseTo(expected[index] ?? 0, precision);
    });
}

describe('color conversions', () => {
    it('round-trips srgb and linear values', () => {
        const samples = [0, 0.003, 0.018, 0.5, 1];

        for (const sample of samples) {
            expect(linearToSrgb(srgbToLinear(sample))).toBeCloseTo(sample, 6);
        }
    });

    it('round-trips hsv and rgb values', () => {
        const rgb: [number, number, number] = [0.25, 0.5, 0.75];
        const hsv = rgbToHsv(...rgb);
        const roundTripped = hsvToRgb(...hsv);

        closeToArray(roundTripped, rgb, 5);
    });

    it('clamps scalar values correctly', () => {
        expect(clamp(-2, 0, 1)).toBe(0);
        expect(clamp(0.5, 0, 1)).toBe(0.5);
        expect(clamp(4, 0, 1)).toBe(1);
    });

    it('compresses out-of-gamut linear rgb back into displayable range', () => {
        const compressed = compressLinearGamutVec3([1.4, -0.2, 0.3]);

        compressed.forEach((channel) => {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
        });
    });
});