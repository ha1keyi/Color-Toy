/**
 * Color Toy - Main Application Entry Point
 * Wires together: State, Renderer, ColorWheel (edit + rendered), UI Panels
 */
import { store } from './state/store';
import {
  DEFAULT_CALIBRATION, DEFAULT_PRIMARIES, DEFAULT_TONING,
  SRGB_RED_XY, SRGB_GREEN_XY, SRGB_BLUE_XY, D65_WHITE_XY,
  calibrationToPrimaries, primariesToCalibration,
} from './state/types';
import type { AppState, LocalMapping } from './state/types';
import { Renderer } from './gpu/renderer';
import { ColorWheel } from './ui/wheel/colorWheel';
import { rgbToHsv } from './core/color/conversions';
import {
  BUILTIN_PRESETS, getStoredPresets, savePreset,
  createColorStylePreset, createCreativeMappingPreset,
  applyPreset, importPresetFromJSON,
} from './presets/presetManager';
import { renderHistoryPanel } from './ui/panels/historyPanel';
import { updatePanelState } from './ui/panels/panelState';
import {
  applyLayoutMode,
  clampPreviewRatio,
  getCurrentLayoutMode,
  isImagePriorityMobileMode,
  isMobileCompactViewport,
  isValidLayout,
  isValidMobileModule,
  isWheelStickyContext,
  toggleMobileModuleSelection,
} from './ui/layout/layoutState';
import type { UiLayoutMode } from './ui/layout/layoutState';
import { setupLayoutProfileManager } from './ui/layout/layoutProfileManager';

// DOM references
let renderer: Renderer;
let colorWheel: ColorWheel;
let originalImage: HTMLImageElement | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let renderedWheelCanvas: HTMLCanvasElement | null = null;
let dominantImageHues: number[] = [];
type ThemeMode = 'dark' | 'light';
const THEME_STORAGE_KEY = 'colorToy.theme';
type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };
type MobileModule = 'none' | 'calibration' | 'mapping' | 'toning' | 'history' | 'presets';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function readCssVar(name: string, fallback: string): string {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const HISTOGRAM_INTERVAL_DESKTOP = 1000 / 10;
const HISTOGRAM_INTERVAL_MOBILE = 1000 / 5;
const TONE_CURVE_LUT_SIZE = 256;
const DOMINANT_HUE_BINS = 72;
const DOMINANT_HUE_COUNT = 6;

type ToneCurvePoint = { x: number; y: number };

const DEFAULT_TONE_CURVE_POINTS: ToneCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 },
  { x: 1, y: 1 },
];

let uiRenderFrame = 0;
let wheelRenderPending = false;
let histogramRenderPending = false;
let lastHistogramRenderTime = 0;
let _deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const UI_LAYOUT_STORAGE_KEY = 'colorToy.ui.layout';
const MODULE_COLLAPSE_STORAGE_PREFIX = 'colorToy.ui.collapsed.';
const PREVIEW_SPLIT_STORAGE_PREFIX = 'colorToy.ui.previewSplit.';
let _mobileModuleSelection: MobileModule = 'none';

function isCoarsePointerDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function getHistogramInterval(): number {
  return isCoarsePointerDevice() ? HISTOGRAM_INTERVAL_MOBILE : HISTOGRAM_INTERVAL_DESKTOP;
}

function getAdaptiveRenderScale(): number {
  const dpr = window.devicePixelRatio || 1;
  const coarsePointer = isCoarsePointerDevice();
  const memory = (navigator as NavigatorWithDeviceMemory).deviceMemory ?? 4;

  let scale = 1;

  if (coarsePointer && dpr >= 3) {
    scale = Math.min(scale, 0.75);
  } else if (dpr >= 2) {
    scale = Math.min(scale, 0.9);
  }

  if (memory <= 4) {
    scale = Math.min(scale, 0.8);
  }
  if (memory <= 2) {
    scale = Math.min(scale, 0.65);
  }

  return Math.max(0.55, Math.min(1, scale));
}

function requestUiRender(target: 'wheel' | 'histogram' | 'all' = 'all'): void {
  if (target === 'wheel' || target === 'all') {
    wheelRenderPending = true;
  }
  if (target === 'histogram' || target === 'all') {
    histogramRenderPending = true;
  }

  if (!uiRenderFrame) {
    uiRenderFrame = requestAnimationFrame(flushUiRenderQueue);
  }
}

function flushUiRenderQueue(time: number): void {
  uiRenderFrame = 0;
  const state = store.getState();

  if (wheelRenderPending && colorWheel) {
    wheelRenderPending = false;
    colorWheel.setState(state);
    colorWheel.draw(state);
    if (renderedWheelCanvas) {
      colorWheel.drawRendered(state, renderedWheelCanvas);
    }
  }

  if (histogramRenderPending) {
    if (time - lastHistogramRenderTime >= getHistogramInterval()) {
      histogramRenderPending = false;
      lastHistogramRenderTime = time;
      drawHistogram();
    } else if (!uiRenderFrame) {
      uiRenderFrame = requestAnimationFrame(flushUiRenderQueue);
    }
  }
}

function titleCaseLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setupHistoryPanel(): void {
  store.registerHistorySource('toneCurve', {
    capture: () => cloneToneCurvePoints(toneCurvePoints),
    restore: (snapshot) => {
      toneCurvePoints = isToneCurveSnapshot(snapshot)
        ? cloneToneCurvePoints(snapshot)
        : cloneToneCurvePoints(DEFAULT_TONE_CURVE_POINTS);
      drawToneCurve();
    },
  });
  store.subscribeHistory((history) => {
    renderHistoryPanel(history, {
      onJumpToHistory: (index) => {
        store.goToHistory(index);
      },
    });
  });
}

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
    renderer.setRenderScale(getAdaptiveRenderScale());
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
  setupLayoutStudioEntry();
  setupLayerTabs();
  setupToolbar();
  setupSplitDivider();
  setupCompareHint();
  setupPanels();
  setupModuleCollapse();
  setupLayoutControls();
  setupWheelControls();
  setupPreviewControlsDivider();
  setupMobileModuleBar();
  setupLayoutProfileControls();
  setupPresets();
  setupExport();
  setupKeyboard();
  setupPerformanceMonitor();
  setupWheelCompareToggle();
  setupValInputs();
  setupDoubleClickReset();
  setupXYDiagram();
  setupToneCurve();
  setupHistoryPanel();
  setupPwaHooks();
  registerServiceWorker();

  // Initial render
  const state = store.getState();
  colorWheel.setImageHuePeaks(dominantImageHues);
  colorWheel.setState(state);
  requestUiRender('all');
  updatePanelUI(state);

  // Initial diagram renders
  if (state.ui.activeLayer === 'calibration') drawXYDiagram(state);
  if (state.ui.activeLayer === 'toning') drawToneCurve();

  updateToneCurveGPU();

  // Handle window resize
  window.addEventListener('resize', handleResize);
  handleResize();
}

function setMobileModuleSelection(value: MobileModule): void {
  _mobileModuleSelection = value;
  syncMobileModuleBarSelection();
}

