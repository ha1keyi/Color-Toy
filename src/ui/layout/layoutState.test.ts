import { describe, expect, it } from 'vitest';

import {
  clampPreviewRatio,
  isValidLayout,
  isValidMobileModule,
  toggleMobileModuleSelection,
} from './layoutState';

describe('layoutState helpers', () => {
  it('clamps preview ratio into allowed range', () => {
    expect(clampPreviewRatio(0.1)).toBe(0.38);
    expect(clampPreviewRatio(0.5)).toBe(0.5);
    expect(clampPreviewRatio(0.99)).toBe(0.84);
  });

  it('validates layout modes', () => {
    expect(isValidLayout('image-priority')).toBe(true);
    expect(isValidLayout('controls-priority')).toBe(true);
    expect(isValidLayout('grid')).toBe(false);
  });

  it('validates mobile module names', () => {
    expect(isValidMobileModule('mapping')).toBe(true);
    expect(isValidMobileModule('presets')).toBe(true);
    expect(isValidMobileModule('advanced')).toBe(false);
  });

  it('toggles mobile module selection', () => {
    expect(toggleMobileModuleSelection('none', 'mapping')).toBe('mapping');
    expect(toggleMobileModuleSelection('mapping', 'mapping')).toBe('none');
    expect(toggleMobileModuleSelection('history', 'presets')).toBe('presets');
  });
});
