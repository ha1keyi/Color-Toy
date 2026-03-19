import type { MobileModule } from '../panels/panelState';

export type UiLayoutMode = 'image-priority' | 'controls-priority';

export function applyLayoutMode(mode: UiLayoutMode, onResetMobileModule?: () => void): void {
  document.documentElement.setAttribute('data-ui-layout', mode);
  if (mode === 'controls-priority') {
    onResetMobileModule?.();
  }
}

export function isMobileCompactViewport(): boolean {
  return window.matchMedia('(max-width: 767px)').matches;
}

export function isImagePriorityMobileMode(): boolean {
  return getCurrentLayoutMode() === 'image-priority' && isMobileCompactViewport();
}

export function getCurrentLayoutMode(): UiLayoutMode {
  return document.documentElement.getAttribute('data-ui-layout') === 'image-priority'
    ? 'image-priority'
    : 'controls-priority';
}

export function isWheelStickyContext(mobileModuleSelection: MobileModule): boolean {
  return isImagePriorityMobileMode()
    && (mobileModuleSelection === 'calibration'
      || mobileModuleSelection === 'mapping'
      || mobileModuleSelection === 'toning');
}

export function clampPreviewRatio(value: number): number {
  return Math.max(0.38, Math.min(0.84, value));
}

export function isValidLayout(value: string): value is UiLayoutMode {
  return value === 'image-priority' || value === 'controls-priority';
}

export function isValidMobileModule(value: string): value is MobileModule {
  return value === 'none'
    || value === 'calibration'
    || value === 'mapping'
    || value === 'toning'
    || value === 'layout'
    || value === 'history'
    || value === 'presets';
}

export function toggleMobileModuleSelection(current: MobileModule, next: MobileModule): MobileModule {
  return current === next ? 'none' : next;
}
