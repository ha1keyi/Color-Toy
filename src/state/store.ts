/**
 * Reactive state store with command history (undo/redo).
 * Supports external snapshot sources so non-AppState edit data can
 * participate in the same history chain.
 */
import { createInitialState } from './types';
import type { AppState, UIState } from './types';

type Listener = (state: AppState, prevState: AppState) => void;
type HistoryListener = (history: HistoryView) => void;

interface UpdateOptions {
  pushToHistory?: boolean;
  label?: string;
}

interface HistoryStateSnapshot {
  calibration: AppState['calibration'];
  primaries: AppState['primaries'];
  localMappings: AppState['localMappings'];
  globalHueShift: number;
  toning: AppState['toning'];
  ui: Pick<
    UIState,
    | 'selectedMappingId'
    | 'splitPosition'
    | 'toneCurveEnabled'
    | 'toneCurveBypassPreview'
    | 'workingColorSpace'
    | 'gamutCompressionEnabled'
    | 'colorPickerRadiusPx'
    | 'colorPickerCoord'
    | 'importedIccProfileName'
    | 'importedIccSource'
    | 'wheelPinned'
    | 'wheelCollapsed'
    | 'controlsPriorityPreviewRatio'
    | 'imagePriorityPreviewRatio'
  >;
}

interface HistorySource {
  capture: () => unknown;
  restore: (snapshot: unknown) => void;
}

interface HistoryEntry {
  id: number;
  label: string;
  timestamp: number;
  state: HistoryStateSnapshot;
  externals: Record<string, unknown>;
  signature: string;
}

export interface HistoryListItem {
  id: number;
  label: string;
  timestamp: number;
}

export interface HistoryView {
  entries: HistoryListItem[];
  index: number;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 40;
const DEFAULT_HISTORY_LABEL = 'Edit';

function cloneStateSnapshot(state: AppState): HistoryStateSnapshot {
  return {
    calibration: {
      red: { ...state.calibration.red },
      green: { ...state.calibration.green },
      blue: { ...state.calibration.blue },
    },
    primaries: {
      red: [...state.primaries.red] as [number, number],
      green: [...state.primaries.green] as [number, number],
      blue: [...state.primaries.blue] as [number, number],
    },
    localMappings: state.localMappings.map((mapping) => ({ ...mapping })),
    globalHueShift: state.globalHueShift,
    toning: { ...state.toning },
    ui: {
      selectedMappingId: state.ui.selectedMappingId,
      splitPosition: state.ui.splitPosition,
      toneCurveEnabled: state.ui.toneCurveEnabled,
      toneCurveBypassPreview: state.ui.toneCurveBypassPreview,
      workingColorSpace: state.ui.workingColorSpace,
      gamutCompressionEnabled: state.ui.gamutCompressionEnabled,
      colorPickerRadiusPx: state.ui.colorPickerRadiusPx,
      colorPickerCoord: state.ui.colorPickerCoord
        ? { ...state.ui.colorPickerCoord }
        : null,
      importedIccProfileName: state.ui.importedIccProfileName,
      importedIccSource: state.ui.importedIccSource,
      wheelPinned: state.ui.wheelPinned,
      wheelCollapsed: state.ui.wheelCollapsed,
      controlsPriorityPreviewRatio: state.ui.controlsPriorityPreviewRatio,
      imagePriorityPreviewRatio: state.ui.imagePriorityPreviewRatio,
    },
  };
}

function toSignature(state: HistoryStateSnapshot, externals: Record<string, unknown>): string {
  return JSON.stringify({ state, externals });
}

function normalizeOptions(options?: boolean | UpdateOptions): UpdateOptions {
  if (typeof options === 'boolean') {
    return { pushToHistory: options };
  }
  return options ?? {};
}

export class Store {
  private state: AppState;
  private listeners: Set<Listener> = new Set();
  private historyListeners: Set<HistoryListener> = new Set();
  private historyStack: HistoryEntry[] = [];
  private historyIndex = -1;
  private historySources: Map<string, HistorySource> = new Map();
  private batchDepth = 0;
  private batchChanged = false;
  private nextHistoryId = 1;

