import type { MobileModule } from '../panels/panelState';

export type UiLayoutMode = 'image-priority' | 'controls-priority';

function matchesMediaQuery(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

export function resolveResponsiveLayoutMode(mode: UiLayoutMode): UiLayoutMode {
  if (!isMobileCompactViewport()) {
    return 'controls-priority';
  }

  return isPortraitViewport() ? 'image-priority' : mode;
}

export function applyLayoutMode(mode: UiLayoutMode, onResetMobileModule?: () => void): UiLayoutMode {
  const resolvedMode = resolveResponsiveLayoutMode(mode);
  document.documentElement.setAttribute('data-ui-layout', resolvedMode);
  if (resolvedMode === 'controls-priority') {
    onResetMobileModule?.();
  }
  return resolvedMode;
}

export function isMobileCompactViewport(): boolean {
  return matchesMediaQuery('(max-width: 767px)')
    && (matchesMediaQuery('(pointer: coarse)') || matchesMediaQuery('(hover: none)'));
}

export function isPortraitViewport(): boolean {
  return matchesMediaQuery('(orientation: portrait)');
}

export function isImagePriorityMobileMode(): boolean {
  return getCurrentLayoutMode() === 'image-priority' && isMobileCompactViewport();
}

export function getCurrentLayoutMode(): UiLayoutMode {
  return document.documentElement.getAttribute('data-ui-layout') === 'image-priority'
    ? 'image-priority'
    : 'controls-priority';
}

export function clampPreviewRatio(value: number): number {
  return Math.max(0.38, Math.min(0.84, value));
}

export function isValidLayout(value: string): value is UiLayoutMode {
  return value === 'image-priority' || value === 'controls-priority';
}

export function isValidMobileModule(value: string): value is MobileModule {
  return value === 'none'
    || value === 'wheels'
    || value === 'calibration'
    || value === 'mapping'
    || value === 'toning'
    || value === 'color-management'
    || value === 'history'
    || value === 'presets';
}

export function toggleMobileModuleSelection(current: MobileModule, next: MobileModule): MobileModule {
  return current === next ? 'none' : next;
}
