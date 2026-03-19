import type { AppState } from '../../state/types';
import type { MobileModule } from '../panels/panelState';
import type { UiLayoutMode } from './layoutState';
import {
  buildLayoutProfileId,
  createDefaultLayoutProfile,
  LAYOUT_ACTIVE_PROFILE_STORAGE_KEY,
  LAYOUT_DEFAULT_PROFILE_LOCKED_STORAGE_KEY,
  LAYOUT_DEFAULT_PROFILE_STORAGE_KEY,
  LAYOUT_PROFILES_STORAGE_KEY,
  type LayoutProfile,
  normalizeLayoutProfile,
  parseLayoutProfilesFromJson,
  reorderLayoutProfiles,
  removeLayoutProfile,
  serializeLayoutProfiles,
  upsertLayoutProfile,
} from './layoutProfiles';

interface LayoutProfileManagerDeps {
  getState: () => Readonly<AppState>;
  getLayoutMode: () => UiLayoutMode;
  setLayoutMode: (mode: UiLayoutMode) => void;
  getMobileModuleSelection: () => MobileModule;
  setMobileModuleSelection: (value: MobileModule) => void;
  setUiPatch: (patch: Partial<AppState['ui']>) => void;
  collapseStoragePrefix: string;
  onApplied: () => void;
}

function readProfiles(): LayoutProfile[] {
  try {
    const raw = window.localStorage.getItem(LAYOUT_PROFILES_STORAGE_KEY);
    if (!raw) {
      return [createDefaultLayoutProfile()];
    }
    const parsed = parseLayoutProfilesFromJson(raw);
    return parsed.length > 0 ? parsed : [createDefaultLayoutProfile()];
  } catch {
    return [createDefaultLayoutProfile()];
  }
}

function writeProfiles(profiles: LayoutProfile[]): void {
  window.localStorage.setItem(LAYOUT_PROFILES_STORAGE_KEY, serializeLayoutProfiles(profiles));
}

function readCollapsedModules(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const targets = Array.from(document.querySelectorAll('.module-collapse-btn')) as HTMLButtonElement[];
  for (const button of targets) {
    const id = button.dataset.collapseTarget;
    if (!id) continue;
    const panel = document.getElementById(id);
    if (!panel) continue;
    result[id] = panel.classList.contains('is-collapsed');
  }
  return result;
}

function applyCollapsedModules(state: Record<string, boolean>, storagePrefix: string): void {
  for (const [targetId, collapsed] of Object.entries(state)) {
    const panel = document.getElementById(targetId);
    const button = document.querySelector(`.module-collapse-btn[data-collapse-target="${targetId}"]`) as HTMLButtonElement | null;
    if (!panel || !button) continue;

    window.localStorage.setItem(`${storagePrefix}${targetId}`, collapsed ? '1' : '0');
    panel.classList.toggle('is-collapsed', collapsed);
    button.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.title = collapsed ? 'Expand module' : 'Collapse module';
    button.textContent = collapsed ? '>' : 'v';
  }
}