function syncMobileModuleBarSelection(): void {
  const buttons = Array.from(document.querySelectorAll('.mobile-module-btn')) as HTMLButtonElement[];
  buttons.forEach((btn) => {
    const moduleName = btn.dataset.mobileModule as MobileModule | undefined;
    btn.classList.toggle('active', moduleName === _mobileModuleSelection);
  });
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
  requestUiRender('wheel');
  updateHistogram();
  drawToneCurve();
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

function setupLayoutStudioEntry(): void {
  const entryBtn = document.getElementById('layout-studio-entry-btn') as HTMLButtonElement | null;
  if (!entryBtn) return;

  entryBtn.addEventListener('click', () => {
    entryBtn.classList.add('active');
    entryBtn.setAttribute('aria-pressed', 'true');
    window.setTimeout(() => {
      entryBtn.classList.remove('active');
      entryBtn.setAttribute('aria-pressed', 'false');
    }, 140);
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

  requestUiRender('wheel');
  updateHistogram();

  updatePanelUI(state);
  updateLayerTabs(state);

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

async function readIccProfileFromFile(file: File): Promise<{ name: string | null; source: string | null }> {
  const lowerName = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const decodeAscii = (start: number, len: number): string =>
    String.fromCharCode(...bytes.slice(start, start + len));

  if ((file.type === 'image/jpeg' || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) && bytes.length > 12) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (marker === 0xe2) {
        const id = decodeAscii(offset + 4, Math.min(11, bytes.length - (offset + 4)));
        if (id.startsWith('ICC_PROFILE')) {
          return { name: 'ICC_PROFILE', source: 'JPEG APP2' };
        }
      }
      offset += 2 + segmentLength;
    }
  }

  if ((file.type === 'image/png' || lowerName.endsWith('.png')) && bytes.length > 32) {
    let offset = 8; // PNG signature
    while (offset + 12 <= bytes.length) {
      const length =
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
      const type = decodeAscii(offset + 4, 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) break;

      if (type === 'iCCP') {
        let i = dataStart;
        while (i < dataEnd && bytes[i] !== 0) i++;
        const profileName = new TextDecoder('latin1').decode(bytes.slice(dataStart, i)).trim();
        return {
          name: profileName || 'Embedded ICC',
          source: 'PNG iCCP',
        };
      }

      offset = dataEnd + 4;
    }
  }

  return { name: null, source: null };
}

function loadImageFile(file: File): void {
  if (!file.type.startsWith('image/')) return;
  if (!renderer) {
    showError('Renderer is not initialized, image cannot be processed.');
    return;
  }

  void readIccProfileFromFile(file)
    .then((icc) => {
      const state = store.getState();
      store.update({
        ui: {
          ...state.ui,
          importedIccProfileName: icc.name,
          importedIccSource: icc.source,
        },
      });
    })
    .catch(() => {
      const state = store.getState();
      store.update({
        ui: {
          ...state.ui,
          importedIccProfileName: null,
          importedIccSource: null,
        },
      });
    });

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
      renderer.setRenderScale(getAdaptiveRenderScale());
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
    let activePointerId: number | null = null;
    const release = (pointerId?: number) => {
      if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) {
        return;
      }
      activePointerId = null;
      setHoldCompare(false);
    };

    holdCompareBtn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      activePointerId = e.pointerId;
      holdCompareBtn.setPointerCapture(e.pointerId);
      setHoldCompare(true);
    });

    holdCompareBtn.addEventListener('pointerup', (e) => release(e.pointerId));
    holdCompareBtn.addEventListener('pointercancel', (e) => release(e.pointerId));
    holdCompareBtn.addEventListener('lostpointercapture', () => release());
    holdCompareBtn.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        release(e.pointerId);
      }
    });
    window.addEventListener('pointerup', (e) => release(e.pointerId));
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
      });
      resetToneCurve();
      store.commitCurrent('Reset All');
    });
  }

  // Per-module reset buttons
  document.querySelectorAll('.reset-module-btn').forEach((btn) => {
    const el = btn as HTMLElement;
    const module = el.dataset.module;
    el.addEventListener('click', () => {
      if (module === 'calibration') {
        store.commit({
          calibration: { ...DEFAULT_CALIBRATION },
          primaries: { ...DEFAULT_PRIMARIES },
        }, 'Reset Calibration');
      } else if (module === 'mapping') {
        store.commit({
          localMappings: [],
          globalHueShift: 0,
        }, 'Reset Hue Mapping');
      } else if (module === 'toning') {
        const state = store.getState();
        store.update({
          toning: { ...DEFAULT_TONING },
          ui: {
            ...state.ui,
            toneCurveEnabled: true,
            toneCurveBypassPreview: false,
          },
        });
        resetToneCurve();
        store.commitCurrent('Reset Toning');
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
    const pickAtClient = (clientX: number, clientY: number) => {
      const state = store.getState();
      if (!state.ui.colorPickerActive || !state.imageLoaded || state.ui.activeLayer !== 'mapping') return;

      const rect = glCanvas.getBoundingClientRect();
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      const px = Math.max(0, Math.min(previewCanvas ? previewCanvas.width - 1 : 0, Math.round(nx * (previewCanvas?.width ?? 0))));
      const py = Math.max(0, Math.min(previewCanvas ? previewCanvas.height - 1 : 0, Math.round(ny * (previewCanvas?.height ?? 0))));

      store.update({
        ui: {
          ...state.ui,
          colorPickerCoord: { x: px, y: py },
        },
      });

      const color = renderer.pickColor(nx, ny, state.ui.colorPickerRadiusPx);
      if (color) {
        const [h, s, _v] = rgbToHsv(color[0], color[1], color[2]);
        handleColorPicked(h, s);
      }
    };

    glCanvas.addEventListener('click', (e) => {
      pickAtClient(e.clientX, e.clientY);
    });

    glCanvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      pickAtClient(e.clientX, e.clientY);
    });
  }
}

function setupSplitDivider(): void {
  const divider = document.getElementById('split-divider');
  const container = document.getElementById('preview-container');
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!divider || !container || !glCanvas) return;

  let dragging = false;
  let activePointerId: number | null = null;
  let lastClientX = 0;

  const updateFromClientX = (clientX: number, commitHistory: boolean) => {
    lastClientX = clientX;
    const canvasRect = glCanvas.getBoundingClientRect();
    if (canvasRect.width <= 0) return;
    const nx = (clientX - canvasRect.left) / canvasRect.width;
    const clamped = Math.max(0, Math.min(1, nx));
    const state = store.getState();
    const partial = {
      ui: { ...state.ui, splitPosition: clamped },
    };
    if (commitHistory) {
      store.commit(partial, 'Adjust Split View');
    } else {
      store.update(partial);
    }
  };

  divider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    activePointerId = e.pointerId;
    divider.setPointerCapture(e.pointerId);
    updateFromClientX(e.clientX, false);
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    updateFromClientX(e.clientX, false);
  });

  const finishDrag = (pointerId?: number) => {
    if (!dragging) return;
    if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) {
      return;
    }
    dragging = false;
    activePointerId = null;
    updateFromClientX(lastClientX, true);
  };

  window.addEventListener('pointerup', (e) => {
    finishDrag(e.pointerId);
  });

  window.addEventListener('pointercancel', (e) => {
    finishDrag(e.pointerId);
  });

  divider.addEventListener('lostpointercapture', () => {
    finishDrag();
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
    requestUiRender('wheel');
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

  store.commit({
    localMappings: [...state.localMappings, newMapping],
    ui: {
      ...state.ui,
      activeLayer: 'mapping',
      selectedMappingId: id,
      colorPickerActive: false,
    },
  }, 'Add Mapping From Picker');
}

// ============ Panels ============

function setupPanels(): void {
  setupCalibrationSliders();
  setupXYInputs();
  setupColorManagementControls();
  setupToningSliders();
  setupToneCurveControls();
  setupMappingControls();
  setupColorPickerPrecisionControls();
}

function setupLayoutControls(): void {
  const layoutToggleBtn = document.getElementById('layout-toggle-btn') as HTMLButtonElement | null;

  const updateLayoutButton = (mode: UiLayoutMode) => {
    if (!layoutToggleBtn) return;
    layoutToggleBtn.classList.toggle('active', mode === 'image-priority');
    const label = layoutToggleBtn.querySelector('span') || layoutToggleBtn;
    label.textContent = mode === 'image-priority' ? 'Layout: Image' : 'Layout: Controls';
  };

  const layoutStored = window.localStorage.getItem(UI_LAYOUT_STORAGE_KEY);

  let initialLayout: UiLayoutMode = isValidLayout(layoutStored || '')
    ? layoutStored as UiLayoutMode
    : 'controls-priority';

  // On mobile compact view, always use image-priority and hide the toggle control
  if (isMobileCompactViewport()) {
    initialLayout = 'image-priority';
    if (layoutToggleBtn) layoutToggleBtn.style.display = 'none';
  }

  const controlsStored = parseFloat(window.localStorage.getItem(`${PREVIEW_SPLIT_STORAGE_PREFIX}controls-priority`) || '');
  const imageStored = parseFloat(window.localStorage.getItem(`${PREVIEW_SPLIT_STORAGE_PREFIX}image-priority`) || '');
  const state = store.getState();
  store.update({
    ui: {
      ...state.ui,
      controlsPriorityPreviewRatio: Number.isFinite(controlsStored)
        ? clampPreviewRatio(controlsStored)
        : state.ui.controlsPriorityPreviewRatio,
      imagePriorityPreviewRatio: Number.isFinite(imageStored)
        ? clampPreviewRatio(imageStored)
        : state.ui.imagePriorityPreviewRatio,
    },
  });

  applyLayoutMode(initialLayout, () => {
    setMobileModuleSelection('none');
  });

  updateLayoutButton(initialLayout);

  if (layoutToggleBtn) {
    layoutToggleBtn.addEventListener('click', () => {
      const current = getCurrentLayoutMode();
      const selected = current === 'controls-priority' ? 'image-priority' : 'controls-priority';
      window.localStorage.setItem(UI_LAYOUT_STORAGE_KEY, selected);
      applyLayoutMode(selected, () => {
        setMobileModuleSelection('none');
      });
      if (selected === 'controls-priority') {
        const state = store.getState();
        if (state.ui.wheelPinned) {
          store.update({
            ui: {
              ...state.ui,
              wheelPinned: false,
            },
          });
        }
      }
      updateLayoutButton(selected);
      updatePanelUI(store.getState());
      handleResize();
    });
  }
}

function setupLayoutProfileControls(): void {
  setupLayoutProfileManager({
    getState: () => store.getState(),
    getLayoutMode: () => getCurrentLayoutMode(),
    setLayoutMode: (mode) => {
      window.localStorage.setItem(UI_LAYOUT_STORAGE_KEY, mode);
      applyLayoutMode(mode, () => {
        setMobileModuleSelection('none');
      });
    },
    getMobileModuleSelection: () => _mobileModuleSelection,
    setMobileModuleSelection,
    setUiPatch: (patch) => {
      const current = store.getState();
      store.update({
        ui: {
          ...current.ui,
          ...patch,
        },
      });
    },
    collapseStoragePrefix: MODULE_COLLAPSE_STORAGE_PREFIX,
    onApplied: () => {
      updatePanelUI(store.getState());
      handleResize();
    },
  });
}

function setupWheelControls(): void {
  const pinBtn = document.getElementById('wheel-pin-btn') as HTMLButtonElement | null;

  if (pinBtn) {
    pinBtn.addEventListener('click', () => {
      const state = store.getState();
      const stickyContext = isWheelStickyContext(_mobileModuleSelection);
      store.update({
        ui: {
          ...state.ui,
          wheelPinned: stickyContext ? !state.ui.wheelPinned : false,
        },
      });
      handleResize();
    });
  }
}

function applyPreviewControlsSplit(state: AppState): void {
  const app = document.getElementById('app') as HTMLElement | null;
  const controls = document.getElementById('controls') as HTMLElement | null;
  const divider = document.getElementById('preview-controls-divider') as HTMLElement | null;
  if (!app || !divider || !controls) return;

  if (!isMobileCompactViewport()) {
    app.style.removeProperty('--preview-controls-ratio');
    app.style.removeProperty('--controls-flex-ratio');
    divider.classList.remove('active');
    return;
  }

  const layoutMode = getCurrentLayoutMode();
  const imagePriorityModuleOpen = layoutMode === 'image-priority' && _mobileModuleSelection !== 'none';
  const storedRatio = layoutMode === 'image-priority'
    ? state.ui.imagePriorityPreviewRatio
    : state.ui.controlsPriorityPreviewRatio;
  const expandedRatio = clampPreviewRatio(storedRatio);
  const ratio = imagePriorityModuleOpen ? expandedRatio : 1;

  app.style.setProperty('--preview-controls-ratio', ratio.toFixed(4));
  app.style.setProperty('--controls-flex-ratio', (1 - ratio).toFixed(4));
  controls.classList.toggle('full-preview', !imagePriorityModuleOpen && layoutMode === 'image-priority');
  divider.classList.toggle('active', imagePriorityModuleOpen);
}

function setupPreviewControlsDivider(): void {
  const divider = document.getElementById('preview-controls-divider') as HTMLElement | null;
  const preview = document.getElementById('preview-container') as HTMLElement | null;
  const controls = document.getElementById('controls') as HTMLElement | null;
  if (!divider || !preview || !controls) return;

  let dragging = false;
  let activePointerId: number | null = null;

  const updateByClientY = (clientY: number) => {
    if (!isMobileCompactViewport()) return;
    const layoutMode = getCurrentLayoutMode();
    if (layoutMode !== 'image-priority') return;
    if (_mobileModuleSelection === 'none') return;

    const areaTop = preview.getBoundingClientRect().top;
    const areaBottom = controls.getBoundingClientRect().bottom;
    const areaHeight = areaBottom - areaTop;
    if (areaHeight <= 0) return;

    const nextRatio = clampPreviewRatio((clientY - areaTop) / areaHeight);
    const state = store.getState();
    const nextUi = layoutMode === 'image-priority'
      ? { ...state.ui, imagePriorityPreviewRatio: nextRatio }
      : { ...state.ui, controlsPriorityPreviewRatio: nextRatio };
    store.update({ ui: nextUi });
    window.localStorage.setItem(`${PREVIEW_SPLIT_STORAGE_PREFIX}${layoutMode}`, String(nextRatio));
  };

  divider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    activePointerId = e.pointerId;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    updateByClientY(e.clientY);
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    updateByClientY(e.clientY);
  });

  const finish = (pointerId?: number) => {
    if (!dragging) return;
    if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    divider.classList.remove('dragging');
    handleResize();
  };

  window.addEventListener('pointerup', (e) => finish(e.pointerId));
  window.addEventListener('pointercancel', (e) => finish(e.pointerId));
  divider.addEventListener('lostpointercapture', () => finish());
}

