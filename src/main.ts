/**
 * Color Toy - Main Application Entry Point
 * Wires together: State, Renderer, ColorWheel (edit + rendered), UI Panels
 */
import { store } from './state/store';
import {
  AppState, LocalMapping,
  DEFAULT_CALIBRATION, DEFAULT_PRIMARIES, DEFAULT_TONING,
  SRGB_RED_XY, SRGB_GREEN_XY, SRGB_BLUE_XY, D65_WHITE_XY,
  calibrationToPrimaries, primariesToCalibration,
} from './state/types';
import { Renderer } from './gpu/renderer';
import { ColorWheel } from './ui/wheel/colorWheel';
import { rgbToHsv } from './core/color/conversions';
import {
  BUILTIN_PRESETS, getStoredPresets, savePreset,
  createColorStylePreset, createCreativeMappingPreset,
  applyPreset, importPresetFromJSON,
} from './presets/presetManager';

// DOM references
let renderer: Renderer;
let colorWheel: ColorWheel;
let originalImage: HTMLImageElement | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let renderedWheelCanvas: HTMLCanvasElement | null = null;
let _wheelAnimFrame = 0;
let dominantImageHues: number[] = [];
type ThemeMode = 'dark' | 'light';
const THEME_STORAGE_KEY = 'colorToy.theme';

function readCssVar(name: string, fallback: string): string {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// Histogram throttle
let lastHistogramTime = 0;
const HISTOGRAM_INTERVAL = 1000 / 10; // ~10fps max
const TONE_CURVE_LUT_SIZE = 256;
const DOMINANT_HUE_BINS = 72;
const DOMINANT_HUE_COUNT = 6;

type ToneCurvePoint = { x: number; y: number };

function init(): void {
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  const wheelCanvas = document.getElementById('wheel-canvas') as HTMLCanvasElement;
  renderedWheelCanvas = document.getElementById('rendered-wheel-canvas') as HTMLCanvasElement;

  if (!glCanvas || !wheelCanvas) {
    console.error('Required canvas elements not found');
    return;
  }

  // Always wire file input first so upload button works even if later init fails.
  setupImageInput();

  // Initialize renderer
  try {
    renderer = new Renderer(glCanvas);
    updateCapabilitiesDisplay();
  } catch (e) {
    const details = e instanceof Error ? e.message : String(e);
    showError(`WebGL initialization failed: ${details}`);
    return;
  }

  // Initialize edit color wheel (interactive)
  colorWheel = new ColorWheel(wheelCanvas);
  colorWheel.resize();

  // Wire up color wheel callbacks (no primary drag in calibration mode)
  colorWheel.setCallbacks({
    onMappingChange: handleMappingHueChange,
    onMappingAdd: handleMappingAdd,
    onGlobalHueChange: handleGlobalHueChange,
    onMappingSelect: handleMappingSelect,
    onDragEnd: handleDragEnd,
  });

  // Subscribe to state changes
  store.subscribe(onStateChange);

  // Setup UI event handlers
  setupThemeToggle();
  setupLayerTabs();
  setupToolbar();
  setupSplitDivider();
  setupCompareHint();
  setupPanels();
  setupPresets();
  setupExport();
  setupKeyboard();
  setupPerformanceMonitor();
  setupWheelCompareToggle();
  setupXYPanelToggle();
  setupValInputs();
  setupDoubleClickReset();
  setupXYDiagram();
  setupToneCurve();

  // Initial render
  const state = store.getState();
  const exportState: AppState = {
    ...state,
    ui: {
      ...state.ui,
      holdCompareActive: false,
    },
  };
  colorWheel.setImageHuePeaks(dominantImageHues);
  colorWheel.setState(state);
  colorWheel.draw(state);
  if (renderedWheelCanvas) {
    colorWheel.drawRendered(state, renderedWheelCanvas);
  }

  // Initial diagram renders
  if (state.ui.activeLayer === 'calibration') drawXYDiagram(state);
  if (state.ui.activeLayer === 'toning') drawToneCurve();

  updateToneCurveGPU();

  // Start wheel animation loop (15fps)
  startWheelLoop();

  // Handle window resize
  window.addEventListener('resize', handleResize);
  handleResize();
}

function applyTheme(theme: ThemeMode, button?: HTMLButtonElement | null): void {
  document.documentElement.setAttribute('data-theme', theme);

  const themeColorMeta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (themeColorMeta) {
    themeColorMeta.content = theme === 'light' ? '#eef2f7' : '#12171d';
  }

  const btn = button ?? document.getElementById('theme-toggle-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const nextLabel = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  btn.title = nextLabel;
  btn.setAttribute('aria-label', nextLabel);
  btn.classList.toggle('active', theme === 'light');

  const label = btn.querySelector('.theme-toggle-label') as HTMLElement | null;
  if (label) {
    label.textContent = theme === 'light' ? 'Light' : 'Dark';
  }

  const state = store.getState();
  colorWheel.draw(state);
  if (renderedWheelCanvas) {
    colorWheel.drawRendered(state, renderedWheelCanvas);
  }
  drawToneCurve();
  drawHistogram();
  if (state.ui.activeLayer === 'calibration') {
    drawXYDiagram(state);
  }
}

function setupThemeToggle(): void {
  const btn = document.getElementById('theme-toggle-btn') as HTMLButtonElement | null;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  const initialTheme: ThemeMode = stored === 'light' ? 'light' : 'dark';
  applyTheme(initialTheme, btn);

  if (!btn) return;
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next, btn);
  });
}

function setupCompareHint(): void {
  const hint = document.getElementById('compare-hint');
  if (!hint) return;

  const key = 'colorToy.holdCompareHintSeen';
  const seen = window.localStorage.getItem(key) === '1';
  if (seen) {
    const state = store.getState();
    if (!state.ui.holdCompareHintDismissed) {
      store.update({
        ui: { ...state.ui, holdCompareHintDismissed: true },
      });
    }
    return;
  }

  hint.style.display = 'block';
  window.setTimeout(() => {
    hint.style.display = 'none';
    window.localStorage.setItem(key, '1');
    const state = store.getState();
    if (!state.ui.holdCompareHintDismissed) {
      store.update({
        ui: { ...state.ui, holdCompareHintDismissed: true },
      });
    }
  }, 4600);
}

// ============ State Change Handler ============

function onStateChange(state: AppState, _prev: AppState): void {
  renderer.updateUniforms(state);
  renderer.requestRender();
  renderer.render();

  colorWheel.setState(state);
  colorWheel.draw(state);
  if (renderedWheelCanvas) {
    colorWheel.drawRendered(state, renderedWheelCanvas);
  }

  updatePanelUI(state);
  updateLayerTabs(state);
  updateHistogram();

  // Redraw xy diagram when calibration panel is visible
  if (state.ui.activeLayer === 'calibration') {
    drawXYDiagram(state);
  }

  // Redraw tone curve when toning panel is visible
  if (state.ui.activeLayer === 'toning') {
    drawToneCurve();
  }
}

// ============ Layer Tabs ============

function setupLayerTabs(): void {
  const tabs = document.querySelectorAll('.layer-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const layer = (tab as HTMLElement).dataset.layer as AppState['ui']['activeLayer'];
      const prev = store.getState();
      store.update({
        ui: {
          ...prev.ui,
          activeLayer: layer,
          colorPickerActive: layer === 'mapping' ? prev.ui.colorPickerActive : false,
        },
      });
    });
  });
}

function updateLayerTabs(state: AppState): void {
  document.querySelectorAll('.layer-tab').forEach((tab) => {
    const el = tab as HTMLElement;
    el.classList.toggle('active', el.dataset.layer === state.ui.activeLayer);
  });
}

// ============ Image Input ============

function setupImageInput(): void {
  const input = document.getElementById('image-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone') as HTMLElement;
  const loadBtn = document.getElementById('load-image-btn') as HTMLElement;

  const triggerPicker = (e?: Event) => {
    if (!input) return;
    if (e) e.preventDefault();
    try {
      const maybeShowPicker = (input as HTMLInputElement & { showPicker?: () => void }).showPicker;
      if (typeof maybeShowPicker === 'function') {
        maybeShowPicker.call(input);
        return;
      }
    } catch {
      // Fallback to click below.
    }
    input.click();
  };

  if (loadBtn) {
    loadBtn.addEventListener('click', triggerPicker);
    loadBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        triggerPicker(e);
      }
    });
  }

  if (input) {
    input.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) loadImageFile(file);
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) loadImageFile(file);
    });
  }
}

