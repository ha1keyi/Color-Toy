import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyLayoutMode,
  clampPreviewRatio,
  isValidLayout,
  isValidMobileModule,
  resolveResponsiveLayoutMode,
  toggleMobileModuleSelection,
} from './layoutState';

function stubDom(isMobileCompact: boolean): void {
  const attributes = new Map<string, string>();

  vi.stubGlobal('window', {
    matchMedia: vi.fn().mockImplementation(() => ({
      matches: isMobileCompact,
      media: '(max-width: 767px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: vi.fn((name: string, value: string) => {
        attributes.set(name, value);
      }),
      getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
      removeAttribute: vi.fn((name: string) => {
        attributes.delete(name);
      }),
    },
  });
}

function mockViewport(isMobileCompact: boolean): void {
  stubDom(isMobileCompact);
}

describe('layoutState helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps preview ratio into allowed range', () => {
    expect(clampPreviewRatio(0.1)).toBe(0.38);
    expect(clampPreviewRatio(0.5)).toBe(0.5);
    expect(clampPreviewRatio(0.99)).toBe(0.84);
  });

  it('forces image-priority when resolving layout on mobile', () => {
    mockViewport(true);

    expect(resolveResponsiveLayoutMode('controls-priority')).toBe('image-priority');
    expect(resolveResponsiveLayoutMode('image-priority')).toBe('image-priority');
  });

  it('applies responsive layout mode and only resets modules for effective controls layout', () => {
    const onResetMobileModule = vi.fn();

    mockViewport(true);
    expect(applyLayoutMode('controls-priority', onResetMobileModule)).toBe('image-priority');
    expect(document.documentElement.getAttribute('data-ui-layout')).toBe('image-priority');
    expect(onResetMobileModule).not.toHaveBeenCalled();

    mockViewport(false);
    expect(applyLayoutMode('controls-priority', onResetMobileModule)).toBe('controls-priority');
    expect(document.documentElement.getAttribute('data-ui-layout')).toBe('controls-priority');
    expect(onResetMobileModule).toHaveBeenCalledTimes(1);
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
