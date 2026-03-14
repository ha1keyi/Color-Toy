/**
 * Reactive state store with history (undo/redo).
 * Minimal pub/sub pattern - no framework dependency.
 */
import { AppState, createInitialState } from './types';

type Listener = (state: AppState, prevState: AppState) => void;

interface HistoryEntry {
  calibration: AppState['calibration'];
  primaries: AppState['primaries'];
  localMappings: AppState['localMappings'];
  globalHueShift: number;
  toning: AppState['toning'];
}

const MAX_HISTORY = 20;

class Store {
  private state: AppState;
  private listeners: Set<Listener> = new Set();
  private historyStack: HistoryEntry[] = [];
  private historyIndex: number = -1;
  private batchDepth: number = 0;
  private batchChanged: boolean = false;

  constructor() {
    this.state = createInitialState();
    this.pushHistory();
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(partial: Partial<AppState>, pushToHistory = false): void {
    const prev = this.state;
    this.state = { ...this.state, ...partial };

    if (pushToHistory) {
      this.pushHistory();
    }

    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }

    this.notify(prev);
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
    if (this.historyIndex <= 0) return false;
    this.historyIndex--;
    this.restoreHistory();
    return true;
  }

  redo(): boolean {
    if (this.historyIndex >= this.historyStack.length - 1) return false;
    this.historyIndex++;
    this.restoreHistory();
    return true;
  }

  private pushHistory(): void {
    const entry: HistoryEntry = {
      calibration: { ...this.state.calibration },
      primaries: { ...this.state.primaries },
      localMappings: this.state.localMappings.map(m => ({ ...m })),
      globalHueShift: this.state.globalHueShift,
      toning: { ...this.state.toning },
    };

    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    this.historyStack.push(entry);

    if (this.historyStack.length > MAX_HISTORY) {
      this.historyStack.shift();
    }
    this.historyIndex = this.historyStack.length - 1;
  }

  private restoreHistory(): void {
    const entry = this.historyStack[this.historyIndex];
    if (!entry) return;

    const prev = this.state;
    this.state = {
      ...this.state,
      calibration: { ...entry.calibration },
      primaries: { ...entry.primaries },
      localMappings: entry.localMappings.map(m => ({ ...m })),
      globalHueShift: entry.globalHueShift,
      toning: { ...entry.toning },
    };
    this.notify(prev);
  }

  private notify(prev: AppState): void {
    for (const listener of this.listeners) {
      listener(this.state, prev);
    }
  }
}

export const store = new Store();