function loadImageFile(file: File): void {
  if (!file.type.startsWith('image/')) return;
  if (!renderer) {
    showError('Renderer is not initialized, image cannot be processed.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;

      // Create preview canvas (long edge <= resolution limit)
      const maxDim = store.getState().ui.previewResolution;
      previewCanvas = scaleImageToCanvas(img, maxDim);
      refreshDominantImageHues();

      // Size the GL canvas to match image resolution
      const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
      renderer.resize(previewCanvas.width, previewCanvas.height);

      // Set CSS size to fit container
      const container = document.getElementById('preview-container');
      if (container && glCanvas) {
        const rect = container.getBoundingClientRect();
        const aspect = previewCanvas.width / previewCanvas.height;
        let cssW = rect.width;
        let cssH = cssW / aspect;
        if (cssH > rect.height) {
          cssH = rect.height;
          cssW = cssH * aspect;
        }
        glCanvas.style.width = Math.floor(cssW) + 'px';
        glCanvas.style.height = Math.floor(cssH) + 'px';
      }

      renderer.loadImage(previewCanvas);
      const state = store.getState();
      renderer.updateUniforms(state);
      renderer.render();

      store.update({ imageLoaded: true });

      // Hide drop zone, show canvas
      const dropZone = document.getElementById('drop-zone');
      if (dropZone) dropZone.style.display = 'none';
      if (glCanvas) glCanvas.style.display = 'block';
    };
    img.src = e.target?.result as string;
  };
  reader.readAsDataURL(file);
}

function scaleImageToCanvas(img: HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(maxDim / Math.max(w, h), 1);

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(w * scale);
  canvas.height = Math.floor(h * scale);

  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return canvas;
}

function normalizeHue01(h: number): number {
  let hue = h % 1;
  if (hue < 0) hue += 1;
  return hue;
}

function extractDominantHuesFromCanvas(
  canvas: HTMLCanvasElement,
  topN = DOMINANT_HUE_COUNT,
  bins = DOMINANT_HUE_BINS,
): number[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  const { width, height } = canvas;
  if (width === 0 || height === 0) return [];

  const data = ctx.getImageData(0, 0, width, height).data;
  const hist = new Float32Array(bins);
  const totalPixels = width * height;
  const pixelStep = Math.max(1, Math.floor(Math.sqrt(totalPixels / 16000)));

  for (let y = 0; y < height; y += pixelStep) {
    for (let x = 0; x < width; x += pixelStep) {
      const idx = (y * width + x) * 4;
      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      const [h, s, v] = rgbToHsv(r, g, b);
      if (v < 0.04) continue;

      const bin = Math.floor(normalizeHue01(h) * bins) % bins;
      const chromaWeight = Math.max(0.16, s * s);
      const weight = chromaWeight * (0.35 + 0.65 * v);
      hist[bin] += weight;
    }
  }

  const smooth = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const prev = hist[(i - 1 + bins) % bins];
    const cur = hist[i];
    const next = hist[(i + 1) % bins];
    smooth[i] = prev * 0.25 + cur * 0.5 + next * 0.25;
  }

  const indices = Array.from({ length: bins }, (_, i) => i).sort((a, b) => smooth[b] - smooth[a]);
  const selected: number[] = [];
  const minGap = Math.max(2, Math.floor(bins / 14));

  for (const idx of indices) {
    if (smooth[idx] <= 0) break;
    const tooClose = selected.some((sIdx) => {
      const d = Math.abs(idx - sIdx);
      return Math.min(d, bins - d) < minGap;
    });
    if (tooClose) continue;
    selected.push(idx);
    if (selected.length >= topN) break;
  }

  if (selected.length === 0) {
    // Fallback: keep at least a few hue anchors for low-saturation images.
    selected.push(...indices.slice(0, Math.min(3, bins)));
  }

  return selected.sort((a, b) => a - b).map((idx) => (idx + 0.5) / bins);
}

function refreshDominantImageHues(): void {
  dominantImageHues = previewCanvas ? extractDominantHuesFromCanvas(previewCanvas) : [];
  if (colorWheel) {
    colorWheel.setImageHuePeaks(dominantImageHues);
  }
}

// ============ Toolbar ============

function setupToolbar(): void {
  const holdCompareBtn = document.getElementById('hold-compare-btn') as HTMLButtonElement | null;
  const setHoldCompare = (active: boolean) => {
    const state = store.getState();
    if (!state.imageLoaded) active = false;
    if (state.ui.holdCompareActive === active) return;
    store.update({
      ui: { ...state.ui, holdCompareActive: active },
    });
  };

  if (holdCompareBtn) {
    holdCompareBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setHoldCompare(true);
    });
    holdCompareBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      setHoldCompare(true);
    }, { passive: false });

    const release = () => setHoldCompare(false);
    holdCompareBtn.addEventListener('mouseup', release);
    holdCompareBtn.addEventListener('mouseleave', release);
    holdCompareBtn.addEventListener('touchend', release);
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);
  }

  // Reset All button
  const resetAllBtn = document.getElementById('reset-all-btn');
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      const state = store.getState();
      store.update({
        calibration: { ...DEFAULT_CALIBRATION },
        primaries: { ...DEFAULT_PRIMARIES },
        localMappings: [],
        globalHueShift: 0,
        toning: { ...DEFAULT_TONING },
        ui: {
          ...state.ui,
          splitPosition: 0.5,
          toneCurveEnabled: true,
          toneCurveBypassPreview: false,
          holdCompareActive: false,
        },
      }, true);
      resetToneCurve(true);
    });
  }

  // Per-module reset buttons
  document.querySelectorAll('.reset-module-btn').forEach((btn) => {
    const el = btn as HTMLElement;
    const module = el.dataset.module;
    el.addEventListener('click', () => {
      if (module === 'calibration') {
        store.update({
          calibration: { ...DEFAULT_CALIBRATION },
          primaries: { ...DEFAULT_PRIMARIES },
        }, true);
      } else if (module === 'mapping') {
        store.update({
          localMappings: [],
          globalHueShift: 0,
        }, true);
      } else if (module === 'toning') {
        const state = store.getState();
        store.update({
          toning: { ...DEFAULT_TONING },
          ui: {
            ...state.ui,
            toneCurveEnabled: true,
            toneCurveBypassPreview: false,
          },
        }, true);
        resetToneCurve(true);
      }
    });
  });

  // Split view button
  const splitBtn = document.getElementById('split-btn');
  if (splitBtn) {
    splitBtn.addEventListener('click', () => {
      const state = store.getState();
      store.update({
        ui: { ...state.ui, splitView: !state.ui.splitView },
      });
    });
  }

  // Undo/Redo
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.addEventListener('click', handleUndoAction);
  if (redoBtn) redoBtn.addEventListener('click', handleRedoAction);

  // Canvas click for color picker
  const glCanvas = document.getElementById('gl-canvas');
  if (glCanvas) {
    glCanvas.addEventListener('click', (e) => {
      const state = store.getState();
      if (!state.ui.colorPickerActive || !state.imageLoaded || state.ui.activeLayer !== 'mapping') return;

      const rect = glCanvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;

      const color = renderer.pickColor(nx, ny);
      if (color) {
        const [h, s, _v] = rgbToHsv(color[0], color[1], color[2]);
        handleColorPicked(h, s);
      }
    });
  }
}

function setupSplitDivider(): void {
  const divider = document.getElementById('split-divider');
  const container = document.getElementById('preview-container');
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!divider || !container || !glCanvas) return;

  let dragging = false;
  let lastClientX = 0;

  const updateFromClientX = (clientX: number, commitHistory: boolean) => {
    lastClientX = clientX;
    const canvasRect = glCanvas.getBoundingClientRect();
    if (canvasRect.width <= 0) return;
    const nx = (clientX - canvasRect.left) / canvasRect.width;
    const clamped = Math.max(0, Math.min(1, nx));
    const state = store.getState();
    store.update({
      ui: { ...state.ui, splitPosition: clamped },
    }, commitHistory);
  };

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    updateFromClientX(e.clientX, false);
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    updateFromClientX(e.clientX, true);
  });

  divider.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    dragging = true;
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (!dragging || !e.touches[0]) return;
    updateFromClientX(e.touches[0].clientX, false);
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (dragging) {
      updateFromClientX(lastClientX, true);
    }
    dragging = false;
  });

  container.addEventListener('dblclick', (e) => {
    const state = store.getState();
    if (!state.ui.splitView) return;
    updateFromClientX((e as MouseEvent).clientX, true);
  });
}

