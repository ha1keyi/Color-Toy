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
import type { AppState, LocalMapping, PreviewQualityMode } from './state/types';
import { Renderer } from './gpu/renderer';
import { ColorWheel } from './ui/wheel/colorWheel';
import { rgbToHsv } from './core/color/conversions';
import { decodeRawFile, isSupportedRawFile } from './core/image/rawDecoder';
import {
  buildPreviewRasterAssets,
  createBitmapRasterSource,
  getMaxRasterDimension,
  getRasterHeight,
  getRasterWidth,
  scaleRasterSourceToMaxDim,
  type RasterSource,
} from './core/image/rasterSource';
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
  isPortraitViewport,
  isValidLayout,
  isValidMobileModule,
  resolveResponsiveLayoutMode,
  toggleMobileModuleSelection,
} from './ui/layout/layoutState';
import type { UiLayoutMode } from './ui/layout/layoutState';
import { setupLayoutProfileManager } from './ui/layout/layoutProfileManager';

// DOM references
let renderer: Renderer;
let colorWheel: ColorWheel;
let originalRasterSource: RasterSource | null = null;
let previewRasterSource: RasterSource | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let renderedWheelCanvas: HTMLCanvasElement | null = null;
let dominantImageHues: number[] = [];
type ThemeMode = 'dark' | 'light';
type WheelLayoutMode = 'split' | 'inside';
type WheelMiniMode = 'hidden' | WheelLayoutMode;
type WheelDisplayLayer = Exclude<AppState['ui']['activeLayer'], 'toning'>;
const THEME_STORAGE_KEY = 'colorToy.theme';
type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };
type MobileModule = 'none' | 'wheels' | 'calibration' | 'mapping' | 'toning' | 'color-management' | 'history' | 'presets';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface PreviewPinchState {
  pointerIds: [number, number];
  initialDistance: number;
  initialScale: number;
  anchorX: number;
  anchorY: number;
}

function readCssVar(name: string, fallback: string): string {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function parsePixelValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findHorizontalScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScroll = (style.overflowX === 'auto' || style.overflowX === 'scroll')
      && current.scrollWidth > current.clientWidth + 1;
    if (canScroll) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function ensureActiveChipVisible(element: Element | null): void {
  if (!isMobileCompactViewport() || !(element instanceof HTMLElement)) {
    return;
  }

  const container = findHorizontalScrollContainer(element);
  if (!container) {
    return;
  }

  const padding = 12;
  const itemLeft = element.offsetLeft;
  const itemRight = itemLeft + element.offsetWidth;
  const viewLeft = container.scrollLeft;
  const viewRight = viewLeft + container.clientWidth;

  if (itemLeft >= viewLeft + padding && itemRight <= viewRight - padding) {
    return;
  }

  const centeredLeft = Math.max(0, itemLeft - Math.max((container.clientWidth - element.offsetWidth) / 2, padding));
  container.scrollTo({
    left: centeredLeft,
    behavior: 'auto',
  });
}

function applyMiniWheelPreviewOffsets(x: number, y: number): void {
  const root = document.documentElement;
  root.style.setProperty('--wheels-mini-x', `${x}px`);
  root.style.setProperty('--wheels-mini-y', `${y}px`);
}

function syncMiniWheelPreviewHost(): void {
  const controls = document.getElementById('controls') as HTMLElement | null;
  const panels = document.getElementById('panels') as HTMLElement | null;
  const host = document.getElementById('wheels-mini-preview-host') as HTMLElement | null;
  const wheelsPanel = document.getElementById('wheels-panel') as HTMLElement | null;
  if (!controls || !panels || !host || !wheelsPanel) {
    return;
  }

  const shouldFloat = controls.classList.contains('image-priority-mode')
    && !controls.classList.contains('module-wheels')
    && wheelsPanel.classList.contains('wheels-mini-preview');

  if (shouldFloat) {
    if (wheelsPanel.parentElement !== host) {
      host.appendChild(wheelsPanel);
    }
    return;
  }

  if (wheelsPanel.parentElement !== panels) {
    panels.insertBefore(wheelsPanel, panels.firstElementChild);
  }
}

function clampMiniWheelPreviewIntoViewport(): { x: number; y: number } | null {
  const panel = document.getElementById('wheels-panel') as HTMLElement | null;
  if (!panel || !isMobileCompactViewport() || !panel.classList.contains('wheels-mini-preview')) {
    return null;
  }

  const root = document.documentElement;
  const currentOffsetX = parsePixelValue(getComputedStyle(root).getPropertyValue('--wheels-mini-x'));
  const currentOffsetY = parsePixelValue(getComputedStyle(root).getPropertyValue('--wheels-mini-y'));

  applyMiniWheelPreviewOffsets(currentOffsetX, currentOffsetY);

  const rect = panel.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return { x: currentOffsetX, y: currentOffsetY };
  }

  const edgePad = 6;
  const headerHeight = parsePixelValue(getComputedStyle(root).getPropertyValue('--header-height')) || 52;
  const minTop = headerHeight + 4;
  const maxRight = window.innerWidth - edgePad;
  const maxBottom = window.innerHeight - edgePad;

  let correctedX = currentOffsetX;
  let correctedY = currentOffsetY;

  if (rect.left < edgePad) {
    correctedX += edgePad - rect.left;
  }
  if (rect.right > maxRight) {
    correctedX -= rect.right - maxRight;
  }
  if (rect.top < minTop) {
    correctedY += minTop - rect.top;
  }
  if (rect.bottom > maxBottom) {
    correctedY -= rect.bottom - maxBottom;
  }

  if (correctedX !== currentOffsetX || correctedY !== currentOffsetY) {
    applyMiniWheelPreviewOffsets(correctedX, correctedY);
  }

  return { x: correctedX, y: correctedY };
}

function scheduleMiniWheelPreviewClamp(): void {
  clampMiniWheelPreviewIntoViewport();
  if (miniWheelClampFrame) {
    window.cancelAnimationFrame(miniWheelClampFrame);
  }
  miniWheelClampFrame = window.requestAnimationFrame(() => {
    miniWheelClampFrame = 0;
    clampMiniWheelPreviewIntoViewport();
    window.requestAnimationFrame(() => {
      clampMiniWheelPreviewIntoViewport();
    });
  });
}