function downloadJson(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setupLayoutProfileManager(deps: LayoutProfileManagerDeps): void {
  const select = document.getElementById('layout-profile-select') as HTMLSelectElement | null;
  const profileList = document.getElementById('layout-profile-list') as HTMLUListElement | null;
  const saveCurrentBtn = document.getElementById('layout-save-current-btn') as HTMLButtonElement | null;
  const saveAsBtn = document.getElementById('layout-save-as-btn') as HTMLButtonElement | null;
  const renameBtn = document.getElementById('layout-rename-btn') as HTMLButtonElement | null;
  const deleteBtn = document.getElementById('layout-delete-btn') as HTMLButtonElement | null;
  const defaultLockBtn = document.getElementById('layout-default-lock-btn') as HTMLButtonElement | null;
  const rollbackBtn = document.getElementById('layout-rollback-btn') as HTMLButtonElement | null;
  const exportBtn = document.getElementById('layout-export-btn') as HTMLButtonElement | null;
  const importBtn = document.getElementById('layout-import-btn') as HTMLButtonElement | null;
  const importInput = document.getElementById('layout-import-input') as HTMLInputElement | null;
  const status = document.getElementById('layout-manager-status');

  if (!select) {
    return;
  }

  let profiles = readProfiles();
  let activeProfileId = window.localStorage.getItem(LAYOUT_ACTIVE_PROFILE_STORAGE_KEY) || profiles[0].id;
  let defaultProfileId = window.localStorage.getItem(LAYOUT_DEFAULT_PROFILE_STORAGE_KEY) || profiles[0].id;
  let defaultLocked = window.localStorage.getItem(LAYOUT_DEFAULT_PROFILE_LOCKED_STORAGE_KEY) === '1';
  let lastAppliedSnapshot: LayoutProfile | null = null;
  let dragProfileId: string | null = null;

  if (!profiles.some((profile) => profile.id === defaultProfileId)) {
    defaultProfileId = profiles[0].id;
  }
  if (defaultLocked) {
    activeProfileId = defaultProfileId;
  }

  const isDefaultLockedProfile = (profileId: string): boolean => defaultLocked && defaultProfileId === profileId;

  const persistDefaultState = () => {
    window.localStorage.setItem(LAYOUT_DEFAULT_PROFILE_STORAGE_KEY, defaultProfileId);
    window.localStorage.setItem(LAYOUT_DEFAULT_PROFILE_LOCKED_STORAGE_KEY, defaultLocked ? '1' : '0');
  };

  const setStatus = (text: string) => {
    if (status) status.textContent = text;
  };

  const updateActionStates = () => {
    const selected = profiles.find((p) => p.id === activeProfileId);
    const locked = selected ? isDefaultLockedProfile(selected.id) : false;
    if (saveCurrentBtn) saveCurrentBtn.disabled = locked;
    if (renameBtn) renameBtn.disabled = locked;
    if (deleteBtn) deleteBtn.disabled = locked || profiles.length <= 1;
    if (rollbackBtn) rollbackBtn.disabled = !lastAppliedSnapshot;

    if (defaultLockBtn) {
      defaultLockBtn.textContent = locked ? 'Unlock Default' : 'Lock As Default';
    }
  };

  const renderSelect = () => {
    select.innerHTML = profiles
      .map((p) => {
        const defaultMark = p.id === defaultProfileId ? ' [Default]' : '';
        const lockMark = isDefaultLockedProfile(p.id) ? ' [Locked]' : '';
        return `<option value="${p.id}">${escapeHtml(p.name)}${defaultMark}${lockMark}</option>`;
      })
      .join('');

    if (!profiles.some((p) => p.id === activeProfileId)) {
      activeProfileId = profiles[0]?.id || 'default';
    }
    select.value = activeProfileId;
    updateActionStates();
  };

  const renderProfileList = () => {
    if (!profileList) return;

    profileList.innerHTML = profiles.map((profile) => {
      const isActive = profile.id === activeProfileId;
      const isDefault = profile.id === defaultProfileId;
      const isLockedDefault = isDefaultLockedProfile(profile.id);
      const tags = `${isDefault ? '<span class="layout-profile-badge">Default</span>' : ''}${isLockedDefault ? '<span class="layout-profile-badge lock">Locked</span>' : ''}`;

      return `
        <li class="layout-profile-item${isActive ? ' active' : ''}" data-profile-id="${profile.id}" draggable="true">
          <span class="layout-drag-handle" aria-hidden="true">::</span>
          <span class="layout-profile-name">${escapeHtml(profile.name)}</span>
          <span class="layout-profile-tags">${tags}</span>
        </li>
      `;
    }).join('');

    updateActionStates();
  };

  const captureCurrentAsProfile = (target?: Pick<LayoutProfile, 'id' | 'name' | 'extensions'>): LayoutProfile => {
    const state = deps.getState();
    return normalizeLayoutProfile({
      id: target?.id || buildLayoutProfileId(),
      name: target?.name || 'Custom Layout',
      layoutMode: deps.getLayoutMode(),
      mobileModuleSelection: deps.getMobileModuleSelection(),
      controlsPriorityPreviewRatio: state.ui.controlsPriorityPreviewRatio,
      imagePriorityPreviewRatio: state.ui.imagePriorityPreviewRatio,
      wheelPinned: state.ui.wheelPinned,
      splitView: state.ui.splitView,
      splitPosition: state.ui.splitPosition,
      collapsedModules: readCollapsedModules(),
      extensions: target?.extensions || {},
    }, target?.id || buildLayoutProfileId());
  };

  const applyProfile = (profile: LayoutProfile, trackRollback = true) => {
    if (trackRollback) {
      lastAppliedSnapshot = captureCurrentAsProfile({
        id: 'rollback-snapshot',
        name: 'Rollback Snapshot',
      });
    }

    deps.setLayoutMode(profile.layoutMode);
    deps.setMobileModuleSelection(profile.mobileModuleSelection);
    deps.setUiPatch({
      controlsPriorityPreviewRatio: profile.controlsPriorityPreviewRatio,
      imagePriorityPreviewRatio: profile.imagePriorityPreviewRatio,
      wheelPinned: profile.wheelPinned,
      splitView: profile.splitView,
      splitPosition: profile.splitPosition,
    });

    applyCollapsedModules(profile.collapsedModules, deps.collapseStoragePrefix);
    window.localStorage.setItem(LAYOUT_ACTIVE_PROFILE_STORAGE_KEY, profile.id);
    activeProfileId = profile.id;
    deps.onApplied();
    setStatus(`Applied: ${profile.name}`);
    renderProfileList();
    renderSelect();
  };

  renderSelect();
  renderProfileList();

  const initial = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  if (initial) {
    applyProfile(initial, false);
  }

  select.addEventListener('change', () => {
    const selected = profiles.find((p) => p.id === select.value);
    if (!selected) return;
    applyProfile(selected);
  });

  saveCurrentBtn?.addEventListener('click', () => {
    const selected = profiles.find((p) => p.id === activeProfileId);
    if (!selected) return;
    if (isDefaultLockedProfile(selected.id)) {
      setStatus('Default preset is locked. Unlock before saving.');
      return;
    }

    const updated = captureCurrentAsProfile(selected);
    profiles = upsertLayoutProfile(profiles, { ...updated, id: selected.id, name: selected.name });
    writeProfiles(profiles);
    renderSelect();
    renderProfileList();
    setStatus(`Saved current to: ${selected.name}`);
  });

  saveAsBtn?.addEventListener('click', () => {
    const name = window.prompt('Layout name', 'New Layout');
    if (!name) return;
    const profile = captureCurrentAsProfile();
    profiles = upsertLayoutProfile(profiles, {
      ...profile,
      id: buildLayoutProfileId(),
      name: name.trim() || 'New Layout',
    });
    writeProfiles(profiles);
    activeProfileId = profiles[profiles.length - 1].id;
    renderSelect();
    renderProfileList();
    window.localStorage.setItem(LAYOUT_ACTIVE_PROFILE_STORAGE_KEY, activeProfileId);
    setStatus(`Created: ${name}`);
  });

  renameBtn?.addEventListener('click', () => {
    const selected = profiles.find((p) => p.id === activeProfileId);
    if (!selected) return;
    if (isDefaultLockedProfile(selected.id)) {
      setStatus('Default preset is locked. Unlock before renaming.');
      return;
    }

    const nextName = window.prompt('Rename layout', selected.name);
    if (!nextName) return;
    profiles = upsertLayoutProfile(profiles, { ...selected, name: nextName.trim() || selected.name });
    writeProfiles(profiles);
    renderSelect();
    renderProfileList();
    setStatus(`Renamed to: ${nextName}`);
  });

  deleteBtn?.addEventListener('click', () => {
    if (profiles.length <= 1) {
      setStatus('Keep at least one layout profile.');
      return;
    }

    const selected = profiles.find((p) => p.id === activeProfileId);
    if (!selected) return;
    if (isDefaultLockedProfile(selected.id)) {
      setStatus('Default preset is locked. Unlock before deleting.');
      return;
    }

    const confirmDelete = window.confirm(`Delete layout "${selected.name}"?`);
    if (!confirmDelete) return;

    profiles = removeLayoutProfile(profiles, selected.id);
    if (!profiles.some((p) => p.id === defaultProfileId)) {
      defaultProfileId = profiles[0].id;
      defaultLocked = false;
      persistDefaultState();
    }
    writeProfiles(profiles);
    activeProfileId = profiles[0].id;
    window.localStorage.setItem(LAYOUT_ACTIVE_PROFILE_STORAGE_KEY, activeProfileId);
    renderSelect();
    renderProfileList();
    setStatus(`Deleted: ${selected.name}`);
    applyProfile(profiles[0]);
  });

  defaultLockBtn?.addEventListener('click', () => {
    const selected = profiles.find((p) => p.id === activeProfileId);
    if (!selected) return;

    if (isDefaultLockedProfile(selected.id)) {
      defaultLocked = false;
      persistDefaultState();
      renderSelect();
      renderProfileList();
      setStatus(`Unlocked default preset: ${selected.name}`);
      return;
    }

    defaultProfileId = selected.id;
    defaultLocked = true;
    persistDefaultState();
    renderSelect();
    renderProfileList();
    setStatus(`Locked default preset: ${selected.name}`);
  });

  rollbackBtn?.addEventListener('click', () => {
    if (!lastAppliedSnapshot) {
      setStatus('No previous layout snapshot available.');
      return;
    }

    const snapshot = normalizeLayoutProfile(lastAppliedSnapshot, 'rollback-snapshot');
    const current = captureCurrentAsProfile({
      id: 'rollback-snapshot',
      name: 'Rollback Snapshot',
    });
    applyProfile(snapshot, false);
    lastAppliedSnapshot = current;
    updateActionStates();
    setStatus('Rolled back to previous layout.');
  });

  exportBtn?.addEventListener('click', () => {
    const selected = profiles.find((p) => p.id === activeProfileId);
    if (!selected) return;
    downloadJson(`layout-${selected.name.replace(/\s+/g, '-').toLowerCase()}.json`, serializeLayoutProfiles([selected]));
    setStatus(`Exported: ${selected.name}`);
  });

  importBtn?.addEventListener('click', () => {
    importInput?.click();
  });

  importInput?.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const incoming = parseLayoutProfilesFromJson(text);
      if (incoming.length === 0) {
        setStatus('No valid layout profile found.');
        return;
      }

      for (const profile of incoming) {
        profiles = upsertLayoutProfile(profiles, {
          ...profile,
          id: profile.id || buildLayoutProfileId(),
        });
      }

      writeProfiles(profiles);
      activeProfileId = incoming[0].id;
      renderSelect();
      renderProfileList();
      applyProfile(profiles.find((p) => p.id === activeProfileId) || profiles[0]);
      setStatus(`Imported ${incoming.length} layout profile(s).`);
    } catch {
      setStatus('Import failed: invalid JSON.');
    } finally {
      importInput.value = '';
    }
  });

  profileList?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.layout-profile-item') as HTMLElement | null;
    if (!item) return;

    const profileId = item.dataset.profileId;
    if (!profileId) return;

    const selected = profiles.find((profile) => profile.id === profileId);
    if (!selected) return;

    activeProfileId = selected.id;
    renderSelect();
    renderProfileList();
    applyProfile(selected);
  });

  profileList?.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.layout-profile-item') as HTMLElement | null;
    if (!item) return;

    dragProfileId = item.dataset.profileId || null;
    if (!dragProfileId) return;

    event.dataTransfer?.setData('text/plain', dragProfileId);
    event.dataTransfer!.effectAllowed = 'move';
    item.classList.add('dragging');
  });

  profileList?.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';
  });

  profileList?.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const item = target.closest('.layout-profile-item') as HTMLElement | null;
    const targetId = item?.dataset.profileId;
    if (!dragProfileId || !targetId || dragProfileId === targetId) {
      return;
    }

    profiles = reorderLayoutProfiles(profiles, dragProfileId, targetId);
    writeProfiles(profiles);
    renderSelect();
    renderProfileList();
    setStatus('Reordered layout profiles.');
  });

  profileList?.addEventListener('dragend', () => {
    dragProfileId = null;
    profileList.querySelectorAll('.layout-profile-item.dragging').forEach((item) => {
      item.classList.remove('dragging');
    });
  });
}