function updateSplitDividerUI(state: AppState): void {
  const divider = document.getElementById('split-divider') as HTMLElement | null;
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  const container = document.getElementById('preview-container') as HTMLElement | null;
  if (!divider || !glCanvas || !container) return;

  const visible = state.ui.splitView && state.imageLoaded;
  divider.style.display = visible ? 'flex' : 'none';
  if (!visible) return;

  const canvasRect = glCanvas.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const splitX = canvasRect.left - containerRect.left + canvasRect.width * state.ui.splitPosition;

  divider.style.left = `${Math.round(splitX)}px`;
  divider.style.top = `${Math.round(canvasRect.top - containerRect.top)}px`;
  divider.style.height = `${Math.round(canvasRect.height)}px`;
}

function setupWheelCompareToggle(): void {
  const btn = document.getElementById('wheel-compare-btn');
  const row = document.getElementById('wheels-row');
  if (!btn || !row) return;

  const labels = ['Compare: Left/Right', 'Compare: Inside/Outside'];
  let mode = 0;

  const applyMode = () => {
    row.classList.remove('wheels-compare-swap', 'wheels-compare-inside');
    if (mode === 1) row.classList.add('wheels-compare-inside');
    btn.textContent = labels[mode];

    // Force immediate redraw so marker visibility/positions reflect mode switch.
    const state = store.getState();
    colorWheel.draw(state);
    if (renderedWheelCanvas) {
      colorWheel.drawRendered(state, renderedWheelCanvas);
    }
  };

  applyMode();
  btn.addEventListener('click', () => {
    mode = (mode + 1) % labels.length;
    applyMode();
  });
}

function handleColorPicked(hue: number, _saturation: number): void {
  const state = store.getState();
  const id = 'mp_' + Date.now();
  const newMapping: LocalMapping = {
    id,
    srcHue: hue,
    dstHue: hue,
    range: 30 / 360,
    strength: 1.0,
  };

  store.update({
    localMappings: [...state.localMappings, newMapping],
    ui: {
      ...state.ui,
      activeLayer: 'mapping',
      selectedMappingId: id,
      colorPickerActive: false,
    },
  }, true);
}

// ============ Panels ============

function setupPanels(): void {
  setupCalibrationSliders();
  setupXYInputs();
  setupToningSliders();
  setupToneCurveControls();
  setupMappingControls();
}

// ============ Calibration Sliders ============

function setupCalibrationSliders(): void {
  const sliders = [
    { id: 'red-hue-slider', color: 'red' as const, param: 'hueShift' as const, min: -180, max: 180 },
    { id: 'red-sat-slider', color: 'red' as const, param: 'saturation' as const, min: -100, max: 100 },
    { id: 'green-hue-slider', color: 'green' as const, param: 'hueShift' as const, min: -180, max: 180 },
    { id: 'green-sat-slider', color: 'green' as const, param: 'saturation' as const, min: -100, max: 100 },
    { id: 'blue-hue-slider', color: 'blue' as const, param: 'hueShift' as const, min: -180, max: 180 },
    { id: 'blue-sat-slider', color: 'blue' as const, param: 'saturation' as const, min: -100, max: 100 },
  ];

  for (const s of sliders) {
    const el = document.getElementById(s.id) as HTMLInputElement;
    if (!el) continue;

    el.min = String(s.min);
    el.max = String(s.max);
    el.step = '0.1';

    el.addEventListener('input', () => {
      const state = store.getState();
      const newCalibration = {
        ...state.calibration,
        [s.color]: {
          ...state.calibration[s.color],
          [s.param]: parseFloat(el.value),
        },
      };
      const newPrimaries = calibrationToPrimaries(newCalibration);
      store.update({
        calibration: newCalibration,
        primaries: newPrimaries,
      });
    });

    el.addEventListener('change', () => {
      const state = store.getState();
      const newCalibration = {
        ...state.calibration,
        [s.color]: {
          ...state.calibration[s.color],
          [s.param]: parseFloat(el.value),
        },
      };
      const newPrimaries = calibrationToPrimaries(newCalibration);
      store.update({
        calibration: newCalibration,
        primaries: newPrimaries,
      }, true);
    });
  }
}

// ============ Collapsible XY Panel ============

function setupXYPanelToggle(): void {
  const toggle = document.getElementById('xy-panel-toggle');
  const panel = document.getElementById('xy-panel');
  const arrow = toggle?.querySelector('.xy-toggle-arrow');

  if (toggle && panel) {
    // Set initial visibility from state
    const state = store.getState();
    panel.style.display = state.ui.showXYPanel ? 'block' : 'none';
    if (arrow) {
      (arrow as HTMLElement).style.transform = state.ui.showXYPanel ? 'rotate(180deg)' : 'rotate(0deg)';
    }

    toggle.addEventListener('click', () => {
      const state = store.getState();
      const newShow = !state.ui.showXYPanel;
      store.update({
        ui: { ...state.ui, showXYPanel: newShow },
      });
      panel.style.display = newShow ? 'block' : 'none';
      if (arrow) {
        (arrow as HTMLElement).style.transform = newShow ? 'rotate(180deg)' : 'rotate(0deg)';
      }
    });
  }
}

function setupXYInputs(): void {
  const primaries = ['red', 'green', 'blue'] as const;

  for (const color of primaries) {
    const xInput = document.getElementById(`${color}-x-input`) as HTMLInputElement;
    const yInput = document.getElementById(`${color}-y-input`) as HTMLInputElement;

    if (xInput) {
      xInput.addEventListener('input', () => {
        const state = store.getState();
        const current = state.primaries[color];
        const newPrimaries = {
          ...state.primaries,
          [color]: [parseFloat(xInput.value) || current[0], current[1]] as [number, number],
        };
        const newCalibration = primariesToCalibration(newPrimaries);
        store.update({
          primaries: newPrimaries,
          calibration: newCalibration,
        });
      });
      xInput.addEventListener('change', () => {
        const state = store.getState();
        const current = state.primaries[color];
        const newPrimaries = {
          ...state.primaries,
          [color]: [parseFloat(xInput.value) || current[0], current[1]] as [number, number],
        };
        const newCalibration = primariesToCalibration(newPrimaries);
        store.update({
          primaries: newPrimaries,
          calibration: newCalibration,
        }, true);
      });
    }

    if (yInput) {
      yInput.addEventListener('input', () => {
        const state = store.getState();
        const current = state.primaries[color];
        const newPrimaries = {
          ...state.primaries,
          [color]: [current[0], parseFloat(yInput.value) || current[1]] as [number, number],
        };
        const newCalibration = primariesToCalibration(newPrimaries);
        store.update({
          primaries: newPrimaries,
          calibration: newCalibration,
        });
      });
      yInput.addEventListener('change', () => {
        const state = store.getState();
        const current = state.primaries[color];
        const newPrimaries = {
          ...state.primaries,
          [color]: [current[0], parseFloat(yInput.value) || current[1]] as [number, number],
        };
        const newCalibration = primariesToCalibration(newPrimaries);
        store.update({
          primaries: newPrimaries,
          calibration: newCalibration,
        }, true);
      });
    }
  }
}

// ============ Toning Sliders ============

function setupToningSliders(): void {
  const sliders = [
    { id: 'exposure-slider', key: 'exposure', min: -1, max: 1, step: 0.01 },
    { id: 'contrast-slider', key: 'contrast', min: 0, max: 2.0, step: 0.005 },
    { id: 'highlights-slider', key: 'highlights', min: -0.5, max: 0.5, step: 0.005 },
    { id: 'shadows-slider', key: 'shadows', min: -0.5, max: 0.5, step: 0.005 },
    { id: 'whites-slider', key: 'whites', min: -0.5, max: 0.5, step: 0.005 },
    { id: 'blacks-slider', key: 'blacks', min: -0.5, max: 0.5, step: 0.005 },
  ];

  for (const s of sliders) {
    const el = document.getElementById(s.id) as HTMLInputElement;
    if (!el) continue;

    el.min = String(s.min);
    el.max = String(s.max);
    el.step = String(s.step);
    const valEl = document.getElementById(s.id + '-val') as HTMLInputElement | null;
    if (valEl) {
      valEl.min = String(s.min);
      valEl.max = String(s.max);
      valEl.step = String(s.step);
    }

    el.addEventListener('input', () => {
      const state = store.getState();
      store.update({
        toning: { ...state.toning, [s.key]: parseFloat(el.value) },
      });
    });

    el.addEventListener('change', () => {
      const state = store.getState();
      store.update({
        toning: { ...state.toning, [s.key]: parseFloat(el.value) },
      }, true);
    });
  }

  // Global hue shift slider
  const hueSlider = document.getElementById('global-hue-slider') as HTMLInputElement;
  if (hueSlider) {
    hueSlider.addEventListener('input', () => {
      store.update({ globalHueShift: parseFloat(hueSlider.value) });
    });
    hueSlider.addEventListener('change', () => {
      store.update({ globalHueShift: parseFloat(hueSlider.value) }, true);
    });
  }
}