function scheduleWheelSurfaceRefresh(): void {
  if (wheelSurfaceRefreshFrame) {
    window.cancelAnimationFrame(wheelSurfaceRefreshFrame);
  }

  wheelSurfaceRefreshFrame = window.requestAnimationFrame(() => {
    wheelSurfaceRefreshFrame = 0;
    colorWheel.resize();
    requestUiRender('wheel');
    scheduleMiniWheelPreviewClamp();
  });
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
const DEV_SW_CLEANUP_SESSION_KEY = 'colorToy.devServiceWorkerCleanup';
const UI_LAYOUT_STORAGE_KEY = 'colorToy.ui.layout';
const MODULE_COLLAPSE_STORAGE_PREFIX = 'colorToy.ui.collapsed.';
const PREVIEW_SPLIT_STORAGE_PREFIX = 'colorToy.ui.previewSplit.';
const PREVIEW_QUALITY_STORAGE_KEY = 'colorToy.ui.previewQuality';
const WHEELS_MINI_POSITION_STORAGE_KEY = 'colorToy.ui.wheelsMiniPosition';
const PREVIEW_ZOOM_MIN = 1;
const PREVIEW_ZOOM_MAX = 4;
const PREVIEW_TAP_MOVE_THRESHOLD = 12;
let _mobileModuleSelection: MobileModule = 'none';
let _mobileCalibrationPrimary: 'none' | 'xy' | 'red' | 'green' | 'blue' = 'none';
let _mobileMappingMode: 'global' | 'point' = 'global';
let _mobileMappingControl: 'picker' | 'src' | 'dst' | 'range' | 'strength' = 'picker';
let _mobileToningControl: 'contrast' | 'exposure' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'curve' = 'contrast';
let _wheelPanelMode: WheelLayoutMode = 'split';
let _wheelPanelModeTouched = false;
let _wheelMiniMode: WheelMiniMode = 'inside';
let _lastWheelDisplayLayer: WheelDisplayLayer = 'calibration';
let miniWheelClampFrame = 0;
let wheelSurfaceRefreshFrame = 0;
let _previewControlsDividerPromoted = false;
let previewZoomScale = 1;
let previewTranslateX = 0;
let previewTranslateY = 0;
let previewLastTouchInteractionAt = 0;

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

function readStoredPreviewQualityMode(): PreviewQualityMode {
  return window.localStorage.getItem(PREVIEW_QUALITY_STORAGE_KEY) === 'full' ? 'full' : 'adaptive';
}

function persistPreviewQualityMode(mode: PreviewQualityMode): void {
  window.localStorage.setItem(PREVIEW_QUALITY_STORAGE_KEY, mode);
}

function getEffectiveRenderScale(state: AppState): number {
  return state.ui.previewQualityMode === 'full' ? 1 : getAdaptiveRenderScale();
}

function getRequestedPreviewMaxDim(state: AppState): number {
  if (!originalRasterSource || state.ui.previewQualityMode !== 'full') {
    return state.ui.previewResolution;
  }

  const maxSourceDim = getMaxRasterDimension(originalRasterSource);
  const maxTextureSize = renderer?.capabilities.maxTextureSize ?? maxSourceDim;
  return Math.min(maxSourceDim, maxTextureSize);
}

function getPreviewCanvasMetrics(): {
  containerRect: DOMRect;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} | null {
  const container = document.getElementById('preview-container') as HTMLElement | null;
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!container || !glCanvas) {
    return null;
  }

  const width = glCanvas.offsetWidth || parsePixelValue(glCanvas.style.width);
  const height = glCanvas.offsetHeight || parsePixelValue(glCanvas.style.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const centerX = containerRect.left + glCanvas.offsetLeft + width / 2;
  const centerY = containerRect.top + glCanvas.offsetTop + height / 2;
  return { containerRect, width, height, centerX, centerY };
}

function clampPreviewTransform(scale: number, translateX: number, translateY: number): {
  scale: number;
  translateX: number;
  translateY: number;
} {
  const clampedScale = Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, scale));
  if (clampedScale <= PREVIEW_ZOOM_MIN + 0.001) {
    return {
      scale: PREVIEW_ZOOM_MIN,
      translateX: 0,
      translateY: 0,
    };
  }

  const metrics = getPreviewCanvasMetrics();
  if (!metrics) {
    return {
      scale: clampedScale,
      translateX,
      translateY,
    };
  }

  const maxTranslateX = Math.max(0, (metrics.width * clampedScale - metrics.containerRect.width) / 2);
  const maxTranslateY = Math.max(0, (metrics.height * clampedScale - metrics.containerRect.height) / 2);
  return {
    scale: clampedScale,
    translateX: Math.max(-maxTranslateX, Math.min(maxTranslateX, translateX)),
    translateY: Math.max(-maxTranslateY, Math.min(maxTranslateY, translateY)),
  };
}

function applyPreviewTransform(): void {
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!glCanvas) {
    return;
  }

  if (previewZoomScale <= PREVIEW_ZOOM_MIN + 0.001) {
    previewZoomScale = PREVIEW_ZOOM_MIN;
    previewTranslateX = 0;
    previewTranslateY = 0;
    glCanvas.style.transform = '';
    glCanvas.classList.remove('is-zoomed');
  } else {
    glCanvas.style.transform = `translate3d(${previewTranslateX}px, ${previewTranslateY}px, 0) scale(${previewZoomScale})`;
    glCanvas.classList.add('is-zoomed');
  }

  updateSplitDividerUI(store.getState());
}

function setPreviewTransform(scale: number, translateX: number, translateY: number): void {
  const next = clampPreviewTransform(scale, translateX, translateY);
  previewZoomScale = next.scale;
  previewTranslateX = next.translateX;
  previewTranslateY = next.translateY;
  applyPreviewTransform();
}

function resetPreviewTransform(): void {
  previewZoomScale = PREVIEW_ZOOM_MIN;
  previewTranslateX = 0;
  previewTranslateY = 0;
  applyPreviewTransform();
}

function syncPreviewTransformToLayout(): void {
  setPreviewTransform(previewZoomScale, previewTranslateX, previewTranslateY);
}

function syncPreviewControlsDividerLayer(): void {
  const divider = document.getElementById('preview-controls-divider') as HTMLElement | null;
  if (!divider) {
    return;
  }

  divider.classList.toggle('is-promoted', _previewControlsDividerPromoted);
}

