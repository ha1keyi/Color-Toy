import { describe, expect, it } from 'vitest';

import { Store } from './store';

describe('Store history', () => {
  it('undoes and redoes edit state snapshots', () => {
    const store = new Store();

    store.update({ globalHueShift: 0.25 }, true);
    store.update({ globalHueShift: 0.5 }, true);

    expect(store.getState().globalHueShift).toBe(0.5);
    expect(store.undo()).toBe(true);
    expect(store.getState().globalHueShift).toBe(0.25);
    expect(store.undo()).toBe(true);
    expect(store.getState().globalHueShift).toBe(0);
    expect(store.undo()).toBe(false);

    expect(store.redo()).toBe(true);
    expect(store.getState().globalHueShift).toBe(0.25);
    expect(store.redo()).toBe(true);
    expect(store.getState().globalHueShift).toBe(0.5);
    expect(store.redo()).toBe(false);
  });

  it('drops redo history after a new committed edit', () => {
    const store = new Store();

    store.update({ globalHueShift: 0.1 }, true);
    store.update({ globalHueShift: 0.2 }, true);
    store.undo();

    expect(store.getState().globalHueShift).toBe(0.1);

    store.update({ globalHueShift: 0.7 }, true);

    expect(store.redo()).toBe(false);
    expect(store.getState().globalHueShift).toBe(0.7);
  });

  it('tracks labeled commands and supports direct history navigation', () => {
    const store = new Store();

    store.commit({ globalHueShift: 0.2 }, 'Adjust Global Hue');
    store.commit({ globalHueShift: 0.4 }, 'Adjust Global Hue');

    const history = store.getHistory();
    expect(history.entries.map((entry) => entry.label)).toEqual([
      'Initial State',
      'Adjust Global Hue',
      'Adjust Global Hue',
    ]);

    expect(store.goToHistory(1)).toBe(true);
    expect(store.getState().globalHueShift).toBe(0.2);
    expect(store.goToHistory(1)).toBe(false);
  });

  it('restores external history sources alongside store state', () => {
    const store = new Store();
    let externalValue = 'curve-a';

    store.registerHistorySource('toneCurve', {
      capture: () => externalValue,
      restore: (snapshot) => {
        externalValue = typeof snapshot === 'string' ? snapshot : 'curve-reset';
      },
    });

    externalValue = 'curve-b';
    store.commit({ globalHueShift: 0.5 }, 'Tone Curve: Move Point');

    externalValue = 'curve-c';
    store.commit({ globalHueShift: 0.8 }, 'Tone Curve: Add Point');

    expect(externalValue).toBe('curve-c');
    expect(store.undo()).toBe(true);
    expect(externalValue).toBe('curve-b');
    expect(store.undo()).toBe(true);
    expect(externalValue).toBe('curve-a');
  });
});