function setupToneCurveControls(): void {
  const enableBtn = document.getElementById('tone-curve-enable-btn') as HTMLButtonElement | null;
  const bypassBtn = document.getElementById('tone-curve-bypass-btn') as HTMLButtonElement | null;
  if (!enableBtn || !bypassBtn) return;

  enableBtn.addEventListener('click', () => {
    const state = store.getState();
    store.update({
      ui: {
        ...state.ui,
        toneCurveEnabled: !state.ui.toneCurveEnabled,
      },
    }, true);
  });

  bypassBtn.addEventListener('click', () => {
    const state = store.getState();
    store.update({
      ui: {
        ...state.ui,
        toneCurveBypassPreview: !state.ui.toneCurveBypassPreview,
      },
    });
  });

  updateToneCurveControlUI(store.getState());
}

function updateToneCurveControlUI(state: AppState): void {
  const enableBtn = document.getElementById('tone-curve-enable-btn') as HTMLButtonElement | null;
  const bypassBtn = document.getElementById('tone-curve-bypass-btn') as HTMLButtonElement | null;
  if (!enableBtn || !bypassBtn) return;

  enableBtn.textContent = state.ui.toneCurveEnabled ? 'Tone Curve: On' : 'Tone Curve: Off';
  enableBtn.classList.toggle('active', state.ui.toneCurveEnabled);

  bypassBtn.textContent = state.ui.toneCurveBypassPreview ? 'A/B: Bypass' : 'A/B: Processed';
  bypassBtn.classList.toggle('active', state.ui.toneCurveBypassPreview);
  bypassBtn.disabled = !state.ui.toneCurveEnabled;
}

// ============ Mapping Controls ============

function setupMappingControls(): void {
  const addBtn = document.getElementById('add-mapping-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => handleMappingAdd(0));
  }

  const pickerBtn = document.getElementById('add-mapping-picker-btn');
  if (pickerBtn) {
    pickerBtn.addEventListener('click', () => {
      const state = store.getState();
      store.update({
        ui: {
          ...state.ui,
          activeLayer: 'mapping',
          colorPickerActive: !state.ui.colorPickerActive,
        },
      });
    });
  }

  const deleteBtn = document.getElementById('delete-mapping-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const state = store.getState();
      if (state.ui.selectedMappingId) {
        store.update({
          localMappings: state.localMappings.filter(m => m.id !== state.ui.selectedMappingId),
          ui: { ...state.ui, selectedMappingId: null },
        }, true);
      }
    });
  }

  // Mapping detail sliders
  const srcSlider = document.getElementById('mapping-src-slider') as HTMLInputElement;
  const dstSlider = document.getElementById('mapping-dst-slider') as HTMLInputElement;
  const rangeSlider = document.getElementById('mapping-range-slider') as HTMLInputElement;
  const strengthSlider = document.getElementById('mapping-strength-slider') as HTMLInputElement;

  const updateMapping = (field: keyof LocalMapping, value: number) => {
    const state = store.getState();
    const sel = state.ui.selectedMappingId;
    if (!sel) return;
    store.update({
      localMappings: state.localMappings.map(m =>
        m.id === sel ? { ...m, [field]: value } : m
      ),
    });
  };

  const commitMapping = (field: keyof LocalMapping, value: number) => {
    const state = store.getState();
    const sel = state.ui.selectedMappingId;
    if (!sel) return;
    store.update({
      localMappings: state.localMappings.map(m =>
        m.id === sel ? { ...m, [field]: value } : m
      ),
    }, true);
  };

  if (srcSlider) {
    srcSlider.addEventListener('input', () => updateMapping('srcHue', parseFloat(srcSlider.value)));
    srcSlider.addEventListener('change', () => commitMapping('srcHue', parseFloat(srcSlider.value)));
  }
  if (dstSlider) {
    dstSlider.addEventListener('input', () => updateMapping('dstHue', parseFloat(dstSlider.value)));
    dstSlider.addEventListener('change', () => commitMapping('dstHue', parseFloat(dstSlider.value)));
  }
  if (rangeSlider) {
    rangeSlider.addEventListener('input', () => updateMapping('range', parseFloat(rangeSlider.value)));
    rangeSlider.addEventListener('change', () => commitMapping('range', parseFloat(rangeSlider.value)));
  }
  if (strengthSlider) {
    strengthSlider.addEventListener('input', () => updateMapping('strength', parseFloat(strengthSlider.value)));
    strengthSlider.addEventListener('change', () => commitMapping('strength', parseFloat(strengthSlider.value)));
  }
}

// ============ Preset System ============

function setupPresets(): void {
  renderPresetList();

  const saveBtn = document.getElementById('save-preset-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const name = prompt('Preset name:');
      if (!name) return;

      const state = store.getState();
      const preset = state.ui.activeLayer === 'mapping'
        ? createCreativeMappingPreset(name, state)
        : createColorStylePreset(name, state);

      savePreset(preset);
      renderPresetList();
    });
  }

  const importBtn = document.getElementById('import-preset-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const preset = importPresetFromJSON(e.target?.result as string);
          if (preset) {
            savePreset(preset);
            renderPresetList();
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });
  }
}

function renderPresetList(): void {
  const container = document.getElementById('preset-list');
  if (!container) return;

  const allPresets = [...BUILTIN_PRESETS, ...getStoredPresets()];

  container.innerHTML = allPresets.map((preset, i) => `
    <button class="preset-item" data-index="${i}" data-builtin="${i < BUILTIN_PRESETS.length}">
      <span class="preset-name">${preset.name}</span>
      <span class="preset-type">${preset.type === 'color_style' ? 'Style' : 'Mapping'}</span>
    </button>
  `).join('');

  container.querySelectorAll('.preset-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.index!);
      const preset = allPresets[idx];
      const state = store.getState();
      const updates = applyPreset(preset, state);
      store.update(updates, true);
    });
  });
}

// ============ Export ============

function setupExport(): void {
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportImage);
  }
}

function exportImage(): void {
  if (!originalImage) return;

  const state = store.getState();

  // Create temporary full-resolution canvas
  const offCanvas = document.createElement('canvas');
  const maxExport = Math.min(originalImage.naturalWidth, 4096);
  const scale = maxExport / Math.max(originalImage.naturalWidth, originalImage.naturalHeight);
  offCanvas.width = Math.floor(originalImage.naturalWidth * Math.min(scale, 1));
  offCanvas.height = Math.floor(originalImage.naturalHeight * Math.min(scale, 1));

  try {
    const exportRenderer = new Renderer(offCanvas);
    exportRenderer.loadImage(originalImage);
    exportRenderer.setToneCurveLut(buildToneCurveLut());
    exportRenderer.updateUniforms(exportState);
    exportRenderer.render();

    // Download
    offCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'color-toy-export.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');

    exportRenderer.destroy();
  } catch (e) {
    console.error('Export failed:', e);
  }
}

// ============ Keyboard Shortcuts ============

function setupKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndoAction();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        handleRedoAction();
      } else if (e.key === 's') {
        e.preventDefault();
        exportImage();
      }
    }

    // Layer switching with 1,2,3 keys
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const state = store.getState();
      if (e.key === '1') {
        store.update({ ui: { ...state.ui, activeLayer: 'calibration' } });
      } else if (e.key === '2') {
        store.update({ ui: { ...state.ui, activeLayer: 'mapping' } });
      } else if (e.key === '3') {
        store.update({ ui: { ...state.ui, activeLayer: 'toning' } });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selected mapping
        if (state.ui.selectedMappingId && state.ui.activeLayer === 'mapping') {
          store.update({
            localMappings: state.localMappings.filter(m => m.id !== state.ui.selectedMappingId),
            ui: { ...state.ui, selectedMappingId: null },
          }, true);
        }
      }
    }
  });
}

// ============ Editable Value Inputs ============