  constructor() {
    this.state = createInitialState();
    this.pushHistory('Initial State');
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  getHistory(): HistoryView {
    return {
      entries: this.historyStack.map(({ id, label, timestamp }) => ({ id, label, timestamp })),
      index: this.historyIndex,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }

  canUndo(): boolean {
    return this.historyIndex > 0;
  }

  canRedo(): boolean {
    return this.historyIndex >= 0 && this.historyIndex < this.historyStack.length - 1;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeHistory(listener: HistoryListener): () => void {
    this.historyListeners.add(listener);
    listener(this.getHistory());
    return () => this.historyListeners.delete(listener);
  }

  registerHistorySource(key: string, source: HistorySource): () => void {
    this.historySources.set(key, source);
    this.syncCurrentHistoryEntry();
    return () => {
      this.historySources.delete(key);
      this.syncCurrentHistoryEntry();
    };
  }

  update(partial: Partial<AppState>, options?: boolean | UpdateOptions): void {
    const resolved = normalizeOptions(options);
    const prev = this.state;
    this.state = { ...this.state, ...partial };
    let pushed = false;

    if (resolved.pushToHistory) {
      pushed = this.pushHistory(resolved.label);
    }

    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }

    this.notify(prev);
    if (pushed) {
      this.notifyHistory();
    }
  }

  commit(partial: Partial<AppState>, label: string): void {
    this.update(partial, { pushToHistory: true, label });
  }

  commitCurrent(label: string): boolean {
    const pushed = this.pushHistory(label);
    if (pushed) {
      this.notifyHistory();
    }
    return pushed;
  }

  syncCurrentHistoryEntry(label?: string): void {
    if (this.historyIndex < 0 || !this.historyStack[this.historyIndex]) {
      this.pushHistory(label ?? 'Initial State');
      this.notifyHistory();
      return;
    }

    const current = this.historyStack[this.historyIndex];
    this.historyStack[this.historyIndex] = this.createHistoryEntry(label ?? current.label, current.id, current.timestamp);
    this.notifyHistory();
  }

  batch(fn: () => void): void {
    this.batchDepth++;
    const prev = this.state;
    fn();
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchChanged) {
      this.batchChanged = false;
      this.notify(prev);
    }
  }

  undo(): boolean {
    if (!this.canUndo()) return false;
    this.historyIndex--;
    this.restoreHistory();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo()) return false;
    this.historyIndex++;
    this.restoreHistory();
    return true;
  }

  goToHistory(index: number): boolean {
    if (index < 0 || index >= this.historyStack.length || index === this.historyIndex) {
      return false;
    }
    this.historyIndex = index;
    this.restoreHistory();
    return true;
  }

  private captureExternalSnapshots(): Record<string, unknown> {
    const snapshots: Record<string, unknown> = {};
    for (const [key, source] of this.historySources.entries()) {
      snapshots[key] = source.capture();
    }
    return snapshots;
  }

  private createHistoryEntry(label: string, existingId?: number, existingTimestamp?: number): HistoryEntry {
    const state = cloneStateSnapshot(this.state);
    const externals = this.captureExternalSnapshots();
    return {
      id: existingId ?? this.nextHistoryId++,
      label: label || DEFAULT_HISTORY_LABEL,
      timestamp: existingTimestamp ?? Date.now(),
      state,
      externals,
      signature: toSignature(state, externals),
    };
  }

  private pushHistory(label = DEFAULT_HISTORY_LABEL): boolean {
    const entry = this.createHistoryEntry(label);
    const current = this.historyStack[this.historyIndex];
    if (current && current.signature === entry.signature) {
      return false;
    }

    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    this.historyStack.push(entry);

    if (this.historyStack.length > MAX_HISTORY) {
      this.historyStack.shift();
    }

    this.historyIndex = this.historyStack.length - 1;
    return true;
  }

  private restoreHistory(): void {
    const entry = this.historyStack[this.historyIndex];
    if (!entry) return;

    const prev = this.state;
    this.state = {
      ...this.state,
      calibration: {
        red: { ...entry.state.calibration.red },
        green: { ...entry.state.calibration.green },
        blue: { ...entry.state.calibration.blue },
      },
      primaries: {
        red: [...entry.state.primaries.red] as [number, number],
        green: [...entry.state.primaries.green] as [number, number],
        blue: [...entry.state.primaries.blue] as [number, number],
      },
      localMappings: entry.state.localMappings.map((mapping) => ({ ...mapping })),
      globalHueShift: entry.state.globalHueShift,
      toning: { ...entry.state.toning },
      ui: {
        ...this.state.ui,
        ...entry.state.ui,
      },
    };

    for (const [key, source] of this.historySources.entries()) {
      source.restore(entry.externals[key]);
    }

    this.notify(prev);
    this.notifyHistory();
  }

  private notify(prev: AppState): void {
    for (const listener of this.listeners) {
      listener(this.state, prev);
    }
  }

  private notifyHistory(): void {
    const history = this.getHistory();
    for (const listener of this.historyListeners) {
      listener(history);
    }
  }
}

export const store = new Store();
