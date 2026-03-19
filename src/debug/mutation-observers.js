/* global MutationObserver, clearInterval, console, document, setInterval, window */

// Mutation observer helper for debugging wheel-pin / sticky transitions
// Usage:
// - Paste into browser console, or include via a <script> tag during local dev.
// - It will log class and attribute changes on #controls, #wheel-controls-bar, and #wheels-row.

(function () {
  const log = (...args) => console.log('%c[mut-observer]', 'color: #7cc0ff; font-weight: 700;', ...args);

  const controls = document.getElementById('controls');
  const wheelBar = document.getElementById('wheel-controls-bar');
  const wheelsRow = document.getElementById('wheels-row');

  if (!controls) {
    log('No #controls element found — include script after DOMContentLoaded or paste into console.');
    return;
  }

  const observeOptions = { attributes: true, attributeFilter: ['class', 'style'], subtree: false };

  const dumpComputed = (el) => {
    if (!el) return {};
    const cs = window.getComputedStyle(el);
    return {
      position: cs.position,
      top: cs.top,
      zIndex: cs.zIndex,
      display: cs.display,
    };
  };

  const makeObserver = (name, el) => {
    if (!el) return null;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        log(`${name} mutation`, m.type, m.attributeName, 'class=', el.className, 'inlineStyle=', el.getAttribute('style') || '');
        log('computed ->', dumpComputed(el));
      }
    });
    obs.observe(el, observeOptions);
    return obs;
  };

  const controlsObs = makeObserver('#controls', controls);
  const wheelBarObs = makeObserver('#wheel-controls-bar', wheelBar);
  const wheelsRowObs = makeObserver('#wheels-row', wheelsRow);

  // Watch for computed position changes (some browsers don't emit attribute changes for layout shifts)
  let prev = {
    controls: dumpComputed(controls),
    wheelBar: dumpComputed(wheelBar),
    wheelsRow: dumpComputed(wheelsRow),
  };

  const pollId = setInterval(() => {
    const now = {
      controls: dumpComputed(controls),
      wheelBar: dumpComputed(wheelBar),
      wheelsRow: dumpComputed(wheelsRow),
    };

    for (const k of Object.keys(now)) {
      const a = now[k];
      const b = prev[k];
      if (!a || !b) continue;
      if (a.position !== b.position) {
        log(`${k} position changed`, b.position, '->', a.position, 'class=', (k==='controls'?controls.className:(k==='wheelBar'?wheelBar.className:wheelsRow.className)), 'inlineStyle=', (k==='controls'?controls.getAttribute('style'):(k==='wheelBar'?wheelBar.getAttribute('style'):wheelsRow.getAttribute('style'))));
      }
    }

    prev = now;
  }, 150);

  // Provide a small API to stop observers
  window.__colorToyMutationObservers = {
    stop() {
      if (controlsObs) controlsObs.disconnect();
      if (wheelBarObs) wheelBarObs.disconnect();
      if (wheelsRowObs) wheelsRowObs.disconnect();
      clearInterval(pollId);
      log('stopped observers');
    },
  };

  log('mutation observers started for #controls, #wheel-controls-bar, #wheels-row');
})();