/** Wire up all .val-input elements to sync with their paired range sliders */
function setupValInputs(): void {
  // Map of slider-id -> { stateKey, category, subKey }
  const calSliders = [
    { sliderId: 'red-hue-slider', color: 'red' as const, param: 'hueShift' as const },
    { sliderId: 'red-sat-slider', color: 'red' as const, param: 'saturation' as const },
    { sliderId: 'green-hue-slider', color: 'green' as const, param: 'hueShift' as const },
    { sliderId: 'green-sat-slider', color: 'green' as const, param: 'saturation' as const },
    { sliderId: 'blue-hue-slider', color: 'blue' as const, param: 'hueShift' as const },
    { sliderId: 'blue-sat-slider', color: 'blue' as const, param: 'saturation' as const },
  ];
  for (const s of calSliders) {
    const valInput = document.getElementById(s.sliderId + '-val') as HTMLInputElement;
    const rangeInput = document.getElementById(s.sliderId) as HTMLInputElement;
    if (!valInput || !rangeInput) continue;
    valInput.addEventListener('input', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('input'));
    });
    valInput.addEventListener('change', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('change'));
    });
  }

  const toningSliders = [
    'exposure-slider', 'contrast-slider', 'highlights-slider',
    'shadows-slider', 'whites-slider', 'blacks-slider',
    'global-hue-slider',
  ];
  for (const sliderId of toningSliders) {
    const valInput = document.getElementById(sliderId + '-val') as HTMLInputElement;
    const rangeInput = document.getElementById(sliderId) as HTMLInputElement;
    if (!valInput || !rangeInput) continue;
    valInput.addEventListener('input', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('input'));
    });
    valInput.addEventListener('change', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('change'));
    });
  }

  const mappingSliders = [
    'mapping-src-slider', 'mapping-dst-slider',
    'mapping-range-slider', 'mapping-strength-slider',
  ];
  for (const sliderId of mappingSliders) {
    const valInput = document.getElementById(sliderId + '-val') as HTMLInputElement;
    const rangeInput = document.getElementById(sliderId) as HTMLInputElement;
    if (!valInput || !rangeInput) continue;
    valInput.addEventListener('input', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('input'));
    });
    valInput.addEventListener('change', () => {
      const v = parseFloat(valInput.value);
      if (isNaN(v)) return;
      const clamped = Math.max(parseFloat(rangeInput.min), Math.min(parseFloat(rangeInput.max), v));
      rangeInput.value = String(clamped);
      rangeInput.dispatchEvent(new Event('change'));
    });
  }
}

// ============ Double-Click Slider Reset ============

/** Double-click any range slider to reset it to its default value */
function setupDoubleClickReset(): void {
  const defaults: Record<string, number> = {
    'red-hue-slider': 0, 'red-sat-slider': 0,
    'green-hue-slider': 0, 'green-sat-slider': 0,
    'blue-hue-slider': 0, 'blue-sat-slider': 0,
    'exposure-slider': 0, 'contrast-slider': 1,
    'highlights-slider': 0, 'shadows-slider': 0,
    'whites-slider': 0, 'blacks-slider': 0,
    'global-hue-slider': 0,
    'mapping-src-slider': 0, 'mapping-dst-slider': 0,
    'mapping-range-slider': 0.083, 'mapping-strength-slider': 1,
  };

  for (const [id, defaultVal] of Object.entries(defaults)) {
    const el = document.getElementById(id) as HTMLInputElement;
    if (!el) continue;
    el.addEventListener('dblclick', () => {
      el.value = String(defaultVal);
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    });
  }
}

// ============ xy Chromaticity Diagram ============

let xyDragTarget: 'red' | 'green' | 'blue' | null = null;

function setupXYDiagram(): void {
  const canvas = document.getElementById('xy-diagram-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  const getCanvasPos = (e: MouseEvent | Touch) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const xyToCanvas = (cx: number, cy: number, w: number, h: number): { px: number; py: number } => {
    const margin = 24;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    return {
      px: margin + cx * plotW,
      py: margin + (1 - cy) * plotH,
    };
  };

  const canvasToXY = (px: number, py: number, w: number, h: number): { x: number; y: number } => {
    const margin = 24;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    return {
      x: Math.max(0.01, Math.min(0.99, (px - margin) / plotW)),
      y: Math.max(0.01, Math.min(0.99, 1 - (py - margin) / plotH)),
    };
  };

  const hitTest = (px: number, py: number, w: number, h: number, state: AppState): 'red' | 'green' | 'blue' | null => {
    const primaries = state.primaries;
    const targets = [
      { color: 'red' as const, xy: primaries.red },
      { color: 'green' as const, xy: primaries.green },
      { color: 'blue' as const, xy: primaries.blue },
    ];
    for (const t of targets) {
      const { px: tx, py: ty } = xyToCanvas(t.xy[0], t.xy[1], w, h);
      const d = Math.sqrt((px - tx) ** 2 + (py - ty) ** 2);
      if (d < 14) return t.color;
    }
    return null;
  };

  canvas.addEventListener('mousedown', (e) => {
    const state = store.getState();
    const pos = getCanvasPos(e);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    xyDragTarget = hitTest(pos.x, pos.y, cssW, cssH, state);
  });

  window.addEventListener('mousemove', (e) => {
    if (!xyDragTarget) return;
    const pos = getCanvasPos(e);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const { x, y } = canvasToXY(pos.x, pos.y, cssW, cssH);
    const state = store.getState();
    const newPrimaries = {
      ...state.primaries,
      [xyDragTarget]: [x, y] as [number, number],
    };
    const newCalibration = primariesToCalibration(newPrimaries);
    store.update({ primaries: newPrimaries, calibration: newCalibration });
  });

  window.addEventListener('mouseup', () => {
    if (xyDragTarget) {
      const state = store.getState();
      store.update({
        primaries: { ...state.primaries },
        calibration: { ...state.calibration },
      }, true);
      xyDragTarget = null;
    }
  });

  // Touch
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const state = store.getState();
    const pos = getCanvasPos(e.touches[0]);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    xyDragTarget = hitTest(pos.x, pos.y, cssW, cssH, state);
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (!xyDragTarget) return;
    const pos = getCanvasPos(e.touches[0]);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const { x, y } = canvasToXY(pos.x, pos.y, cssW, cssH);
    const state = store.getState();
    const newPrimaries = {
      ...state.primaries,
      [xyDragTarget]: [x, y] as [number, number],
    };
    const newCalibration = primariesToCalibration(newPrimaries);
    store.update({ primaries: newPrimaries, calibration: newCalibration });
  });

  window.addEventListener('touchend', () => {
    if (xyDragTarget) {
      const state = store.getState();
      store.update({
        primaries: { ...state.primaries },
        calibration: { ...state.calibration },
      }, true);
      xyDragTarget = null;
    }
  });
}

function drawXYDiagram(state: AppState): void {
  const canvas = document.getElementById('xy-diagram-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const margin = 24;
  const plotW = cssW - margin * 2;
  const plotH = cssH - margin * 2;

  ctx.clearRect(0, 0, cssW, cssH);

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const bg = readCssVar('--bg-primary', '#101318');
  const grid = isLight ? 'rgba(14,32,52,0.12)' : 'rgba(255,255,255,0.09)';
  const labels = isLight ? 'rgba(28,48,75,0.45)' : 'rgba(255,255,255,0.35)';
  const textStrong = isLight ? '#12243a' : '#f0f4fb';
  const accentStroke = isLight ? 'rgba(35,124,232,0.8)' : 'rgba(60,137,255,0.85)';

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Grid lines
  ctx.strokeStyle = grid;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 10; i++) {
    const v = i / 10;
    const px = margin + v * plotW;
    const py = margin + (1 - v) * plotH;
    ctx.beginPath(); ctx.moveTo(px, margin); ctx.lineTo(px, margin + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin, py); ctx.lineTo(margin + plotW, py); ctx.stroke();
  }

  // Axis labels
  ctx.fillStyle = labels;
  ctx.font = '8px system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const v = (i * 0.2).toFixed(1);
    const px = margin + (i / 5) * plotW;
    const py = margin + (1 - i / 5) * plotH;
    ctx.fillText(v, px, margin + plotH + 12);
    ctx.textAlign = 'right';
    ctx.fillText(v, margin - 4, py + 3);
    ctx.textAlign = 'center';
  }

  // Spectral locus (simplified horseshoe boundary)
  const spectralPoints: [number, number][] = [
    [0.175, 0.005], [0.174, 0.050], [0.170, 0.100], [0.164, 0.150],
    [0.150, 0.220], [0.124, 0.310], [0.090, 0.370], [0.065, 0.430],
    [0.045, 0.490], [0.023, 0.555], [0.008, 0.605], [0.004, 0.640],
    [0.012, 0.670], [0.040, 0.710], [0.075, 0.735], [0.120, 0.755],
    [0.170, 0.770], [0.220, 0.775], [0.270, 0.770], [0.320, 0.755],
    [0.370, 0.730], [0.420, 0.700], [0.465, 0.665], [0.510, 0.625],
    [0.550, 0.580], [0.590, 0.535], [0.625, 0.485], [0.655, 0.440],
    [0.690, 0.395], [0.710, 0.355], [0.720, 0.320], [0.725, 0.290],
    [0.735, 0.265],
  ];

  ctx.beginPath();
  for (let i = 0; i < spectralPoints.length; i++) {
    const px = margin + spectralPoints[i][0] * plotW;
    const py = margin + (1 - spectralPoints[i][1]) * plotH;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = isLight ? 'rgba(20,36,58,0.05)' : 'rgba(255,255,255,0.03)';
  ctx.fill();
  ctx.strokeStyle = isLight ? 'rgba(20,36,58,0.25)' : 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // sRGB gamut triangle (dashed)
  const srgbPts = [SRGB_RED_XY, SRGB_GREEN_XY, SRGB_BLUE_XY];
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const px = margin + srgbPts[i][0] * plotW;
    const py = margin + (1 - srgbPts[i][1]) * plotH;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = isLight ? 'rgba(20,36,58,0.2)' : 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // Current primaries gamut triangle
  const primaries = state.primaries;
  const curPts = [primaries.red, primaries.green, primaries.blue];
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const px = margin + curPts[i][0] * plotW;
    const py = margin + (1 - curPts[i][1]) * plotH;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = accentStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // D65 white point
  const wpx = margin + D65_WHITE_XY[0] * plotW;
  const wpy = margin + (1 - D65_WHITE_XY[1]) * plotH;
  ctx.beginPath();
  ctx.arc(wpx, wpy, 3, 0, Math.PI * 2);
  ctx.fillStyle = textStrong;
  ctx.fill();
  ctx.strokeStyle = isLight ? 'rgba(20,36,58,0.45)' : 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Primary points (draggable)
  const primDraw = [
    { xy: primaries.red, color: '#ff3333', label: 'R' },
    { xy: primaries.green, color: '#33cc33', label: 'G' },
    { xy: primaries.blue, color: '#3366ff', label: 'B' },
  ];
  for (const p of primDraw) {
    const px = margin + p.xy[0] * plotW;
    const py = margin + (1 - p.xy[1]) * plotH;
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = textStrong;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = textStrong;
    ctx.font = 'bold 8px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, px, py);
  }
}