function setupMobileModuleBar(): void {
  const buttons = Array.from(document.querySelectorAll('.mobile-module-btn')) as HTMLButtonElement[];

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.mobileModule || 'none';
      if (!isValidMobileModule(next)) return;

      setMobileModuleSelection(toggleMobileModuleSelection(_mobileModuleSelection, next));
      if (_mobileModuleSelection === 'calibration' || _mobileModuleSelection === 'mapping' || _mobileModuleSelection === 'toning') {
        const state = store.getState();
        store.update({
          ui: {
            ...state.ui,
            activeLayer: _mobileModuleSelection,
          },
        });
      }

      if (_mobileModuleSelection === 'none') {
        const state = store.getState();
        if (state.ui.wheelPinned) {
          store.update({
            ui: {
              ...state.ui,
              wheelPinned: false,
            },
          });
        }
      }

      updatePanelUI(store.getState());
      handleResize();
    });
  });

  syncMobileModuleBarSelection();
  window.addEventListener('resize', () => {
    updatePanelUI(store.getState());
  });
}

function setupModuleCollapse(): void {
  const buttons = Array.from(document.querySelectorAll('.module-collapse-btn')) as HTMLButtonElement[];
  for (const button of buttons) {
    const targetId = button.dataset.collapseTarget;
    if (!targetId) continue;

    const target = document.getElementById(targetId);
    if (!target) continue;

    const isHistory = targetId === 'history-panel';
    const defaultCollapsed = isHistory && isCoarsePointerDevice();
    const storageKey = MODULE_COLLAPSE_STORAGE_PREFIX + targetId;
    const stored = window.localStorage.getItem(storageKey);
    let collapsed = stored === null ? defaultCollapsed : stored === '1';

    const apply = () => {
      target.classList.toggle('is-collapsed', collapsed);
      button.classList.toggle('is-collapsed', collapsed);
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.title = collapsed ? 'Expand module' : 'Collapse module';
      button.textContent = collapsed ? '>' : 'v';
    };

    apply();

    button.addEventListener('click', (event) => {
      event.preventDefault();
      collapsed = !collapsed;
      window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
      apply();
      updatePanelUI(store.getState());
      handleResize();
    });
  }
}

