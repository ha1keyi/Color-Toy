import type { AppState } from '../../state/types';
import {
  updateMappingDetail,
  updateMappingList,
  updateNumberInput,
  updateSlider,
} from './panelControls';

export type MobileModule = 'none' | 'wheels' | 'calibration' | 'mapping' | 'toning' | 'color-management' | 'history' | 'presets';

interface PanelStateDeps {
  isImagePriorityMobileMode: () => boolean;
  getCurrentLayoutMode: () => 'image-priority' | 'controls-priority';
  mobileModuleSelection: MobileModule;
  mobileMappingMode: 'global' | 'point';
  wheelMiniMode: 'hidden' | 'split' | 'inside';
  wheelDisplayLayer: 'calibration' | 'mapping';
  onSelectMapping: (id: string, state: AppState) => void;
  applyPreviewControlsSplit: (state: AppState) => void;
  updateSplitDividerUI: (state: AppState) => void;
  updateToneCurveControlUI: (state: AppState) => void;
}

function forceExpanded(panelId: string, collapseBtnId: string): void {
  const panel = document.getElementById(panelId);
  const collapseBtn = document.getElementById(collapseBtnId) as HTMLButtonElement | null;
  if (panel?.classList.contains('is-collapsed')) {
    panel.classList.remove('is-collapsed');
  }
  if (collapseBtn) {
    collapseBtn.classList.remove('is-collapsed');
    collapseBtn.setAttribute('aria-expanded', 'true');
    collapseBtn.title = panelId === 'wheels-panel' ? 'Collapse wheels' : 'Collapse module';
  }
}

