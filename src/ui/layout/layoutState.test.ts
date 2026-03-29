import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyLayoutMode,
  clampPreviewRatio,
  isValidLayout,
  isValidMobileModule,
  resolveResponsiveLayoutMode,
  toggleMobileModuleSelection,
} from './layoutState';

interface ViewportStubOptions {
  compactWidth: boolean;
  coarsePointer?: boolean;
  hoverNone?: boolean;
  portrait?: boolean;
}

function stubDom(options: ViewportStubOptions): void {
  const attributes = new Map<string, string>();

  const queryMatches = (query: string): boolean => {
    switch (query) {
      case '(max-width: 767px)':
        return options.compactWidth;
      case '(pointer: coarse)':
        return options.coarsePointer ?? false;
      case '(hover: none)':
        return options.hoverNone ?? false;
      case '(orientation: portrait)':
        return options.portrait ?? false;
      default:
        return false;
    }
  };

  vi.stubGlobal('window', {
    matchMedia: vi.fn().mockImplementation((query: string) => ({
      matches: queryMatches(query),
      media: query,
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

function mockViewport(options: ViewportStubOptions): void {
  stubDom(options);
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

  it('forces image-priority when resolving layout on compact touch portrait devices', () => {
    mockViewport({ compactWidth: true, coarsePointer: true, portrait: true });

    expect(resolveResponsiveLayoutMode('controls-priority')).toBe('image-priority');
    expect(resolveResponsiveLayoutMode('image-priority')).toBe('image-priority');
  });

  it('preserves the requested layout on compact touch landscape devices', () => {
    mockViewport({ compactWidth: true, coarsePointer: true, portrait: false });

    expect(resolveResponsiveLayoutMode('controls-priority')).toBe('controls-priority');
    expect(resolveResponsiveLayoutMode('image-priority')).toBe('image-priority');
  });

  it('forces controls-priority on compact mouse-driven desktop windows', () => {
    mockViewport({ compactWidth: true, coarsePointer: false, hoverNone: false, portrait: true });

    expect(resolveResponsiveLayoutMode('image-priority')).toBe('controls-priority');
  });

  it('applies responsive layout mode and only resets modules for effective controls layout', () => {
    const onResetMobileModule = vi.fn();

    mockViewport({ compactWidth: true, coarsePointer: true, portrait: true });
    expect(applyLayoutMode('controls-priority', onResetMobileModule)).toBe('image-priority');
    expect(document.documentElement.getAttribute('data-ui-layout')).toBe('image-priority');
    expect(onResetMobileModule).not.toHaveBeenCalled();

    mockViewport({ compactWidth: true, coarsePointer: true, portrait: false });
    expect(applyLayoutMode('controls-priority', onResetMobileModule)).toBe('controls-priority');
    expect(document.documentElement.getAttribute('data-ui-layout')).toBe('controls-priority');
    expect(onResetMobileModule).toHaveBeenCalledTimes(1);

    mockViewport({ compactWidth: false, coarsePointer: false, hoverNone: false, portrait: false });
    expect(applyLayoutMode('image-priority', onResetMobileModule)).toBe('controls-priority');
    expect(document.documentElement.getAttribute('data-ui-layout')).toBe('controls-priority');
    expect(onResetMobileModule).toHaveBeenCalledTimes(2);
  });

  it('validates layout modes', () => {
    expect(isValidLayout('image-priority')).toBe(true);
    expect(isValidLayout('controls-priority')).toBe(true);
    expect(isValidLayout('grid')).toBe(false);
  });

  it('validates mobile module names', () => {
    expect(isValidMobileModule('mapping')).toBe(true);
    expect(isValidMobileModule('wheels')).toBe(true);
    expect(isValidMobileModule('color-management')).toBe(true);
    expect(isValidMobileModule('presets')).toBe(true);
    expect(isValidMobileModule('advanced')).toBe(false);
  });

  it('toggles mobile module selection', () => {
    expect(toggleMobileModuleSelection('none', 'mapping')).toBe('mapping');
    expect(toggleMobileModuleSelection('mapping', 'mapping')).toBe('none');
    expect(toggleMobileModuleSelection('history', 'presets')).toBe('presets');
  });
});