// ============ Tone Curve ============

// Control points for the tone curve: array of {x, y} in [0,1]
let toneCurvePoints: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 },
  { x: 1, y: 1 },
];
let tcDragIdx: number | null = null;
let toneCurveHistory: ToneCurvePoint[][] = [];
let toneCurveHistoryIndex = -1;

function cloneToneCurvePoints(points: ToneCurvePoint[]): ToneCurvePoint[] {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

function pushToneCurveHistory(): void {
  const snapshot = cloneToneCurvePoints(toneCurvePoints);
  toneCurveHistory = toneCurveHistory.slice(0, toneCurveHistoryIndex + 1);
  toneCurveHistory.push(snapshot);
  if (toneCurveHistory.length > 40) {
    toneCurveHistory.shift();
  }
  toneCurveHistoryIndex = toneCurveHistory.length - 1;
}

function canUndoToneCurve(): boolean {
  return toneCurveHistoryIndex > 0;
}

function canRedoToneCurve(): boolean {
  return toneCurveHistoryIndex >= 0 && toneCurveHistoryIndex < toneCurveHistory.length - 1;
}

function undoToneCurve(): boolean {
  if (!canUndoToneCurve()) return false;
  toneCurveHistoryIndex--;
  toneCurvePoints = cloneToneCurvePoints(toneCurveHistory[toneCurveHistoryIndex]);
  drawToneCurve();
  return true;
}

function redoToneCurve(): boolean {
  if (!canRedoToneCurve()) return false;
  toneCurveHistoryIndex++;
  toneCurvePoints = cloneToneCurvePoints(toneCurveHistory[toneCurveHistoryIndex]);
  drawToneCurve();
  return true;
}

function resetToneCurve(pushHistory = false): void {
  toneCurvePoints = [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.25 },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.75 },
    { x: 1, y: 1 },
  ];
  if (pushHistory) pushToneCurveHistory();
  drawToneCurve();
}

function buildToneCurveLut(): Float32Array {
  const lut = new Float32Array(TONE_CURVE_LUT_SIZE);
  for (let i = 0; i < TONE_CURVE_LUT_SIZE; i++) {
    const t = i / (TONE_CURVE_LUT_SIZE - 1);
    lut[i] = evalCurve(t, toneCurvePoints);
  }
  return lut;
}

function updateToneCurveGPU(): void {
  if (!renderer) return;
  renderer.setToneCurveLut(buildToneCurveLut());
  renderer.requestRender();
  renderer.render();
}

function handleUndoAction(): void {
  const state = store.getState();
  if (state.ui.activeLayer === 'toning' && undoToneCurve()) {
    return;
  }
  store.undo();
}

function handleRedoAction(): void {
  const state = store.getState();
  if (state.ui.activeLayer === 'toning' && redoToneCurve()) {
    return;
  }
  store.redo();
}

function setupToneCurve(): void {
  const canvas = document.getElementById('tone-curve-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  if (toneCurveHistory.length === 0) {
    pushToneCurveHistory();
  }

  const margin = 20;

  const getPos = (e: MouseEvent | Touch) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const pixToNorm = (px: number, py: number) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    return {
      x: Math.max(0, Math.min(1, (px - margin) / plotW)),
      y: Math.max(0, Math.min(1, 1 - (py - margin) / plotH)),
    };
  };

  const normToPix = (nx: number, ny: number) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2;
    return {
      px: margin + nx * plotW,
      py: margin + (1 - ny) * plotH,
    };
  };

  const hitTestPoint = (mx: number, my: number): number | null => {
    for (let i = 0; i < toneCurvePoints.length; i++) {
      const { px, py } = normToPix(toneCurvePoints[i].x, toneCurvePoints[i].y);
      const d = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
      if (d < 12) return i;
    }
    return null;
  };

  canvas.addEventListener('mousedown', (e) => {
    const pos = getPos(e);
    const idx = hitTestPoint(pos.x, pos.y);
    if (idx !== null) {
      // Don't allow dragging endpoints off the edges
      tcDragIdx = idx;
    } else {
      // Add new point
      const norm = pixToNorm(pos.x, pos.y);
      // Insert maintaining x-sorted order
      let insertIdx = toneCurvePoints.length;
      for (let i = 0; i < toneCurvePoints.length; i++) {
        if (norm.x < toneCurvePoints[i].x) { insertIdx = i; break; }
      }
      toneCurvePoints.splice(insertIdx, 0, norm);
      tcDragIdx = insertIdx;
      pushToneCurveHistory();
      drawToneCurve();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (tcDragIdx === null) return;
    const pos = getPos(e);
    const norm = pixToNorm(pos.x, pos.y);
    // First and last points are pinned on x axis
    if (tcDragIdx === 0) {
      toneCurvePoints[0].y = norm.y;
    } else if (tcDragIdx === toneCurvePoints.length - 1) {
      toneCurvePoints[tcDragIdx].y = norm.y;
    } else {
      // Constrain x between neighbors
      const prev = toneCurvePoints[tcDragIdx - 1].x + 0.01;
      const next = toneCurvePoints[tcDragIdx + 1].x - 0.01;
      toneCurvePoints[tcDragIdx].x = Math.max(prev, Math.min(next, norm.x));
      toneCurvePoints[tcDragIdx].y = norm.y;
    }
    drawToneCurve();
  });

  window.addEventListener('mouseup', () => {
    if (tcDragIdx !== null) pushToneCurveHistory();
    tcDragIdx = null;
  });

  // Double-click to remove a point (not endpoints)
  canvas.addEventListener('dblclick', (e) => {
    const pos = getPos(e);
    const idx = hitTestPoint(pos.x, pos.y);
    if (idx !== null && idx > 0 && idx < toneCurvePoints.length - 1) {
      toneCurvePoints.splice(idx, 1);
      pushToneCurveHistory();
      drawToneCurve();
    }
  });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const pos = getPos(e.touches[0]);
    const idx = hitTestPoint(pos.x, pos.y);
    if (idx !== null) {
      tcDragIdx = idx;
    } else {
      const norm = pixToNorm(pos.x, pos.y);
      let insertIdx = toneCurvePoints.length;
      for (let i = 0; i < toneCurvePoints.length; i++) {
        if (norm.x < toneCurvePoints[i].x) { insertIdx = i; break; }
      }
      toneCurvePoints.splice(insertIdx, 0, norm);
      tcDragIdx = insertIdx;
      pushToneCurveHistory();
      drawToneCurve();
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (tcDragIdx === null) return;
    const pos = getPos(e.touches[0]);
    const norm = pixToNorm(pos.x, pos.y);
    if (tcDragIdx === 0) {
      toneCurvePoints[0].y = norm.y;
    } else if (tcDragIdx === toneCurvePoints.length - 1) {
      toneCurvePoints[tcDragIdx].y = norm.y;
    } else {
      const prev = toneCurvePoints[tcDragIdx - 1].x + 0.01;
      const next = toneCurvePoints[tcDragIdx + 1].x - 0.01;
      toneCurvePoints[tcDragIdx].x = Math.max(prev, Math.min(next, norm.x));
      toneCurvePoints[tcDragIdx].y = norm.y;
    }
    drawToneCurve();
  });

  window.addEventListener('touchend', () => {
    if (tcDragIdx !== null) pushToneCurveHistory();
    tcDragIdx = null;
  });
}