export function updatePanelState(state: AppState, deps: PanelStateDeps): void {
  const calibrationPanel = document.getElementById('calibration-panel');
  const wheelsPanel = document.getElementById('wheels-panel');
  const xyPanel = document.getElementById('xy-panel');
  const mappingPanel = document.getElementById('mapping-panel');
  const toningPanel = document.getElementById('toning-panel');
  const wheelsRow = document.getElementById('wheels-row');
  const historyPanel = document.getElementById('history-panel');
  const panels = document.getElementById('panels');
  const controls = document.getElementById('controls');
  const mobileBar = document.getElementById('mobile-module-bar');
  const bottomBar = document.getElementById('bottom-bar');
  const presetSection = document.getElementById('preset-section');
  const colorManagementPanel = document.getElementById('color-management-panel');
  const capabilities = document.getElementById('capabilities');

  const wheelsAvailableByLayer = state.ui.activeLayer !== 'toning' || deps.mobileModuleSelection === 'wheels';
  const calibrationActive = state.ui.activeLayer === 'calibration';
  const imagePriorityMobile = deps.isImagePriorityMobileMode();
  const showMiniWheelPreview = imagePriorityMobile
    && state.imageLoaded
    && deps.mobileModuleSelection !== 'wheels'
    && deps.wheelMiniMode !== 'hidden';

  if (wheelsPanel) wheelsPanel.style.display = wheelsAvailableByLayer ? 'block' : 'none';
  if (calibrationPanel) calibrationPanel.style.display = calibrationActive ? 'block' : 'none';
  if (xyPanel) xyPanel.style.display = calibrationActive ? 'block' : 'none';
  if (mappingPanel) mappingPanel.style.display = state.ui.activeLayer === 'mapping' ? 'block' : 'none';
  if (toningPanel) toningPanel.style.display = state.ui.activeLayer === 'toning' ? 'block' : 'none';

  if (wheelsRow) {
    const wheelsCollapsed = wheelsPanel?.classList.contains('is-collapsed') ?? false;
    wheelsRow.style.display = wheelsAvailableByLayer && !wheelsCollapsed ? 'flex' : 'none';
  }

  const moduleOverlayOpen = imagePriorityMobile && deps.mobileModuleSelection !== 'none';
  if (mobileBar) {
    mobileBar.classList.toggle('active', imagePriorityMobile);
  }

  if (controls) {
    controls.classList.toggle('image-priority-mode', imagePriorityMobile);
    controls.classList.toggle('module-open', moduleOverlayOpen);
  }

  if (imagePriorityMobile) {
    if (historyPanel) {
      historyPanel.style.display = deps.mobileModuleSelection === 'history' ? 'block' : 'none';
    }

    const layerSelection = deps.mobileModuleSelection === 'wheels'
      || deps.mobileModuleSelection === 'calibration'
      || deps.mobileModuleSelection === 'mapping'
      || deps.mobileModuleSelection === 'toning';
    const showPanelsShell = layerSelection || showMiniWheelPreview;
    const presetsSelection = deps.mobileModuleSelection === 'presets';
    const colorManagementSelection = deps.mobileModuleSelection === 'color-management';
    if (panels) {
      panels.style.display = showPanelsShell ? 'block' : 'none';
    }

    if (bottomBar) {
      bottomBar.style.display = presetsSelection ? 'block' : 'none';
    }
    if (presetSection) {
      presetSection.style.display = presetsSelection ? 'flex' : 'none';
    }
    if (colorManagementPanel) {
      colorManagementPanel.style.display = colorManagementSelection ? 'block' : 'none';
    }
    if (capabilities) {
      capabilities.style.display = presetsSelection ? 'block' : 'none';
    }

    if (wheelsPanel) {
      const wheelsSelection = deps.mobileModuleSelection === 'wheels';
      wheelsPanel.style.display = wheelsSelection || showMiniWheelPreview ? 'block' : 'none';
      wheelsPanel.classList.toggle('wheels-mini-preview', showMiniWheelPreview);
      if (wheelsSelection) forceExpanded('wheels-panel', 'wheels-collapse-btn');
    }
    if (calibrationPanel) {
      const isCalibration = deps.mobileModuleSelection === 'calibration';
      calibrationPanel.style.display = isCalibration ? 'block' : 'none';
      if (isCalibration) forceExpanded('calibration-panel', 'calibration-collapse-btn');
    }
    if (xyPanel) {
      const isCalibration = deps.mobileModuleSelection === 'calibration';
      xyPanel.style.display = isCalibration ? 'block' : 'none';
      if (isCalibration) forceExpanded('xy-panel', 'xy-panel-collapse-btn');
    }
    if (mappingPanel) {
      const isMapping = deps.mobileModuleSelection === 'mapping';
      mappingPanel.style.display = isMapping ? 'block' : 'none';
      if (isMapping) forceExpanded('mapping-panel', 'mapping-collapse-btn');
    }
    if (toningPanel) {
      const isToning = deps.mobileModuleSelection === 'toning';
      toningPanel.style.display = isToning ? 'block' : 'none';
      if (isToning) forceExpanded('toning-panel', 'toning-collapse-btn');
    }

    if (wheelsRow) {
      const wheelsSelection = deps.mobileModuleSelection === 'wheels';
      const shouldShowWheels = wheelsSelection || showMiniWheelPreview;
      const wheelsCollapsed = wheelsSelection && (wheelsPanel?.classList.contains('is-collapsed') ?? false);
      wheelsRow.style.display = shouldShowWheels && !wheelsCollapsed ? 'flex' : 'none';
    }
  } else {
    if (wheelsPanel) wheelsPanel.style.display = wheelsAvailableByLayer ? 'block' : 'none';
    if (historyPanel) historyPanel.style.display = 'block';
    if (panels) panels.style.display = 'block';
    if (bottomBar) bottomBar.style.display = 'block';
    if (presetSection) presetSection.style.display = 'flex';
    if (capabilities) capabilities.style.display = 'block';
    if (colorManagementPanel) colorManagementPanel.style.display = 'block';
  }

  if (wheelsRow && !imagePriorityMobile) {
    const shouldShowWheels = state.ui.activeLayer !== 'toning';
    const wheelsCollapsed = wheelsPanel?.classList.contains('is-collapsed') ?? false;
    wheelsRow.style.display = shouldShowWheels && !wheelsCollapsed ? 'flex' : 'none';
  }

  const splitBtn = document.getElementById('split-btn');
  if (splitBtn) {
    splitBtn.classList.toggle('active', state.ui.splitView);
    splitBtn.setAttribute('aria-pressed', String(state.ui.splitView));
    splitBtn.toggleAttribute('disabled', !state.imageLoaded);
    splitBtn.setAttribute(
      'aria-label',
      state.imageLoaded
        ? (state.ui.splitView ? 'Disable split compare' : 'Enable split compare')
        : 'Load an image to enable split compare',
    );
  }

  const previewQualityBtn = document.getElementById('preview-quality-btn') as HTMLButtonElement | null;
  if (previewQualityBtn) {
    const fullQuality = state.ui.previewQualityMode === 'full';
    previewQualityBtn.classList.toggle('active', fullQuality);
    previewQualityBtn.setAttribute('aria-pressed', String(fullQuality));
    const label = previewQualityBtn.querySelector('span') || previewQualityBtn;
    label.textContent = fullQuality ? 'Preview: Full' : 'Preview: Auto';
    const nextAction = fullQuality
      ? 'Switch preview quality back to adaptive mode'
      : 'Switch preview quality to full resolution';
    previewQualityBtn.title = nextAction;
    previewQualityBtn.setAttribute('aria-label', nextAction);
  }

  const layoutToggleBtn = document.getElementById('layout-toggle-btn') as HTMLButtonElement | null;
  if (layoutToggleBtn) {
    const layoutMode = deps.getCurrentLayoutMode();
    layoutToggleBtn.classList.toggle('active', layoutMode === 'image-priority');
    layoutToggleBtn.setAttribute('aria-pressed', String(layoutMode === 'image-priority'));
    const label = layoutToggleBtn.querySelector('span') || layoutToggleBtn;
    label.textContent = layoutMode === 'image-priority' ? 'Layout: Image' : 'Layout: Controls';
    const layoutAction = layoutMode === 'image-priority'
      ? 'Switch to controls priority layout'
      : 'Switch to image priority layout';
    layoutToggleBtn.title = layoutAction;
    layoutToggleBtn.setAttribute('aria-label', layoutAction);
  }

  const holdCompareBtn = document.getElementById('hold-compare-btn') as HTMLButtonElement | null;
  if (holdCompareBtn) {
    holdCompareBtn.classList.toggle('active', state.ui.holdCompareActive);
    holdCompareBtn.setAttribute('aria-pressed', String(state.ui.holdCompareActive));
    holdCompareBtn.disabled = !state.imageLoaded;
    holdCompareBtn.setAttribute(
      'aria-label',
      state.imageLoaded
        ? 'Hold to compare with the original image'
        : 'Load an image to enable hold compare',
    );
  }

  const wheelMiniVisibilityBtn = document.getElementById('wheel-mini-visibility-btn') as HTMLButtonElement | null;
  if (wheelMiniVisibilityBtn) {
    wheelMiniVisibilityBtn.style.display = imagePriorityMobile ? 'inline-flex' : 'none';
    wheelMiniVisibilityBtn.classList.toggle('active', deps.wheelMiniMode !== 'hidden');
    wheelMiniVisibilityBtn.setAttribute('aria-pressed', String(deps.wheelMiniMode !== 'hidden'));
    wheelMiniVisibilityBtn.textContent = deps.wheelMiniMode === 'inside'
      ? 'Mini: In/Out'
      : deps.wheelMiniMode === 'split'
        ? 'Mini: L/R'
        : 'Mini: Off';
    wheelMiniVisibilityBtn.title = deps.wheelMiniMode === 'inside'
      ? 'Minimized wheels use inside/outside mode'
      : deps.wheelMiniMode === 'split'
        ? 'Minimized wheels use left/right mode'
        : 'Minimized wheels are hidden outside the wheels module';
    wheelMiniVisibilityBtn.setAttribute('aria-label', wheelMiniVisibilityBtn.title);
  }

  const mappingPickerBtn = document.getElementById('add-mapping-picker-btn') as HTMLButtonElement | null;
  if (mappingPickerBtn) {
    const mappingPickerActive = state.ui.colorPickerActive && state.ui.activeLayer === 'mapping';
    mappingPickerBtn.classList.toggle('active', mappingPickerActive);
    mappingPickerBtn.setAttribute('aria-pressed', String(mappingPickerActive));
    mappingPickerBtn.disabled = !state.imageLoaded;
  }

  const workingSpaceSelect = document.getElementById('working-space-select') as HTMLSelectElement | null;
  if (workingSpaceSelect && document.activeElement !== workingSpaceSelect) {
    workingSpaceSelect.value = state.ui.workingColorSpace;
  }

  const gamutToggle = document.getElementById('gamut-compression-toggle') as HTMLButtonElement | null;
  if (gamutToggle) {
    gamutToggle.classList.toggle('active', state.ui.gamutCompressionEnabled);
    gamutToggle.setAttribute('aria-pressed', String(state.ui.gamutCompressionEnabled));
    gamutToggle.textContent = state.ui.gamutCompressionEnabled ? 'On' : 'Off';
    gamutToggle.setAttribute(
      'aria-label',
      state.ui.gamutCompressionEnabled ? 'Disable soft gamut compression' : 'Enable soft gamut compression',
    );
  }

  const iccReadout = document.getElementById('icc-profile-readout');
  if (iccReadout) {
    if (state.ui.importedIccProfileName) {
      const src = state.ui.importedIccSource ? ` (${state.ui.importedIccSource})` : '';
      iccReadout.textContent = `ICC: ${state.ui.importedIccProfileName}${src}`;
    } else {
      iccReadout.textContent = 'ICC: Not detected';
    }
  }

  updateSlider('picker-radius-slider', state.ui.colorPickerRadiusPx);
  const pickerCoordReadout = document.getElementById('picker-coord-readout');
  if (pickerCoordReadout) {
    if (state.ui.colorPickerCoord) {
      pickerCoordReadout.textContent = `Pixel: ${state.ui.colorPickerCoord.x}, ${state.ui.colorPickerCoord.y}`;
    } else {
      pickerCoordReadout.textContent = 'Pixel: -, -';
    }
  }

  updateSlider('red-hue-slider', state.calibration.red.hueShift);
  updateSlider('red-sat-slider', state.calibration.red.saturation);
  updateSlider('green-hue-slider', state.calibration.green.hueShift);
  updateSlider('green-sat-slider', state.calibration.green.saturation);
  updateSlider('blue-hue-slider', state.calibration.blue.hueShift);
  updateSlider('blue-sat-slider', state.calibration.blue.saturation);

  updateNumberInput('red-x-input', state.primaries.red[0]);
  updateNumberInput('red-y-input', state.primaries.red[1]);
  updateNumberInput('green-x-input', state.primaries.green[0]);
  updateNumberInput('green-y-input', state.primaries.green[1]);
  updateNumberInput('blue-x-input', state.primaries.blue[0]);
  updateNumberInput('blue-y-input', state.primaries.blue[1]);

  updateSlider('exposure-slider', state.toning.exposure);
  updateSlider('contrast-slider', state.toning.contrast);
  updateSlider('highlights-slider', state.toning.highlights);
  updateSlider('shadows-slider', state.toning.shadows);
  updateSlider('whites-slider', state.toning.whites);
  updateSlider('blacks-slider', state.toning.blacks);
  deps.updateToneCurveControlUI(state);

  updateMappingDetail(state);
  updateMappingList(state, {
    onSelectMapping: (id) => deps.onSelectMapping(id, state),
  });

  deps.applyPreviewControlsSplit(state);
  deps.updateSplitDividerUI(state);
}