function setupColorManagementControls(): void {
  const workingSpaceSelect = document.getElementById('working-space-select') as HTMLSelectElement | null;
  const gamutToggle = document.getElementById('gamut-compression-toggle') as HTMLButtonElement | null;

  if (workingSpaceSelect) {
    workingSpaceSelect.addEventListener('change', () => {
      const state = store.getState();
      const workingColorSpace = workingSpaceSelect.value === 'acescg' ? 'acescg' : 'linear-srgb';
      store.commit({
        ui: {
          ...state.ui,
          workingColorSpace,
        },
      }, `Set Working Space: ${workingColorSpace === 'acescg' ? 'ACEScg' : 'Linear sRGB'}`);
    });
  }

  if (gamutToggle) {
    gamutToggle.addEventListener('click', () => {
      const state = store.getState();
      store.commit({
        ui: {
          ...state.ui,
          gamutCompressionEnabled: !state.ui.gamutCompressionEnabled,
        },
      }, state.ui.gamutCompressionEnabled ? 'Disable Soft Gamut Compression' : 'Enable Soft Gamut Compression');
    });
  }
}

function setupColorPickerPrecisionControls(): void {
  const radiusSlider = document.getElementById('picker-radius-slider') as HTMLInputElement | null;
  if (!radiusSlider) {
    return;
  }

  radiusSlider.addEventListener('input', () => {
    const state = store.getState();
    store.update({
      ui: {
        ...state.ui,
        colorPickerRadiusPx: Math.max(0, Math.min(6, Math.round(parseFloat(radiusSlider.value) || 0))),
      },
    });
  });

  radiusSlider.addEventListener('change', () => {
    const state = store.getState();
    store.commit({
      ui: {
        ...state.ui,
        colorPickerRadiusPx: Math.max(0, Math.min(6, Math.round(parseFloat(radiusSlider.value) || 0))),
      },
    }, 'Set Picker Radius');
  });
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
      store.commit({
        calibration: newCalibration,
        primaries: newPrimaries,
      }, `Adjust ${titleCaseLabel(s.color)} ${s.param === 'hueShift' ? 'Hue' : 'Saturation'}`);
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
        store.commit({
          primaries: newPrimaries,
          calibration: newCalibration,
        }, `Adjust ${titleCaseLabel(color)} Primary X`);
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
        store.commit({
          primaries: newPrimaries,
          calibration: newCalibration,
        }, `Adjust ${titleCaseLabel(color)} Primary Y`);
      });
    }
  }
}