function drawToneCurve(): void {
  const canvas = document.getElementById('tone-curve-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const margin = 20;
  const plotW = cssW - margin * 2;
  const plotH = cssH - margin * 2;

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const bg = readCssVar('--bg-primary', '#101318');
  const border = isLight ? 'rgba(14,32,52,0.12)' : 'rgba(255,255,255,0.09)';
  const textStrong = isLight ? '#12243a' : '#f0f4fb';
  const accentCurve = isLight ? 'rgba(36,126,236,0.9)' : 'rgba(64,148,255,0.92)';

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Grid
  ctx.strokeStyle = border;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const v = i / 4;
    const px = margin + v * plotW;
    const py = margin + (1 - v) * plotH;
    ctx.beginPath(); ctx.moveTo(px, margin); ctx.lineTo(px, margin + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin, py); ctx.lineTo(margin + plotW, py); ctx.stroke();
  }

  // Diagonal reference line
  ctx.beginPath();
  ctx.moveTo(margin, margin + plotH);
  ctx.lineTo(margin + plotW, margin);
  ctx.strokeStyle = isLight ? 'rgba(18,38,60,0.26)' : 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Interpolated curve using monotone cubic spline
  const pts = toneCurvePoints;
  if (pts.length < 2) return;

  ctx.beginPath();
  const steps = 200;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const y = evalCurve(t, pts);
    const px = margin + t * plotW;
    const py = margin + (1 - y) * plotH;
    if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = accentCurve;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Control points
  for (let i = 0; i < pts.length; i++) {
    const px = margin + pts[i].x * plotW;
    const py = margin + (1 - pts[i].y) * plotH;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = i === tcDragIdx ? textStrong : (isLight ? 'rgba(18,36,58,0.7)' : 'rgba(255,255,255,0.75)');
    ctx.fill();
    ctx.strokeStyle = isLight ? 'rgba(36,126,236,0.72)' : 'rgba(64,148,255,0.72)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  updateToneCurveGPU();
}

/** Evaluate the tone curve at position t using monotone cubic interpolation */
function evalCurve(t: number, pts: { x: number; y: number }[]): number {
  if (pts.length === 0) return t;
  if (t <= pts[0].x) return pts[0].y;
  if (t >= pts[pts.length - 1].x) return pts[pts.length - 1].y;

  // Find segment
  let i = 0;
  for (; i < pts.length - 1; i++) {
    if (t >= pts[i].x && t <= pts[i + 1].x) break;
  }

  const x0 = pts[i].x, y0 = pts[i].y;
  const x1 = pts[i + 1].x, y1 = pts[i + 1].y;
  const dx = x1 - x0;
  if (dx < 0.0001) return y0;

  // Simple cubic Hermite with estimated tangents
  const m0 = i > 0
    ? (pts[i + 1].y - pts[i - 1].y) / (pts[i + 1].x - pts[i - 1].x)
    : (y1 - y0) / dx;
  const m1 = i < pts.length - 2
    ? (pts[i + 2].y - pts[i].y) / (pts[i + 2].x - pts[i].x)
    : (y1 - y0) / dx;

  const f = (t - x0) / dx;
  const f2 = f * f;
  const f3 = f2 * f;

  const h00 = 2 * f3 - 3 * f2 + 1;
  const h10 = f3 - 2 * f2 + f;
  const h01 = -2 * f3 + 3 * f2;
  const h11 = f3 - f2;

  return Math.max(0, Math.min(1, h00 * y0 + h10 * dx * m0 + h01 * y1 + h11 * dx * m1));
}

// ============ Color Wheel Callbacks ============

function handlePrimaryChange(color: string, hue: number, sat: number): void {
  const state = store.getState();
  // Convert hue/sat back to approximate chromaticity coordinates
  const wx = 0.3127, wy = 0.3290;
  const angle = hue * Math.PI * 2;
  const dist = sat * 0.4;
  const x = wx + Math.cos(angle) * dist;
  const y = wy + Math.sin(angle) * dist;

  const newPrimaries = {
    ...state.primaries,
    [color]: [Math.max(0.01, Math.min(0.99, x)), Math.max(0.01, Math.min(0.99, y))] as [number, number],
  };

  // Reverse-compute calibration from the new primaries
  const newCalibration = primariesToCalibration(newPrimaries);

  store.update({
    primaries: newPrimaries,
    calibration: newCalibration,
  });
}

function handleMappingHueChange(id: string, hue: number): void {
  const state = store.getState();
  store.update({
    localMappings: state.localMappings.map(m =>
      m.id === id ? { ...m, srcHue: hue } : m
    ),
  });
}

function handleMappingAdd(hue: number): void {
  const state = store.getState();
  if (state.localMappings.length >= (renderer?.capabilities.maxMappings ?? 8)) return;

  const id = 'mp_' + Date.now();
  store.update({
    localMappings: [...state.localMappings, {
      id,
      srcHue: hue,
      dstHue: hue,
      range: 30 / 360,
      strength: 1.0,
    }],
    ui: { ...state.ui, selectedMappingId: id },
  }, true);
}

function handleGlobalHueChange(shift: number): void {
  store.update({ globalHueShift: shift });
}

function handleMappingSelect(id: string | null): void {
  const state = store.getState();
  store.update({
    ui: { ...state.ui, selectedMappingId: id },
  });
}

function handleDragEnd(): void {
  // Push to history after drag completes
  const state = store.getState();
  store.update({
    calibration: { ...state.calibration },
    primaries: { ...state.primaries },
    localMappings: [...state.localMappings],
    globalHueShift: state.globalHueShift,
  }, true);
}

// ============ Performance Monitor ============

function setupPerformanceMonitor(): void {
  renderer.onFps((fps) => {
    // Auto-downgrade resolution if needed
    if (fps < 20) {
      const state = store.getState();
      if (state.ui.previewResolution > 512 && previewCanvas && originalImage) {
        const newRes = state.ui.previewResolution === 1080 ? 720 : 512;
        store.update({
          ui: { ...state.ui, previewResolution: newRes as 1080 | 720 | 512 },
        });
        previewCanvas = scaleImageToCanvas(originalImage, newRes);
        refreshDominantImageHues();
        renderer.loadImage(previewCanvas);
      }
    }
  });
}

// ============ Histogram ============

function updateHistogram(): void {
  const now = performance.now();
  if (now - lastHistogramTime < HISTOGRAM_INTERVAL) return;
  lastHistogramTime = now;

  requestAnimationFrame(() => {
    drawHistogram();
  });
}

function drawHistogram(): void {
  const histCanvas = document.getElementById('histogram-canvas') as HTMLCanvasElement;
  if (!histCanvas) return;

  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  if (!glCanvas || !store.getState().imageLoaded) return;

  const ctx = histCanvas.getContext('2d');
  if (!ctx) return;

  // Read pixels from the GL canvas
  const gl = (glCanvas.getContext('webgl2') || glCanvas.getContext('webgl')) as WebGLRenderingContext | null;
  if (!gl) return;

  const w = glCanvas.width;
  const h = glCanvas.height;

  // Sample a subset for performance (every Nth pixel)
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(w * h / 10000)));
  const sampleW = Math.ceil(w / sampleStep);
  const sampleH = Math.ceil(h / sampleStep);

  // Read the full framebuffer once
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // Build per-channel histograms (256 bins)
  const rHist = new Uint32Array(256);
  const gHist = new Uint32Array(256);
  const bHist = new Uint32Array(256);

  for (let sy = 0; sy < sampleH; sy++) {
    const py = sy * sampleStep;
    if (py >= h) break;
    for (let sx = 0; sx < sampleW; sx++) {
      const px = sx * sampleStep;
      if (px >= w) break;
      const idx = (py * w + px) * 4;
      rHist[pixels[idx]]++;
      gHist[pixels[idx + 1]]++;
      bHist[pixels[idx + 2]]++;
    }
  }

  // Find max for normalization
  let maxCount = 1;
  for (let i = 0; i < 256; i++) {
    maxCount = Math.max(maxCount, rHist[i], gHist[i], bHist[i]);
  }

  // Draw
  const cw = histCanvas.width;
  const ch = histCanvas.height;
  const bg = readCssVar('--bg-primary', '#101318');
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);

  const barW = cw / 256;

  // Draw each channel with additive-style blending
  const drawChannel = (hist: Uint32Array, color: string) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 256; i++) {
      const barH = (hist[i] / maxCount) * ch;
      ctx.fillRect(i * barW, ch - barH, Math.max(barW, 1), barH);
    }
  };

  ctx.globalCompositeOperation = 'lighter';
  if (theme === 'light') {
    drawChannel(rHist, 'rgb(225,95,95)');
    drawChannel(gHist, 'rgb(78,170,102)');
    drawChannel(bHist, 'rgb(58,129,226)');
  } else {
    drawChannel(rHist, 'rgb(214,77,77)');
    drawChannel(gHist, 'rgb(68,178,108)');
    drawChannel(bHist, 'rgb(52,121,233)');
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
}