function setPreviewControlsDividerPromoted(active: boolean): void {
  _previewControlsDividerPromoted = active;
  syncPreviewControlsDividerLayer();
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
    const wheelState = getWheelRenderState(state);
    colorWheel.setState(wheelState);
    colorWheel.draw(wheelState);
    if (renderedWheelCanvas) {
      colorWheel.drawRendered(wheelState, renderedWheelCanvas);
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

  const initialState = store.getState();
  const storedPreviewQualityMode = readStoredPreviewQualityMode();
  if (initialState.ui.previewQualityMode !== storedPreviewQualityMode) {
    store.update({
      ui: {
        ...initialState.ui,
        previewQualityMode: storedPreviewQualityMode,
      },
    });
  }

  // Initialize renderer
  try {
    renderer = new Renderer(glCanvas);
    renderer.setRenderScale(getEffectiveRenderScale(store.getState()));
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
  setupPreviewCanvasInteractions();
  setupSplitDivider();
  setupCompareHint();
  setupPanels();
  setupModuleCollapse();
  setupLayoutControls();
  setupWheelControls();
  setupPreviewControlsDivider();
  setupMobileModuleBar();
  setupMobileSubmoduleControls();
  // Note: slider wrapper DOM manipulation was removed to keep markup deterministic.
  setupWheelsDock();
  setupMiniWheelsDrag();
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
  const nextValue = value === 'color-management' ? 'none' : value;
  if (_mobileModuleSelection !== nextValue) {
    setPreviewControlsDividerPromoted(false);
  }
  _mobileModuleSelection = nextValue;
  syncMobileModuleBarSelection();
}

function syncMobileModuleBarSelection(): void {
  const buttons = Array.from(document.querySelectorAll('.mobile-module-btn')) as HTMLButtonElement[];
  buttons.forEach((btn) => {
    const moduleName = btn.dataset.mobileModule as MobileModule | undefined;
    const isActive = moduleName === _mobileModuleSelection;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
    if (isActive) {
      ensureActiveChipVisible(btn);
    }
  });
}

function ensureDefaultWheelModes(): void {
  if (_wheelPanelModeTouched) return;
  const prefersInsideMode = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  _wheelPanelMode = prefersInsideMode ? 'inside' : 'split';
}

function trackWheelDisplayLayer(state: AppState): void {
  if (state.ui.activeLayer === 'calibration' || state.ui.activeLayer === 'mapping') {
    _lastWheelDisplayLayer = state.ui.activeLayer;
  }
}

function getWheelDisplayLayer(state: AppState): WheelDisplayLayer {
  if (state.ui.activeLayer === 'calibration' || state.ui.activeLayer === 'mapping') {
    return state.ui.activeLayer;
  }

  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  if (imagePriorityMobile && _mobileModuleSelection === 'wheels') {
    return _lastWheelDisplayLayer;
  }

  return _lastWheelDisplayLayer;
}

function getWheelRenderState(state: AppState): AppState {
  const wheelLayer = getWheelDisplayLayer(state);
  if (wheelLayer === state.ui.activeLayer) {
    return state;
  }

  return {
    ...state,
    ui: {
      ...state.ui,
      activeLayer: wheelLayer,
      colorPickerActive: wheelLayer === 'mapping' ? state.ui.colorPickerActive : false,
    },
  };
}

function getActiveWheelLayoutMode(_state: AppState): WheelLayoutMode {
  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  if (imagePriorityMobile && _mobileModuleSelection !== 'wheels') {
    return _wheelMiniMode === 'inside' ? 'inside' : 'split';
  }
  return _wheelPanelMode;
}

function applyWheelLayoutModeUI(state: AppState): void {
  const btn = document.getElementById('wheel-compare-btn') as HTMLButtonElement | null;
  const row = document.getElementById('wheels-row') as HTMLElement | null;
  if (!btn || !row) return;

  const activeMode = getActiveWheelLayoutMode(state);
  row.classList.remove('wheels-compare-swap', 'wheels-compare-inside');
  if (activeMode === 'inside') {
    row.classList.add('wheels-compare-inside');
  }
  const nextLabel = _wheelPanelMode === 'inside' ? 'Panel: In/Out' : 'Panel: L/R';
  const nextAction = _wheelPanelMode === 'inside'
    ? 'Switch wheels panel to left and right mode'
    : 'Switch wheels panel to inside and outside mode';
  btn.textContent = nextLabel;
  btn.title = nextAction;
  btn.setAttribute('aria-label', nextAction);
}

function shouldShowMiniWheelPreview(state: AppState): boolean {
  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  if (!imagePriorityMobile || !state.imageLoaded || _mobileModuleSelection === 'wheels' || _wheelMiniMode === 'hidden') {
    return false;
  }

  return true;
}

function shouldKeepMobileControlsVisible(state: AppState): boolean {
  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  if (!imagePriorityMobile) {
    return true;
  }

  return _mobileModuleSelection !== 'none';
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
  btn.setAttribute('aria-pressed', String(theme === 'light'));

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
  trackWheelDisplayLayer(state);
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
  const tabs = Array.from(document.querySelectorAll('.layer-tab')) as HTMLButtonElement[];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      const layer = tab.dataset.layer as AppState['ui']['activeLayer'];
      const prev = store.getState();
      store.update({
        ui: {
          ...prev.ui,
          activeLayer: layer,
          colorPickerActive: layer === 'mapping' ? prev.ui.colorPickerActive : false,
        },
      });
    });

    tab.addEventListener('keydown', (event) => {
      if (!tabs.length) return;

      let nextIndex = index;
      if (event.key === 'ArrowRight') {
        nextIndex = (index + 1) % tabs.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabs.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      nextTab.click();
    });
  });
}

