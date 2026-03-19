import { describe, expect, it } from 'vitest';

import {
  createDefaultLayoutProfile,
  normalizeLayoutProfile,
  parseLayoutProfilesFromJson,
  reorderLayoutProfiles,
  removeLayoutProfile,
  serializeLayoutProfiles,
  upsertLayoutProfile,
} from './layoutProfiles';

describe('layoutProfiles helpers', () => {
  it('creates default profile', () => {
    const profile = createDefaultLayoutProfile();
    expect(profile.layoutMode).toBe('controls-priority');
    expect(profile.name).toBe('Default Layout');
  });

  it('normalizes invalid values to safe ranges', () => {
    const profile = normalizeLayoutProfile({
      id: '',
      name: '  ',
      layoutMode: 'broken',
      mobileModuleSelection: 'x',
      controlsPriorityPreviewRatio: 9,
      imagePriorityPreviewRatio: 0,
      splitPosition: -2,
      collapsedModules: { a: true, b: 'x' },
    }, 'fallback-id');

    expect(profile.id).toBe('fallback-id');
    expect(profile.name).toBe('Custom Layout');
    expect(profile.layoutMode).toBe('controls-priority');
    expect(profile.mobileModuleSelection).toBe('none');
    expect(profile.controlsPriorityPreviewRatio).toBe(0.84);
    expect(profile.imagePriorityPreviewRatio).toBe(0.38);
    expect(profile.splitPosition).toBe(0);
    expect(profile.collapsedModules).toEqual({ a: true });
  });

  it('keeps layout mobile module values when valid', () => {
    const profile = normalizeLayoutProfile({
      id: 'layout-id',
      name: 'Layout Module',
      mobileModuleSelection: 'layout',
    }, 'fallback-id');

    expect(profile.mobileModuleSelection).toBe('layout');
  });

  it('serializes and parses profiles', () => {
    const json = serializeLayoutProfiles([createDefaultLayoutProfile()]);
    const parsed = parseLayoutProfilesFromJson(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Default Layout');
  });

  it('parses single-profile payloads and profiles wrapper payloads', () => {
    const single = parseLayoutProfilesFromJson(JSON.stringify({
      id: 'one',
      name: 'One',
      layoutMode: 'image-priority',
    }));
    expect(single).toHaveLength(1);
    expect(single[0].id).toBe('one');

    const wrapped = parseLayoutProfilesFromJson(JSON.stringify({
      profiles: [{ id: 'two', name: 'Two' }],
    }));
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].id).toBe('two');
  });

  it('upserts and removes profile entries', () => {
    const base = [createDefaultLayoutProfile()];
    const custom = { ...base[0], id: 'x', name: 'X' };
    const withCustom = upsertLayoutProfile(base, custom);
    expect(withCustom).toHaveLength(2);

    const removed = removeLayoutProfile(withCustom, 'x');
    expect(removed).toHaveLength(1);
    expect(removed[0].id).toBe('default');
  });

  it('reorders profiles by dragged and target ids', () => {
    const a = { ...createDefaultLayoutProfile(), id: 'a', name: 'A' };
    const b = { ...createDefaultLayoutProfile(), id: 'b', name: 'B' };
    const c = { ...createDefaultLayoutProfile(), id: 'c', name: 'C' };
    const reordered = reorderLayoutProfiles([a, b, c], 'c', 'a');

    expect(reordered.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });
});