// ============ Toning Sliders ============

function setupToningSliders(): void {
  const sliders = [
    { id: 'exposure-slider', key: 'exposure', min: -1, max: 1, step: 0.01, label: 'Adjust Exposure' },
    { id: 'contrast-slider', key: 'contrast', min: 0, max: 2.0, step: 0.005, label: 'Adjust Contrast' },
    { id: 'highlights-slider', key: 'highlights', min: -0.5, max: 0.5, step: 0.005, label: 'Adjust Highlights' },
    { id: 'shadows-slider', key: 'shadows', min: -0.5, max: 0.5, step: 0.005, label: 'Adjust Shadows' },
    { id: 'whites-slider', key: 'whites', min: -0.5, max: 0.5, step: 0.005, label: 'Adjust Whites' },
    { id: 'blacks-slider', key: 'blacks', min: -0.5, max: 0.5, step: 0.005, label: 'Adjust Blacks' },
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
      store.commit({
        toning: { ...state.toning, [s.key]: parseFloat(el.value) },
      }, s.label);
    });
  }

  // Global hue shift slider
  const hueSlider = document.getElementById('global-hue-slider') as HTMLInputElement;
  if (hueSlider) {
    hueSlider.addEventListener('input', () => {
      store.update({ globalHueShift: parseFloat(hueSlider.value) });
    });
    hueSlider.addEventListener('change', () => {
      store.commit({ globalHueShift: parseFloat(hueSlider.value) }, 'Adjust Global Hue');
    });
  }
}