// ============ UI Updates ============

function updatePanelUI(state: AppState): void {
  // Show/hide panels based on active layer
  const calibrationPanel = document.getElementById('calibration-panel');
  const mappingPanel = document.getElementById('mapping-panel');
  const toningPanel = document.getElementById('toning-panel');
  const wheelsRow = document.getElementById('wheels-row');

  if (calibrationPanel) calibrationPanel.style.display = state.ui.activeLayer === 'calibration' ? 'block' : 'none';
  if (mappingPanel) mappingPanel.style.display = state.ui.activeLayer === 'mapping' ? 'block' : 'none';
  if (toningPanel) toningPanel.style.display = state.ui.activeLayer === 'toning' ? 'block' : 'none';

  // Wheels only shown for calibration and hue map.
  if (wheelsRow) wheelsRow.style.display = state.ui.activeLayer === 'toning' ? 'none' : 'flex';

  const splitBtn = document.getElementById('split-btn');
  if (splitBtn) splitBtn.classList.toggle('active', state.ui.splitView);

  const holdCompareBtn = document.getElementById('hold-compare-btn') as HTMLButtonElement | null;
  if (holdCompareBtn) {
    holdCompareBtn.classList.toggle('active', state.ui.holdCompareActive);
    holdCompareBtn.disabled = !state.imageLoaded;
  }

  const mappingPickerBtn = document.getElementById('add-mapping-picker-btn') as HTMLButtonElement | null;
  if (mappingPickerBtn) {
    mappingPickerBtn.classList.toggle('active', state.ui.colorPickerActive && state.ui.activeLayer === 'mapping');
    mappingPickerBtn.disabled = !state.imageLoaded;
  }

  // Update calibration slider values
  updateSlider('red-hue-slider', state.calibration.red.hueShift);
  updateSlider('red-sat-slider', state.calibration.red.saturation);
  updateSlider('green-hue-slider', state.calibration.green.hueShift);
  updateSlider('green-sat-slider', state.calibration.green.saturation);
  updateSlider('blue-hue-slider', state.calibration.blue.hueShift);
  updateSlider('blue-sat-slider', state.calibration.blue.saturation);

  // Update xy input values
  updateNumberInput('red-x-input', state.primaries.red[0]);
  updateNumberInput('red-y-input', state.primaries.red[1]);
  updateNumberInput('green-x-input', state.primaries.green[0]);
  updateNumberInput('green-y-input', state.primaries.green[1]);
  updateNumberInput('blue-x-input', state.primaries.blue[0]);
  updateNumberInput('blue-y-input', state.primaries.blue[1]);

  // Update toning slider values
  updateSlider('exposure-slider', state.toning.exposure);
  updateSlider('contrast-slider', state.toning.contrast);
  updateSlider('highlights-slider', state.toning.highlights);
  updateSlider('shadows-slider', state.toning.shadows);
  updateSlider('whites-slider', state.toning.whites);
  updateSlider('blacks-slider', state.toning.blacks);
  updateSlider('global-hue-slider', state.globalHueShift);
  updateToneCurveControlUI(state);

  // Mapping detail panel
  updateMappingDetail(state);

  // Update mapping list
  updateMappingList(state);

  // Update xy panel visibility
  const xyPanel = document.getElementById('xy-panel');
  const arrow = document.querySelector('.xy-toggle-arrow') as HTMLElement | null;
  if (xyPanel) {
    xyPanel.style.display = state.ui.showXYPanel ? 'block' : 'none';
  }
  if (arrow) {
    arrow.style.transform = state.ui.showXYPanel ? 'rotate(180deg)' : 'rotate(0deg)';
  }

  updateSplitDividerUI(state);
}

function updateSlider(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement;
  if (el && document.activeElement !== el) {
    el.value = String(value);
  }
  // Update associated value input (now an <input type="number"> with class val-input)
  const valEl = document.getElementById(id + '-val') as HTMLInputElement | null;
  if (valEl && document.activeElement !== valEl) {
    valEl.value = value.toFixed(2);
  }
}

function updateNumberInput(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement;
  if (el && document.activeElement !== el) {
    el.value = value.toFixed(4);
  }
}

function updateMappingDetail(state: AppState): void {
  const detailPanel = document.getElementById('mapping-detail');
  if (!detailPanel) return;

  const sel = state.ui.selectedMappingId;
  const mapping = sel ? state.localMappings.find(m => m.id === sel) : null;

  if (mapping) {
    detailPanel.style.display = 'block';
    updateSlider('mapping-src-slider', mapping.srcHue);
    updateSlider('mapping-dst-slider', mapping.dstHue);
    updateSlider('mapping-range-slider', mapping.range);
    updateSlider('mapping-strength-slider', mapping.strength);
  } else {
    detailPanel.style.display = 'none';
  }
}

function updateMappingList(state: AppState): void {
  const list = document.getElementById('mapping-list');
  if (!list) return;

  list.innerHTML = state.localMappings.map((m) => {
    const srcDeg = Math.round(m.srcHue * 360);
    const dstDeg = Math.round(m.dstHue * 360);
    const isSelected = state.ui.selectedMappingId === m.id;
    return `<div class="mapping-item ${isSelected ? 'selected' : ''}" data-id="${m.id}">
      <span class="mapping-color" style="background:hsl(${srcDeg},80%,50%)"></span>
      <span>${srcDeg}\u00b0 \u2192 ${dstDeg}\u00b0</span>
      <span class="mapping-range">${Math.round(m.range * 360)}\u00b0</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.mapping-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = (item as HTMLElement).dataset.id!;
      store.update({
        ui: { ...state.ui, selectedMappingId: id },
      });
    });
  });
}

function updateCapabilitiesDisplay(): void {
  const el = document.getElementById('capabilities');
  if (el && renderer) {
    const cap = renderer.capabilities;
    el.textContent = `WebGL ${cap.webgl2 ? '2.0' : '1.0'} | Max mappings: ${cap.maxMappings}`;
  }
}

// ============ Resize ============

function handleResize(): void {
  colorWheel.resize();
  const state = store.getState();
  colorWheel.draw(state);
  if (renderedWheelCanvas) {
    colorWheel.drawRendered(state, renderedWheelCanvas);
  }

  // Redraw diagrams
  if (state.ui.activeLayer === 'calibration') drawXYDiagram(state);
  if (state.ui.activeLayer === 'toning') drawToneCurve();

  if (previewCanvas) {
    const container = document.getElementById('preview-container');
    const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
    if (container && glCanvas) {
      const rect = container.getBoundingClientRect();
      const aspect = previewCanvas.width / previewCanvas.height;
      let cssW = rect.width;
      let cssH = cssW / aspect;
      if (cssH > rect.height) {
        cssH = rect.height;
        cssW = cssH * aspect;
      }
      glCanvas.style.width = Math.floor(cssW) + 'px';
      glCanvas.style.height = Math.floor(cssH) + 'px';
      renderer.updateUniforms(state);
      renderer.render();
    }
  }
  refreshDominantImageHues();

  updateSplitDividerUI(state);
}

function startWheelLoop(): void {
  let lastTime = 0;
  const interval = 1000 / 15; // 15fps

  const loop = (time: number) => {
    if (time - lastTime >= interval) {
      const state = store.getState();
      colorWheel.draw(state);
      if (renderedWheelCanvas) {
        colorWheel.drawRendered(state, renderedWheelCanvas);
      }
      lastTime = time;
    }
    _wheelAnimFrame = requestAnimationFrame(loop);
  };
  _wheelAnimFrame = requestAnimationFrame(loop);
}

function showError(msg: string): void {
  const el = document.getElementById('error-msg');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
