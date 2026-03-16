import { describe, expect, it } from 'vitest';

import { importPresetFromJSON } from './presetManager';

describe('preset import normalization', () => {
  it('normalizes a current color style preset', () => {
    const preset = importPresetFromJSON(
      JSON.stringify({
        version: '2.0',
        type: 'color_style',
        name: '  Portrait  ',
        calibration: {
          red: { hueShift: 0, saturation: 0 },
          green: { hueShift: 2, saturation: 4 },
          blue: { hueShift: -3, saturation: -2 },
        },
        toning: {
          exposure: 0.1,
          contrast: 1.1,
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
        createdAt: '2024-01-01T00:00:00Z',
      }),
    );

    expect(preset).not.toBeNull();
    expect(preset?.type).toBe('color_style');
    expect(preset?.name).toBe('Portrait');
  });

  it('migrates a legacy creative mapping preset with missing fields', () => {
    const preset = importPresetFromJSON(
      JSON.stringify({
        type: 'creative_mapping',
        name: 'Legacy Mapping',
        localMappings: [
          { id: 'a', srcHue: 0.1, dstHue: 0.2, range: 0.7, strength: 2 },
          { srcHue: 'bad', dstHue: 0.3 },
        ],
        globalHueShift: 2,
      }),
    );

    expect(preset).not.toBeNull();
    expect(preset?.version).toBe('2.0');
    expect(preset?.type).toBe('creative_mapping');
    if (preset?.type === 'creative_mapping') {
      expect(preset.localMappings).toHaveLength(1);
      expect(preset.localMappings[0]?.range).toBe(0.5);
      expect(preset.localMappings[0]?.strength).toBe(1);
      expect(preset.globalHueShift).toBe(1);
      expect(preset.baseCalibration.red.hueShift).toBe(0);
    }
  });

  it('rejects unsupported shapes', () => {
    expect(importPresetFromJSON(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});