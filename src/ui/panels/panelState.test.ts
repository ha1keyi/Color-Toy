import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInitialState } from '../../state/types';
import { updatePanelState } from './panelState';

class FakeClassList {
  private classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((token) => {
      this.classes.add(token);
    });
  }

  add(...tokens: string[]): void {
    tokens.forEach((token) => {
      this.classes.add(token);
    });
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => {
      this.classes.delete(token);
    });
  }

  contains(token: string): boolean {
    return this.classes.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.classes.add(token);
      return true;
    }
    if (force === false) {
      this.classes.delete(token);
      return false;
    }
    if (this.classes.has(token)) {
      this.classes.delete(token);
      return false;
    }
    this.classes.add(token);
    return true;
  }
}

class FakeElement {
  style: Record<string, string> = {};
  classList: FakeClassList;
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  title = '';
  private attributes = new Map<string, string>();

  constructor(initialClasses: string[] = []) {
    this.classList = new FakeClassList(initialClasses);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  addEventListener(): void {
    // No-op for tests.
  }
}

function createElementMap(): Record<string, FakeElement> {
  return {
    'wheels-panel': new FakeElement(['panel']),
    'wheels-row': new FakeElement(),
    'panels': new FakeElement(),
    'controls': new FakeElement(),
    'history-panel': new FakeElement(),
    'bottom-bar': new FakeElement(),
    'preset-section': new FakeElement(),
    'capabilities': new FakeElement(),
  };
}

function stubDocument(elements: Record<string, FakeElement>): void {
  vi.stubGlobal('document', {
    activeElement: null,
    getElementById: (id: string) => elements[id] ?? null,
  });
}

describe('updatePanelState mini wheel visibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the panels shell mounted when presets are open and the mini wheels should stay visible', () => {
    const elements = createElementMap();
    stubDocument(elements);

    const state = createInitialState();
    state.imageLoaded = true;
    state.ui.activeLayer = 'mapping';

    updatePanelState(state, {
      isImagePriorityMobileMode: () => true,
      getCurrentLayoutMode: () => 'image-priority',
      mobileModuleSelection: 'presets',
      mobileMappingMode: 'global',
      wheelMiniMode: 'inside',
      wheelDisplayLayer: 'mapping',
      onSelectMapping: () => undefined,
      applyPreviewControlsSplit: () => undefined,
      updateSplitDividerUI: () => undefined,
      updateToneCurveControlUI: () => undefined,
    });

    expect(elements.panels.style.display).toBe('block');
    expect(elements['wheels-panel'].style.display).toBe('block');
    expect(elements['wheels-panel'].classList.contains('wheels-mini-preview')).toBe(true);
    expect(elements['wheels-row'].style.display).toBe('flex');
  });

  it('still hides the panels shell when the mini wheels are explicitly turned off', () => {
    const elements = createElementMap();
    stubDocument(elements);

    const state = createInitialState();
    state.ui.activeLayer = 'mapping';

    updatePanelState(state, {
      isImagePriorityMobileMode: () => true,
      getCurrentLayoutMode: () => 'image-priority',
      mobileModuleSelection: 'history',
      mobileMappingMode: 'global',
      wheelMiniMode: 'hidden',
      wheelDisplayLayer: 'mapping',
      onSelectMapping: () => undefined,
      applyPreviewControlsSplit: () => undefined,
      updateSplitDividerUI: () => undefined,
      updateToneCurveControlUI: () => undefined,
    });

    expect(elements.panels.style.display).toBe('none');
    expect(elements['wheels-panel'].classList.contains('wheels-mini-preview')).toBe(false);
  });

  it('keeps the mini wheels visible while calibration is open on mobile', () => {
    const elements = createElementMap();
    stubDocument(elements);

    const state = createInitialState();
    state.imageLoaded = true;
    state.ui.activeLayer = 'calibration';

    updatePanelState(state, {
      isImagePriorityMobileMode: () => true,
      getCurrentLayoutMode: () => 'image-priority',
      mobileModuleSelection: 'calibration',
      mobileMappingMode: 'global',
      wheelMiniMode: 'inside',
      wheelDisplayLayer: 'calibration',
      onSelectMapping: () => undefined,
      applyPreviewControlsSplit: () => undefined,
      updateSplitDividerUI: () => undefined,
      updateToneCurveControlUI: () => undefined,
    });

    expect(elements.panels.style.display).toBe('block');
    expect(elements['wheels-panel'].style.display).toBe('block');
    expect(elements['wheels-panel'].classList.contains('wheels-mini-preview')).toBe(true);
    expect(elements['wheels-row'].style.display).toBe('flex');
  });
});