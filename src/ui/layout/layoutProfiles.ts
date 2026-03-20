import type { MobileModule } from '../panels/panelState';
import type { UiLayoutMode } from './layoutState';

export const LAYOUT_PROFILE_SCHEMA_VERSION = 1;
export const LAYOUT_PROFILES_STORAGE_KEY = 'colorToy.ui.layoutProfiles';
export const LAYOUT_ACTIVE_PROFILE_STORAGE_KEY = 'colorToy.ui.layoutProfile.active';
export const LAYOUT_DEFAULT_PROFILE_STORAGE_KEY = 'colorToy.ui.layoutProfile.default';
export const LAYOUT_DEFAULT_PROFILE_LOCKED_STORAGE_KEY = 'colorToy.ui.layoutProfile.defaultLocked';

export interface LayoutProfile {
  id: string;
  name: string;
  version: number;
  layoutMode: UiLayoutMode;
  mobileModuleSelection: MobileModule;
  controlsPriorityPreviewRatio: number;
  imagePriorityPreviewRatio: number;
  wheelPinned: boolean;
  splitView: boolean;
  splitPosition: number;
  collapsedModules: Record<string, boolean>;
  updatedAt: string;
  // Reserved for future plugin-level extensions.
  extensions?: Record<string, unknown>;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') {
    return fallback;
  }
  const trimmed = name.trim();
  return trimmed || fallback;
}

function normalizeLayoutMode(mode: unknown): UiLayoutMode {
  return mode === 'image-priority' ? 'image-priority' : 'controls-priority';
}

function normalizeMobileModule(value: unknown): MobileModule {
  if (
    value === 'none'
    || value === 'calibration'
    || value === 'mapping'
    || value === 'toning'
    || value === 'history'
    || value === 'presets'
  ) {
    return value;
  }
  return 'none';
}

function normalizeCollapsedModules(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof raw === 'boolean') {
      result[key] = raw;
    }
  }
  return result;
}

export function createDefaultLayoutProfile(): LayoutProfile {
  return {
    id: 'default',
    name: 'Default Layout',
    version: LAYOUT_PROFILE_SCHEMA_VERSION,
    layoutMode: 'controls-priority',
    mobileModuleSelection: 'none',
    controlsPriorityPreviewRatio: 0.5,
    imagePriorityPreviewRatio: 2 / 3,
    wheelPinned: false,
    splitView: false,
    splitPosition: 0.5,
    collapsedModules: {},
    updatedAt: new Date().toISOString(),
    extensions: {},
  };
}

export function normalizeLayoutProfile(value: unknown, fallbackId: string): LayoutProfile {
  const raw = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};

  return {
    id: normalizeName(raw.id, fallbackId),
    name: normalizeName(raw.name, 'Custom Layout'),
    version: LAYOUT_PROFILE_SCHEMA_VERSION,
    layoutMode: normalizeLayoutMode(raw.layoutMode),
    mobileModuleSelection: normalizeMobileModule(raw.mobileModuleSelection),
    controlsPriorityPreviewRatio: clamp(Number(raw.controlsPriorityPreviewRatio), 0.38, 0.84, 0.5),
    imagePriorityPreviewRatio: clamp(Number(raw.imagePriorityPreviewRatio), 0.38, 0.84, 2 / 3),
    wheelPinned: !!raw.wheelPinned,
    splitView: !!raw.splitView,
    splitPosition: clamp(Number(raw.splitPosition), 0, 1, 0.5),
    collapsedModules: normalizeCollapsedModules(raw.collapsedModules),
    updatedAt: new Date().toISOString(),
    extensions: raw.extensions && typeof raw.extensions === 'object'
      ? raw.extensions as Record<string, unknown>
      : {},
  };
}

export function parseLayoutProfilesFromJson(json: string): LayoutProfile[] {
  const parsed = JSON.parse(json);
  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => normalizeLayoutProfile(item, `imported-${index + 1}`));
  }

  if (parsed && typeof parsed === 'object') {
    const withProfiles = (parsed as Record<string, unknown>).profiles;
    if (Array.isArray(withProfiles)) {
      return withProfiles.map((item, index) => normalizeLayoutProfile(item, `imported-${index + 1}`));
    }

    return [normalizeLayoutProfile(parsed, 'imported-1')];
  }

  return [];
}

export function serializeLayoutProfiles(profiles: LayoutProfile[]): string {
  return JSON.stringify(profiles, null, 2);
}

export function upsertLayoutProfile(profiles: LayoutProfile[], profile: LayoutProfile): LayoutProfile[] {
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) {
    return [...profiles, profile];
  }

  const next = [...profiles];
  next[idx] = profile;
  return next;
}

export function removeLayoutProfile(profiles: LayoutProfile[], id: string): LayoutProfile[] {
  const filtered = profiles.filter((p) => p.id !== id);
  return filtered.length > 0 ? filtered : [createDefaultLayoutProfile()];
}

export function reorderLayoutProfiles(profiles: LayoutProfile[], draggedId: string, targetId: string): LayoutProfile[] {
  if (draggedId === targetId) {
    return profiles;
  }

  const fromIndex = profiles.findIndex((p) => p.id === draggedId);
  const toIndex = profiles.findIndex((p) => p.id === targetId);
  if (fromIndex === -1 || toIndex === -1) {
    return profiles;
  }

  const next = [...profiles];
  const [dragged] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, dragged);
  return next;
}

export function buildLayoutProfileId(): string {
  return `layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
