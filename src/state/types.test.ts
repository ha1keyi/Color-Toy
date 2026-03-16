import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CALIBRATION,
    calibrationToPrimaries,
    primariesToCalibration,
} from './types';

describe('calibration/primary conversion', () => {
    it('maps default calibration to default-like primaries and back', () => {
        const primaries = calibrationToPrimaries(DEFAULT_CALIBRATION);
        const calibration = primariesToCalibration(primaries);

        expect(calibration.red.hueShift).toBeCloseTo(0, 1);
        expect(calibration.green.hueShift).toBeCloseTo(0, 1);
        expect(calibration.blue.hueShift).toBeCloseTo(0, 1);
        expect(calibration.red.saturation).toBeCloseTo(0, 1);
        expect(calibration.green.saturation).toBeCloseTo(0, 1);
        expect(calibration.blue.saturation).toBeCloseTo(0, 1);
    });
});