function setupToneCurveControls(): void {
  const enableBtn = document.getElementById('tone-curve-enable-btn') as HTMLButtonElement | null;
  const bypassBtn = document.getElementById('tone-curve-bypass-btn') as HTMLButtonElement | null;
  if (!enableBtn || !bypassBtn) return;

  enableBtn.addEventListener('click', () => {
    const state = store.getState();
    store.commit({
      ui: {
        ...state.ui,
        toneCurveEnabled: !state.ui.toneCurveEnabled,
      },
    }, state.ui.toneCurveEnabled ? 'Disable Tone Curve' : 'Enable Tone Curve');
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
        store.commit({
          localMappings: state.localMappings.filter(m => m.id !== state.ui.selectedMappingId),
          ui: { ...state.ui, selectedMappingId: null },
        }, 'Delete Mapping Point');
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
    const labelMap: Record<keyof LocalMapping, string> = {
      id: 'Edit Mapping ID',
      srcHue: 'Adjust Mapping Source Hue',
      dstHue: 'Adjust Mapping Target Hue',
      range: 'Adjust Mapping Range',
      strength: 'Adjust Mapping Strength',
    };
    store.commit({
      localMappings: state.localMappings.map(m =>
        m.id === sel ? { ...m, [field]: value } : m
      ),
    }, labelMap[field]);
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
          } else {
            window.alert('Invalid or unsupported preset file.');
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
      store.commit(updates, `Apply Preset: ${preset.name}`);
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
  const exportState: AppState = {
    ...state,
    ui: {
      ...state.ui,
      holdCompareActive: false,
    },
  };

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

      const meta = {
        exportedAt: new Date().toISOString(),
        workingColorSpace: state.ui.workingColorSpace,
        gamutCompressionEnabled: state.ui.gamutCompressionEnabled,
        sourceIccProfile: state.ui.importedIccProfileName,
        sourceIccContainer: state.ui.importedIccSource,
      };
      downloadTextFile('color-toy-export.icc.json', JSON.stringify(meta, null, 2), 'application/json');
    }, 'image/png');

    exportRenderer.destroy();
  } catch (e) {
    console.error('Export failed:', e);
  }
}

function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
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
          store.commit({
            localMappings: state.localMappings.filter(m => m.id !== state.ui.selectedMappingId),
            ui: { ...state.ui, selectedMappingId: null },
          }, 'Delete Mapping Point');
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
    'picker-radius-slider',
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
    'picker-radius-slider': 2,
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
      store.commit({
        primaries: { ...state.primaries },
        calibration: { ...state.calibration },
      }, `Move ${titleCaseLabel(xyDragTarget)} Primary`);
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
      store.commit({
        primaries: { ...state.primaries },
        calibration: { ...state.calibration },
      }, `Move ${titleCaseLabel(xyDragTarget)} Primary`);
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
let toneCurvePoints: ToneCurvePoint[] = cloneToneCurvePoints(DEFAULT_TONE_CURVE_POINTS);
let tcDragIdx: number | null = null;
let tcDragMode: 'move' | 'add' | null = null;
let tcDragStartSnapshot: ToneCurvePoint[] | null = null;