function updateLayerTabs(state: AppState): void {
  document.querySelectorAll('.layer-tab').forEach((tab) => {
    const el = tab as HTMLButtonElement;
    const isActive = el.dataset.layer === state.ui.activeLayer;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      ensureActiveChipVisible(el);
    }
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
      if (file) void loadImageFile(file);
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
      if (file) void loadImageFile(file);
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

async function loadBitmapRasterSource(file: File): Promise<RasterSource> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to decode image file ${file.name}.`));
      img.src = objectUrl;
    });

    return createBitmapRasterSource(image);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function updateImportedProfileState(file: File): void {
  if (isSupportedRawFile(file)) {
    const state = store.getState();
    store.update({
      ui: {
        ...state.ui,
        importedIccProfileName: null,
        importedIccSource: null,
      },
    });
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
}

function sizePreviewCanvas(width: number, height: number): void {
  const container = document.getElementById('preview-container');
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!container || !glCanvas) {
    return;
  }

  const rect = container.getBoundingClientRect();
  const aspect = width / height;
  let cssW = rect.width;
  let cssH = cssW / aspect;
  if (cssH > rect.height) {
    cssH = rect.height;
    cssW = cssH * aspect;
  }
  glCanvas.style.width = Math.floor(cssW) + 'px';
  glCanvas.style.height = Math.floor(cssH) + 'px';
}

function renderPreviewSource(): void {
  if (!previewRasterSource) {
    return;
  }

  renderer.resize(previewRasterSource.width, previewRasterSource.height);
  sizePreviewCanvas(previewRasterSource.width, previewRasterSource.height);
  renderer.loadImage(previewRasterSource);
  const state = store.getState();
  renderer.updateUniforms(state);
  renderer.render();
  syncPreviewTransformToLayout();
}

function rebuildPreviewFromOriginal(maxDim: number): void {
  if (!originalRasterSource) {
    return;
  }

  const previewAssets = buildPreviewRasterAssets(originalRasterSource, maxDim);
  previewRasterSource = previewAssets.renderSource;
  previewCanvas = previewAssets.analysisCanvas;
  refreshDominantImageHues();
  renderPreviewSource();
}

async function loadImageFile(file: File): Promise<void> {
  const rawFile = isSupportedRawFile(file);
  if (!rawFile && !file.type.startsWith('image/')) return;
  if (!renderer) {
    showError('Renderer is not initialized, image cannot be processed.');
    return;
  }

  if (rawFile && !renderer.capabilities.losslessRawImport) {
    showError('This browser or GPU does not support 16-bit RAW texture upload. Lossless RAW import requires WebGL2 with EXT_texture_norm16.');
    return;
  }

  updateImportedProfileState(file);

  try {
    originalRasterSource = rawFile
      ? await decodeRawFile(file)
      : await loadBitmapRasterSource(file);

    const state = store.getState();
    renderer.setRenderScale(getEffectiveRenderScale(state));
    rebuildPreviewFromOriginal(getRequestedPreviewMaxDim(state));
    store.update({ imageLoaded: true });

    const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.style.display = 'none';
    if (glCanvas) glCanvas.style.display = 'block';
    resetPreviewTransform();
    setPreviewControlsDividerPromoted(false);
    handleResize();
  } catch (error) {
    console.error('Image load failed:', error);
    const details = error instanceof Error ? error.message : String(error);
    showError(`Failed to load ${file.name}. ${rawFile
      ? `RAW import error: ${details}`
      : 'Please choose a valid image file.'}`);
  }
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

  const previewQualityBtn = document.getElementById('preview-quality-btn') as HTMLButtonElement | null;
  if (previewQualityBtn) {
    previewQualityBtn.addEventListener('click', () => {
      const state = store.getState();
      const nextMode: PreviewQualityMode = state.ui.previewQualityMode === 'adaptive' ? 'full' : 'adaptive';
      persistPreviewQualityMode(nextMode);
      store.update({
        ui: {
          ...state.ui,
          previewQualityMode: nextMode,
        },
      });

      const nextState = store.getState();
      renderer.setRenderScale(getEffectiveRenderScale(nextState));
      if (nextState.imageLoaded && originalRasterSource) {
        rebuildPreviewFromOriginal(getRequestedPreviewMaxDim(nextState));
        handleResize();
      }
    });
  }

  // Undo/Redo
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.addEventListener('click', handleUndoAction);
  if (redoBtn) redoBtn.addEventListener('click', handleRedoAction);
}

function pickPreviewColorAtClient(clientX: number, clientY: number): void {
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!glCanvas) {
    return;
  }

  const state = store.getState();
  if (!state.ui.colorPickerActive || !state.imageLoaded || state.ui.activeLayer !== 'mapping') {
    return;
  }

  const rect = glCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

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
}

function togglePreviewControlsDividerPromotion(): void {
  const state = store.getState();
  if (!state.imageLoaded || !isMobileCompactViewport() || getCurrentLayoutMode() !== 'image-priority') {
    return;
  }

  const divider = document.getElementById('preview-controls-divider') as HTMLElement | null;
  if (!divider?.classList.contains('active')) {
    return;
  }

  setPreviewControlsDividerPromoted(!_previewControlsDividerPromoted);
}

function handlePreviewSurfaceTap(clientX: number, clientY: number, pointerType: 'mouse' | 'touch' | 'pen'): void {
  const state = store.getState();
  if (!state.imageLoaded) {
    return;
  }

  if (state.ui.colorPickerActive && state.ui.activeLayer === 'mapping') {
    pickPreviewColorAtClient(clientX, clientY);
    return;
  }

  if (pointerType === 'mouse' || pointerType === 'touch' || pointerType === 'pen') {
    togglePreviewControlsDividerPromotion();
  }
}

function setupPreviewCanvasInteractions(): void {
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
  if (!glCanvas) {
    return;
  }

  let tapTouchId: number | null = null;
  let tapStartX = 0;
  let tapStartY = 0;
  let tapMoved = false;
  let pinchState: PreviewPinchState | null = null;

  const getTouchPoints = (touches: TouchList): Array<{ id: number; clientX: number; clientY: number }> =>
    Array.from(touches).map((touch) => ({
      id: touch.identifier,
      clientX: touch.clientX,
      clientY: touch.clientY,
    }));

  const beginPinch = (touches: TouchList): void => {
    const touchPoints = getTouchPoints(touches);
    if (touchPoints.length < 2) {
      pinchState = null;
      return;
    }

    const [first, second] = touchPoints;
    const metrics = getPreviewCanvasMetrics();
    if (!metrics) {
      pinchState = null;
      return;
    }

    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    pinchState = {
      pointerIds: [first.id, second.id],
      initialDistance: Math.max(distance, 1),
      initialScale: previewZoomScale,
      anchorX: (centerX - metrics.centerX - previewTranslateX) / Math.max(previewZoomScale, PREVIEW_ZOOM_MIN),
      anchorY: (centerY - metrics.centerY - previewTranslateY) / Math.max(previewZoomScale, PREVIEW_ZOOM_MIN),
    };
  };

  const updatePinch = (touches: TouchList): void => {
    if (!pinchState) {
      return;
    }

    const touchPoints = getTouchPoints(touches);
    const first = touchPoints.find((touch) => touch.id === pinchState?.pointerIds[0]);
    const second = touchPoints.find((touch) => touch.id === pinchState?.pointerIds[1]);
    const metrics = getPreviewCanvasMetrics();
    if (!first || !second || !metrics) {
      beginPinch(touches);
      return;
    }

    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    const nextScale = pinchState.initialScale * (distance / pinchState.initialDistance);
    const nextTranslateX = centerX - metrics.centerX - pinchState.anchorX * nextScale;
    const nextTranslateY = centerY - metrics.centerY - pinchState.anchorY * nextScale;
    setPreviewTransform(nextScale, nextTranslateX, nextTranslateY);
  };

  glCanvas.addEventListener('click', (event) => {
    if (Date.now() - previewLastTouchInteractionAt < 700) {
      return;
    }
    handlePreviewSurfaceTap(event.clientX, event.clientY, 'mouse');
  });

  glCanvas.addEventListener('touchstart', (event) => {
    if (!store.getState().imageLoaded) {
      return;
    }

    previewLastTouchInteractionAt = Date.now();
    event.preventDefault();
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      tapTouchId = touch.identifier;
      tapStartX = touch.clientX;
      tapStartY = touch.clientY;
      tapMoved = false;
      pinchState = null;
      return;
    }

    tapTouchId = null;
    tapMoved = true;
    beginPinch(event.touches);
    updatePinch(event.touches);
  }, { passive: false });

  glCanvas.addEventListener('touchmove', (event) => {
    if (event.touches.length === 0) {
      return;
    }

    previewLastTouchInteractionAt = Date.now();
    event.preventDefault();

    if (!tapMoved && tapTouchId !== null) {
      const activeTouch = Array.from(event.touches).find((touch) => touch.identifier === tapTouchId);
      if (activeTouch) {
        tapMoved = Math.hypot(activeTouch.clientX - tapStartX, activeTouch.clientY - tapStartY) > PREVIEW_TAP_MOVE_THRESHOLD;
      }
    }

    if (event.touches.length >= 2) {
      tapMoved = true;
      const activeTouchIds = new Set(Array.from(event.touches).map((touch) => touch.identifier));
      if (!pinchState
        || !activeTouchIds.has(pinchState.pointerIds[0])
        || !activeTouchIds.has(pinchState.pointerIds[1])) {
        beginPinch(event.touches);
      }
      updatePinch(event.touches);
    }
  }, { passive: false });

  glCanvas.addEventListener('touchend', (event) => {
    previewLastTouchInteractionAt = Date.now();
    const changedTouches = Array.from(event.changedTouches);
    const endedTap = tapTouchId !== null
      ? changedTouches.find((touch) => touch.identifier === tapTouchId)
      : null;
    const wasSingleTap = !!endedTap && event.touches.length === 0 && !tapMoved && !pinchState;

    if (event.touches.length < 2) {
      pinchState = null;
    } else {
      beginPinch(event.touches);
    }

    if (wasSingleTap && endedTap) {
      handlePreviewSurfaceTap(endedTap.clientX, endedTap.clientY, 'touch');
    }

    if (endedTap) {
      tapTouchId = null;
    }
  }, { passive: false });

  glCanvas.addEventListener('touchcancel', (event) => {
    previewLastTouchInteractionAt = Date.now();
    event.preventDefault();
    if (event.touches.length < 2) {
      pinchState = null;
    } else {
      beginPinch(event.touches);
    }
    tapTouchId = null;
    tapMoved = false;
  }, { passive: false });
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

  const mobileImagePriority = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  const visible = state.ui.splitView && state.imageLoaded && (!mobileImagePriority || _mobileModuleSelection === 'wheels');
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
  if (!btn) return;

  ensureDefaultWheelModes();
  applyWheelLayoutModeUI(store.getState());
  btn.addEventListener('click', () => {
    _wheelPanelModeTouched = true;
    _wheelPanelMode = _wheelPanelMode === 'inside' ? 'split' : 'inside';
    applyWheelLayoutModeUI(store.getState());
    requestUiRender('wheel');
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
    layoutToggleBtn.setAttribute('aria-pressed', String(mode === 'image-priority'));
    const label = layoutToggleBtn.querySelector('span') || layoutToggleBtn;
    label.textContent = mode === 'image-priority' ? 'Layout: Image' : 'Layout: Controls';
    layoutToggleBtn.title = mode === 'image-priority'
      ? 'Switch to controls priority layout'
      : 'Switch to image priority layout';
    layoutToggleBtn.setAttribute('aria-label', layoutToggleBtn.title);
  };

  const getStoredLayoutPreference = (): UiLayoutMode => {
    const layoutStored = window.localStorage.getItem(UI_LAYOUT_STORAGE_KEY);
    return isValidLayout(layoutStored || '')
      ? layoutStored as UiLayoutMode
      : 'controls-priority';
  };

  const syncLayoutToggleVisibility = () => {
    if (!layoutToggleBtn) return;
    layoutToggleBtn.style.display = isMobileCompactViewport() && !isPortraitViewport() ? '' : 'none';
  };

  const applyResponsiveLayout = (requestedMode: UiLayoutMode): UiLayoutMode => {
    const appliedMode = applyLayoutMode(requestedMode, () => {
      setMobileModuleSelection('none');
    });
    updateLayoutButton(appliedMode);
    return appliedMode;
  };

  const initialRequestedLayout = getStoredLayoutPreference();
  syncLayoutToggleVisibility();

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

  applyResponsiveLayout(initialRequestedLayout);

  if (layoutToggleBtn) {
    layoutToggleBtn.addEventListener('click', () => {
      const current = getCurrentLayoutMode();
      const selected = current === 'controls-priority' ? 'image-priority' : 'controls-priority';
      window.localStorage.setItem(UI_LAYOUT_STORAGE_KEY, selected);
      applyResponsiveLayout(selected);
      updatePanelUI(store.getState());
      handleResize();
    });
  }

  window.addEventListener('resize', () => {
    syncLayoutToggleVisibility();

    const currentMode = getCurrentLayoutMode();
    const requestedMode = getStoredLayoutPreference();
    const resolvedMode = resolveResponsiveLayoutMode(requestedMode);
    if (currentMode === resolvedMode) {
      updateLayoutButton(currentMode);
      return;
    }

    applyResponsiveLayout(requestedMode);
    updatePanelUI(store.getState());
  });
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
  const miniVisibilityBtn = document.getElementById('wheel-mini-visibility-btn') as HTMLButtonElement | null;

  if (miniVisibilityBtn) {
    miniVisibilityBtn.addEventListener('click', () => {
      _wheelMiniMode = _wheelMiniMode === 'inside'
        ? 'split'
        : _wheelMiniMode === 'split'
          ? 'hidden'
          : 'inside';
      updatePanelUI(store.getState());
      requestUiRender('wheel');
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
    controls.classList.remove('compact-idle');
    divider.classList.remove('active');
    setPreviewControlsDividerPromoted(false);
    return;
  }

  const layoutMode = getCurrentLayoutMode();
  const keepControlsVisible = layoutMode !== 'image-priority' || shouldKeepMobileControlsVisible(state);
  const dividerVisible = layoutMode === 'image-priority' && state.imageLoaded && keepControlsVisible;
  controls.classList.toggle('compact-idle', layoutMode === 'image-priority' && !keepControlsVisible);
  divider.classList.toggle('active', dividerVisible);
  if (!dividerVisible) {
    setPreviewControlsDividerPromoted(false);
  } else {
    syncPreviewControlsDividerLayer();
  }

  if (layoutMode === 'image-priority' && !keepControlsVisible) {
    app.style.setProperty('--preview-controls-ratio', '1');
    app.style.setProperty('--controls-flex-ratio', '0');
    controls.classList.remove('full-preview');
    return;
  }

  const storedRatio = layoutMode === 'image-priority'
    ? state.ui.imagePriorityPreviewRatio
    : state.ui.controlsPriorityPreviewRatio;
  const ratio = clampPreviewRatio(storedRatio);

  app.style.setProperty('--preview-controls-ratio', ratio.toFixed(4));
  app.style.setProperty('--controls-flex-ratio', (1 - ratio).toFixed(4));
  controls.classList.remove('full-preview');
  divider.classList.toggle('active', dividerVisible);
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

        if (_mobileModuleSelection === 'calibration') {
          _mobileCalibrationPrimary = _mobileCalibrationPrimary === 'none' ? 'red' : _mobileCalibrationPrimary;
        }
        if (_mobileModuleSelection === 'mapping') {
          // Keep mapping hierarchy: secondary = global/point, tertiary = picker/source/target/range/strength.
          _mobileMappingMode = 'global';
          _mobileMappingControl = 'picker';
        }
        if (_mobileModuleSelection === 'toning') {
          _mobileToningControl = 'contrast';
        }
      }

      updatePanelUI(store.getState());
      handleResize();
      window.setTimeout(() => {
        clampMiniWheelPreviewIntoViewport();
      }, 0);
    });
  });

  syncMobileModuleBarSelection();
  window.addEventListener('resize', () => {
    updatePanelUI(store.getState());
  });
}

function setupWheelsDock(): void {
  const dockBtn = document.getElementById('wheels-dock-btn') as HTMLButtonElement | null;
  if (!dockBtn) return;

  dockBtn.addEventListener('click', () => {
    if (!isMobileCompactViewport() || getCurrentLayoutMode() !== 'image-priority') return;

    ensureDefaultWheelModes();
    const next: MobileModule = _mobileModuleSelection === 'wheels' ? 'none' : 'wheels';
    setMobileModuleSelection(next);
    updatePanelUI(store.getState());
    handleResize();
    window.setTimeout(() => {
      clampMiniWheelPreviewIntoViewport();
    }, 0);
  });
}

function setupMiniWheelsDrag(): void {
  const panel = document.getElementById('wheels-panel') as HTMLElement | null;
  if (!panel) {
    return;
  }
  const controls = document.getElementById('controls') as HTMLElement | null;

  const root = document.documentElement;
  let dragging = false;
  let activePointerId: number | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;
  let currentOffsetX = 0;
  let currentOffsetY = 0;
  let syncFrame = 0;

  const isMiniPreviewVisible = (): boolean => {
    if (!isMobileCompactViewport() || getCurrentLayoutMode() !== 'image-priority') return false;
    return panel.classList.contains('wheels-mini-preview');
  };

  const isDraggableMiniPreview = (): boolean => {
    if (!isMiniPreviewVisible()) return false;
    return _mobileModuleSelection !== 'wheels';
  };

  const applyOffsets = (x: number, y: number): void => {
    currentOffsetX = x;
    currentOffsetY = y;
    applyMiniWheelPreviewOffsets(x, y);
  };

  const clampAndApply = (x: number, y: number): void => {
    applyOffsets(x, y);

    const clamped = clampMiniWheelPreviewIntoViewport();
    if (clamped) {
      currentOffsetX = clamped.x;
      currentOffsetY = clamped.y;
    }
  };

  const persistOffsets = (): void => {
    window.localStorage.setItem(
      WHEELS_MINI_POSITION_STORAGE_KEY,
      JSON.stringify({ x: Math.round(currentOffsetX), y: Math.round(currentOffsetY) }),
    );
  };

  const loadStoredOffsets = (): void => {
    try {
      const raw = window.localStorage.getItem(WHEELS_MINI_POSITION_STORAGE_KEY);
      if (!raw) {
        applyOffsets(0, 0);
        return;
      }
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
      const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : 0;
      const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : 0;
      applyOffsets(x, y);
    } catch {
      applyOffsets(0, 0);
    }
  };

  const syncPositionNow = (): void => {
    if (!isMiniPreviewVisible()) return;
    const clamped = clampMiniWheelPreviewIntoViewport();
    if (clamped) {
      currentOffsetX = clamped.x;
      currentOffsetY = clamped.y;
    }
  };

  const syncPosition = (): void => {
    syncPositionNow();
    if (syncFrame) {
      window.cancelAnimationFrame(syncFrame);
    }
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0;
      syncPositionNow();
    });
  };

  panel.addEventListener('pointerdown', (event) => {
    if (!isDraggableMiniPreview()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button,input,select,textarea,a')) return;

    dragging = true;
    activePointerId = event.pointerId;
    startClientX = event.clientX;
    startClientY = event.clientY;

    startOffsetX = parsePixelValue(getComputedStyle(root).getPropertyValue('--wheels-mini-x'));
    startOffsetY = parsePixelValue(getComputedStyle(root).getPropertyValue('--wheels-mini-y'));

    panel.classList.add('is-dragging');
    panel.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;

    const nextX = startOffsetX + (event.clientX - startClientX);
    const nextY = startOffsetY + (event.clientY - startClientY);
    clampAndApply(nextX, nextY);
  });

  const finishDrag = (pointerId?: number): void => {
    if (!dragging) return;
    if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) return;

    dragging = false;
    activePointerId = null;
    panel.classList.remove('is-dragging');
    persistOffsets();
  };

  window.addEventListener('pointerup', (event) => finishDrag(event.pointerId));
  window.addEventListener('pointercancel', (event) => finishDrag(event.pointerId));
  panel.addEventListener('lostpointercapture', () => finishDrag());

  window.addEventListener('resize', syncPosition);

  const syncObserver = new MutationObserver(() => {
    syncPosition();
  });
  syncObserver.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });
  if (controls) {
    syncObserver.observe(controls, {
      attributes: true,
      attributeFilter: ['class', 'data-mobile-module', 'data-wheel-mini-mode', 'data-wheel-layer'],
    });
  }

  loadStoredOffsets();
  syncPosition();
}

function syncIsolatedOverlayBottomOffset(state: AppState): void {
  const controls = document.getElementById('controls') as HTMLElement | null;
  if (!controls) return;

  void state;
  controls.style.removeProperty('--isolated-overlay-extra-bottom');
}

function syncMiniWheelPreviewOffset(state: AppState): void {
  const controls = document.getElementById('controls') as HTMLElement | null;
  if (!controls) return;

  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';
  if (!imagePriorityMobile || !shouldShowMiniWheelPreview(state)) {
    controls.style.removeProperty('--wheels-mini-preview-offset');
    return;
  }

  const candidates = [
    _mobileModuleSelection === 'history' ? 'history-panel' : null,
    _mobileModuleSelection === 'presets' ? 'bottom-bar' : null,
    _mobileModuleSelection === 'color-management' ? 'color-management-panel' : null,
    _mobileModuleSelection === 'calibration' ? 'isolated-cal-sliders' : null,
    _mobileModuleSelection === 'mapping' || _mobileModuleSelection === 'toning'
      ? 'isolated-controls-sliders'
      : null,
  ]
    .filter((id): id is string => !!id)
    .map((id) => document.getElementById(id) as HTMLElement | null)
    .filter((element): element is HTMLElement => !!element);

  let extraBottom = 10;
  candidates.forEach((element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    const rect = element.getBoundingClientRect();
    if (rect.height < 1 || rect.top >= window.innerHeight) return;

    const candidateOffset = Math.round(window.innerHeight - rect.top + 10);
    extraBottom = Math.max(extraBottom, candidateOffset);
  });

  controls.style.setProperty('--wheels-mini-preview-offset', `${extraBottom}px`);
}

function setupMobileSubmoduleControls(): void {
  const calibrationTabs = Array.from(document.querySelectorAll('#calibration-primary-tabs [data-cal-primary]')) as HTMLButtonElement[];
  calibrationTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.calPrimary;
      if (next === 'none' || next === 'xy' || next === 'red' || next === 'green' || next === 'blue') {
        _mobileCalibrationPrimary = next;
        updatePanelUI(store.getState());
      }
    });
  });

  const mappingModeTabs = Array.from(document.querySelectorAll('#mapping-mode-tabs [data-mapping-mode]')) as HTMLButtonElement[];
  mappingModeTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mappingMode;
      if (next === 'global' || next === 'point') {
        _mobileMappingMode = next;
        if (next === 'global') {
          _mobileMappingControl = 'picker';
        }
        updatePanelUI(store.getState());
      }
    });
  });

  const mappingControlTabs = Array.from(document.querySelectorAll('#mapping-control-tabs [data-mapping-control]')) as HTMLButtonElement[];
  mappingControlTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mappingControl;
      if (next === 'picker' || next === 'src' || next === 'dst' || next === 'range' || next === 'strength') {
        _mobileMappingControl = next;
        updatePanelUI(store.getState());
      }
    });
  });

  const toningTabs = Array.from(document.querySelectorAll('#toning-control-tabs [data-toning-control]')) as HTMLButtonElement[];
  toningTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.toningControl;
      if (next === 'contrast' || next === 'exposure' || next === 'highlights' || next === 'shadows' || next === 'whites' || next === 'blacks' || next === 'curve') {
        _mobileToningControl = next;
        updatePanelUI(store.getState());
      }
    });
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
    const isWheelsPanel = targetId === 'wheels-panel';

    const apply = () => {
      target.classList.toggle('is-collapsed', collapsed);
      button.classList.toggle('is-collapsed', collapsed);
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      if (isWheelsPanel) {
        button.title = collapsed ? 'Expand wheels' : 'Collapse wheels';
      } else {
        button.title = collapsed ? 'Expand module' : 'Collapse module';
      }
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
  if (!originalRasterSource) return;

  const state = store.getState();
  const exportState: AppState = {
    ...state,
    ui: {
      ...state.ui,
      holdCompareActive: false,
    },
  };

  const exportSource = scaleRasterSourceToMaxDim(originalRasterSource, 4096);
  const offCanvas = document.createElement('canvas');
  offCanvas.width = getRasterWidth(exportSource);
  offCanvas.height = getRasterHeight(exportSource);

  try {
    const exportRenderer = new Renderer(offCanvas);
    exportRenderer.loadImage(exportSource);
    exportRenderer.setToneCurveLut(buildToneCurveLut());
    exportRenderer.updateUniforms(exportState);
    exportRenderer.render();

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
    const state = store.getState();
    if (state.ui.previewQualityMode === 'full') {
      return;
    }

    // Auto-downgrade resolution if needed
    if (fps < 20) {
      const loweredScale = Math.max(0.55, renderer.getRenderScale() - 0.1);
      renderer.setRenderScale(loweredScale);

      if (state.ui.previewResolution > 512 && previewCanvas && originalRasterSource) {
        const newRes = state.ui.previewResolution === 1080 ? 720 : 512;
        store.update({
          ui: { ...state.ui, previewResolution: newRes as 1080 | 720 | 512 },
        });
        rebuildPreviewFromOriginal(newRes);
        renderer.setRenderScale(Math.min(renderer.getRenderScale(), getEffectiveRenderScale(store.getState())));
      }
    } else if (fps > 40) {
      renderer.setRenderScale(getEffectiveRenderScale(state));
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
  ensureDefaultWheelModes();
  trackWheelDisplayLayer(state);
  const wheelsPanel = document.getElementById('wheels-panel') as HTMLElement | null;
  const panels = document.getElementById('panels') as HTMLElement | null;
  const previousWheelParent = wheelsPanel?.parentElement?.id ?? '';
  const previousWheelDisplay = wheelsPanel?.style.display ?? '';
  const previousMiniPreview = wheelsPanel?.classList.contains('wheels-mini-preview') ?? false;
  const previousPanelsDisplay = panels?.style.display ?? '';

  updatePanelState(state, {
    isImagePriorityMobileMode,
    getCurrentLayoutMode,
    mobileModuleSelection: _mobileModuleSelection,
    mobileMappingMode: _mobileMappingMode,
    wheelMiniMode: _wheelMiniMode,
    wheelDisplayLayer: getWheelDisplayLayer(state),
    onSelectMapping: (id, currentState) => {
      store.update({
        ui: { ...currentState.ui, selectedMappingId: id },
      });
    },
    applyPreviewControlsSplit,
    updateSplitDividerUI,
    updateToneCurveControlUI,
  });

  const app = document.getElementById('app');
  const controls = document.getElementById('controls');
  const calibrationPanel = document.getElementById('calibration-panel');
  const mappingPanel = document.getElementById('mapping-panel');
  const toningPanel = document.getElementById('toning-panel');
  const dockBtn = document.getElementById('wheels-dock-btn') as HTMLButtonElement | null;

  if (calibrationPanel) {
    calibrationPanel.setAttribute('data-cal-primary', _mobileModuleSelection === 'calibration' ? _mobileCalibrationPrimary : 'none');
  }
  if (mappingPanel) {
    mappingPanel.setAttribute('data-mapping-mode', _mobileMappingMode);
    mappingPanel.setAttribute('data-mapping-control', _mobileMappingControl);
  }
  if (toningPanel) toningPanel.setAttribute('data-toning-control', _mobileToningControl);

  syncMiniWheelPreviewHost();

  applyWheelLayoutModeUI(state);
  syncIsolatedOverlayBottomOffset(state);
  syncMiniWheelPreviewOffset(state);

  const syncActive = (selector: string, key: string, value: string) => {
    document.querySelectorAll(selector).forEach((el) => {
      const btn = el as HTMLElement;
      const isActive = btn.dataset[key] === value;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
      if (isActive) {
        ensureActiveChipVisible(btn);
      }
    });
  };

  syncActive('#calibration-primary-tabs [data-cal-primary]', 'calPrimary', _mobileCalibrationPrimary);
  syncActive('#mapping-mode-tabs [data-mapping-mode]', 'mappingMode', _mobileMappingMode);
  syncActive('#mapping-control-tabs [data-mapping-control]', 'mappingControl', _mobileMappingControl);
  syncActive('#toning-control-tabs [data-toning-control]', 'toningControl', _mobileToningControl);

  const imagePriorityMobile = isMobileCompactViewport() && getCurrentLayoutMode() === 'image-priority';

  if (app) {
    app.classList.remove('auto-overlay-mode');
    app.classList.remove('compact-adjustment-mode');
  }

  if (imagePriorityMobile && state.ui.activeLayer === 'calibration' && _mobileCalibrationPrimary === 'xy') {
    drawXYDiagram(state);
  }

  if (imagePriorityMobile && state.ui.activeLayer === 'toning' && _mobileToningControl === 'curve') {
    drawToneCurve();
  }

  if (controls) {
    controls.classList.toggle('module-calibration', _mobileModuleSelection === 'calibration');
    controls.classList.toggle('module-mapping', _mobileModuleSelection === 'mapping');
    controls.classList.toggle('module-toning', _mobileModuleSelection === 'toning');
    controls.classList.toggle('module-color-management', _mobileModuleSelection === 'color-management');
    controls.classList.toggle('module-wheels', _mobileModuleSelection === 'wheels');
    controls.dataset.mobileModule = _mobileModuleSelection;
    controls.dataset.calPrimary = _mobileModuleSelection === 'calibration' ? _mobileCalibrationPrimary : 'none';
    controls.dataset.mappingMode = _mobileModuleSelection === 'mapping' ? _mobileMappingMode : '';
    controls.dataset.mappingControl = _mobileModuleSelection === 'mapping' ? _mobileMappingControl : '';
    controls.dataset.toningControl = _mobileModuleSelection === 'toning' ? _mobileToningControl : '';
    controls.dataset.wheelMiniMode = _wheelMiniMode;
    controls.dataset.wheelLayer = getWheelDisplayLayer(state);
  }

  if (dockBtn) {
    const shouldShowDock = imagePriorityMobile;
    dockBtn.style.display = shouldShowDock ? 'inline-flex' : 'none';
    const dockActive = _mobileModuleSelection === 'wheels';
    dockBtn.classList.toggle('active', dockActive);
    dockBtn.classList.toggle('mode-in', dockActive);
    dockBtn.classList.toggle('mode-out', !dockActive);
    dockBtn.title = dockActive
      ? 'Hide Wheels'
      : _wheelMiniMode === 'hidden'
        ? 'Show Wheels Panel'
        : _wheelMiniMode === 'inside'
          ? 'Show Wheels (In/Out)'
          : 'Show Wheels (L/R)';
    dockBtn.setAttribute('aria-pressed', String(dockActive));
    dockBtn.setAttribute('aria-label', dockBtn.title);
  }

  const nextWheelDisplay = wheelsPanel?.style.display ?? '';
  const nextMiniPreview = wheelsPanel?.classList.contains('wheels-mini-preview') ?? false;
  const nextWheelParent = wheelsPanel?.parentElement?.id ?? '';
  const nextPanelsDisplay = panels?.style.display ?? '';
  if (
    previousWheelParent !== nextWheelParent
    || previousWheelDisplay !== nextWheelDisplay
    || previousMiniPreview !== nextMiniPreview
    || previousPanelsDisplay !== nextPanelsDisplay
  ) {
    scheduleWheelSurfaceRefresh();
    return;
  }

  scheduleMiniWheelPreviewClamp();
}

function updateCapabilitiesDisplay(): void {
  const el = document.getElementById('capabilities');
  if (el && renderer) {
    const cap = renderer.capabilities;
    el.textContent = `WebGL ${cap.webgl2 ? '2.0' : '1.0'} | Max mappings: ${cap.maxMappings} | RAW 16-bit: ${cap.losslessRawImport ? 'yes' : 'no'}`;
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

  renderer.setRenderScale(getEffectiveRenderScale(state));
  applyPreviewControlsSplit(state);
  colorWheel.resize();
  requestUiRender('wheel');
  updateHistogram();

  // Redraw diagrams
  if (state.ui.activeLayer === 'calibration') drawXYDiagram(state);
  if (state.ui.activeLayer === 'toning') drawToneCurve();

  scheduleMiniWheelPreviewClamp();

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
      syncPreviewTransformToLayout();
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
  if (!import.meta.env.PROD) {
    document.documentElement.classList.remove('pwa-install-ready');
    _deferredInstallPrompt = null;
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    _deferredInstallPrompt = e as BeforeInstallPromptEvent;
    document.documentElement.classList.add('pwa-install-ready');
  });

  window.addEventListener('appinstalled', () => {
    _deferredInstallPrompt = null;
    document.documentElement.classList.remove('pwa-install-ready');
  });
}

async function clearColorToyCaches(): Promise<void> {
  if (!('caches' in window)) {
    return;
  }

  const cacheKeys = await window.caches.keys();
  await Promise.all(
    cacheKeys
      .filter((key) => key.startsWith('color-toy'))
      .map((key) => window.caches.delete(key)),
  );
}

async function cleanupDevelopmentServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  const hadRegistrations = registrations.length > 0 || !!navigator.serviceWorker.controller;

  await Promise.all(registrations.map((registration) => registration.unregister()));
  await clearColorToyCaches();

  if (hadRegistrations) {
    const didReload = window.sessionStorage.getItem(DEV_SW_CLEANUP_SESSION_KEY) === '1';
    if (!didReload) {
      window.sessionStorage.setItem(DEV_SW_CLEANUP_SESSION_KEY, '1');
      window.location.reload();
      return;
    }
  }

  window.sessionStorage.removeItem(DEV_SW_CLEANUP_SESSION_KEY);
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  if (!import.meta.env.PROD) {
    window.addEventListener('load', () => {
      cleanupDevelopmentServiceWorkers().catch((error) => {
        console.warn('Development service worker cleanup failed:', error);
      });
    });
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