function cloneToneCurvePoints(points: ToneCurvePoint[]): ToneCurvePoint[] {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

function isToneCurveSnapshot(value: unknown): value is ToneCurvePoint[] {
  return Array.isArray(value) && value.every((point) =>
    typeof point === 'object' &&
    point !== null &&
    typeof (point as ToneCurvePoint).x === 'number' &&
    typeof (point as ToneCurvePoint).y === 'number'
  );
}

function toneCurvePointsEqual(left: ToneCurvePoint[], right: ToneCurvePoint[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((point, index) => {
    const other = right[index];
    return !!other && Math.abs(point.x - other.x) < 1e-6 && Math.abs(point.y - other.y) < 1e-6;
  });
}

function resetToneCurve(): void {
  toneCurvePoints = cloneToneCurvePoints(DEFAULT_TONE_CURVE_POINTS);
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
  requestUiRender('histogram');
}

function handleUndoAction(): void {
  store.undo();
}

function handleRedoAction(): void {
  store.redo();
}

function setupToneCurve(): void {
  const canvas = document.getElementById('tone-curve-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  const margin = 20;

  const finishToneCurveGesture = () => {
    if (tcDragIdx === null) {
      tcDragMode = null;
      tcDragStartSnapshot = null;
      return;
    }

    const changed = tcDragStartSnapshot && !toneCurvePointsEqual(tcDragStartSnapshot, toneCurvePoints);
    if (changed) {
      store.commitCurrent(tcDragMode === 'add' ? 'Tone Curve: Add Point' : 'Tone Curve: Move Point');
    }

    tcDragIdx = null;
    tcDragMode = null;
    tcDragStartSnapshot = null;
  };

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
      tcDragIdx = idx;
      tcDragMode = 'move';
      tcDragStartSnapshot = cloneToneCurvePoints(toneCurvePoints);
    } else {
      tcDragStartSnapshot = cloneToneCurvePoints(toneCurvePoints);
      const norm = pixToNorm(pos.x, pos.y);
      let insertIdx = toneCurvePoints.length;
      for (let i = 0; i < toneCurvePoints.length; i++) {
        if (norm.x < toneCurvePoints[i].x) { insertIdx = i; break; }
      }
      toneCurvePoints.splice(insertIdx, 0, norm);
      tcDragIdx = insertIdx;
      tcDragMode = 'add';
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
    finishToneCurveGesture();
  });

  // Double-click to remove a point (not endpoints)
  canvas.addEventListener('dblclick', (e) => {
    const pos = getPos(e);
    const idx = hitTestPoint(pos.x, pos.y);
    if (idx !== null && idx > 0 && idx < toneCurvePoints.length - 1) {
      toneCurvePoints.splice(idx, 1);
      drawToneCurve();
      store.commitCurrent('Tone Curve: Remove Point');
    }
  });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const pos = getPos(e.touches[0]);
    const idx = hitTestPoint(pos.x, pos.y);
    if (idx !== null) {
      tcDragIdx = idx;
      tcDragMode = 'move';
      tcDragStartSnapshot = cloneToneCurvePoints(toneCurvePoints);
    } else {
      tcDragStartSnapshot = cloneToneCurvePoints(toneCurvePoints);
      const norm = pixToNorm(pos.x, pos.y);
      let insertIdx = toneCurvePoints.length;
      for (let i = 0; i < toneCurvePoints.length; i++) {
        if (norm.x < toneCurvePoints[i].x) { insertIdx = i; break; }
      }
      toneCurvePoints.splice(insertIdx, 0, norm);
      tcDragIdx = insertIdx;
      tcDragMode = 'add';
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
    finishToneCurveGesture();
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
  store.commit({
    localMappings: [...state.localMappings, {
      id,
      srcHue: hue,
      dstHue: hue,
      range: 30 / 360,
      strength: 1.0,
    }],
    ui: { ...state.ui, selectedMappingId: id },
  }, 'Add Mapping Point');
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
  store.commitCurrent('Adjust Hue Mapping');
}

// ============ Performance Monitor ============

function setupPerformanceMonitor(): void {
  renderer.onFps((fps) => {
    // Auto-downgrade resolution if needed
    if (fps < 20) {
      const loweredScale = Math.max(0.55, renderer.getRenderScale() - 0.1);
      renderer.setRenderScale(loweredScale);

      const state = store.getState();
      if (state.ui.previewResolution > 512 && previewCanvas && originalImage) {
        const newRes = state.ui.previewResolution === 1080 ? 720 : 512;
        store.update({
          ui: { ...state.ui, previewResolution: newRes as 1080 | 720 | 512 },
        });
        previewCanvas = scaleImageToCanvas(originalImage, newRes);
        refreshDominantImageHues();
        renderer.setRenderScale(Math.min(renderer.getRenderScale(), getAdaptiveRenderScale()));
        renderer.loadImage(previewCanvas);
      }
    } else if (fps > 40) {
      renderer.setRenderScale(getAdaptiveRenderScale());
    }
  });
}

// ============ Histogram ============

function updateHistogram(): void {
  requestUiRender('histogram');
}

function drawHistogram(): void {
  if (document.visibilityState !== 'visible') {
    return;
  }

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
  const targetSamples = isCoarsePointerDevice() ? 4000 : 10000;
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(w * h / targetSamples)));
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
  updatePanelState(state, {
    isImagePriorityMobileMode,
    getCurrentLayoutMode,
    mobileModuleSelection: _mobileModuleSelection,
    onSelectMapping: (id, currentState) => {
      store.update({
        ui: { ...currentState.ui, selectedMappingId: id },
      });
    },
    applyPreviewControlsSplit,
    updateSplitDividerUI,
    updateToneCurveControlUI,
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
  const state = store.getState();

  // If no image loaded, hide GL canvas and show drop zone to avoid black canvas
  const glCanvasEl = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  const dropZoneEl = document.getElementById('drop-zone') as HTMLElement | null;
  if (!state.imageLoaded) {
    if (glCanvasEl) glCanvasEl.style.display = 'none';
    if (dropZoneEl) dropZoneEl.style.display = 'flex';
    return;
  }

  // ensure drop zone hidden when image present
  if (dropZoneEl) dropZoneEl.style.display = 'none';

  renderer.setRenderScale(getAdaptiveRenderScale());
  applyPreviewControlsSplit(state);
  colorWheel.resize();
  requestUiRender('wheel');
  updateHistogram();

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
      renderer.resize(previewCanvas.width, previewCanvas.height);
      renderer.updateUniforms(state);
      renderer.render();
    }
  }
  refreshDominantImageHues();

  updateSplitDividerUI(state);
}

function showError(msg: string): void {
  const el = document.getElementById('error-msg');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function setupPwaHooks(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e as BeforeInstallPromptEvent;
    document.documentElement.classList.add('pwa-install-ready');
  });

  window.addEventListener('appinstalled', () => {
    _deferredInstallPrompt = null;
    document.documentElement.classList.remove('pwa-install-ready');
  });
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}





