import type { AppState } from '../../state/types';
import {
  updateMappingDetail,
  updateMappingList,
  updateNumberInput,
  updateSlider,
} from './panelControls';

export type MobileModule = 'none' | 'calibration' | 'mapping' | 'toning' | 'history' | 'presets';

interface PanelStateDeps {
  isImagePriorityMobileMode: () => boolean;
  getCurrentLayoutMode: () => 'image-priority' | 'controls-priority';
  mobileModuleSelection: MobileModule;
  onSelectMapping: (id: string, state: AppState) => void;
  applyPreviewControlsSplit: (state: AppState) => void;
  updateSplitDividerUI: (state: AppState) => void;
  updateToneCurveControlUI: (state: AppState) => void;
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
  const capabilities = document.getElementById('capabilities');

  const wheelsAvailableByLayer = state.ui.activeLayer !== 'toning';
  const calibrationActive = state.ui.activeLayer === 'calibration';

  if (wheelsPanel) wheelsPanel.style.display = wheelsAvailableByLayer ? 'block' : 'none';
  if (calibrationPanel) calibrationPanel.style.display = calibrationActive ? 'block' : 'none';
  if (xyPanel) xyPanel.style.display = calibrationActive ? 'block' : 'none';
  if (mappingPanel) mappingPanel.style.display = state.ui.activeLayer === 'mapping' ? 'block' : 'none';
  if (toningPanel) toningPanel.style.display = state.ui.activeLayer === 'toning' ? 'block' : 'none';

  if (wheelsRow) {
    const wheelsCollapsed = wheelsPanel?.classList.contains('is-collapsed') ?? false;
    wheelsRow.style.display = wheelsAvailableByLayer && !wheelsCollapsed ? 'flex' : 'none';
  }

  const imagePriorityMobile = deps.isImagePriorityMobileMode();
  const stickyContext = imagePriorityMobile && deps.mobileModuleSelection !== 'none';
  const wheelRowPinned = stickyContext && state.ui.wheelPinned;
  if (mobileBar) {
    mobileBar.classList.toggle('active', imagePriorityMobile);
  }

  if (controls) {
    controls.classList.toggle('image-priority-mode', imagePriorityMobile);
    controls.classList.toggle('module-open', stickyContext);
    controls.classList.toggle('wheel-sticky-context', stickyContext);
    controls.classList.toggle('wheel-pinned', wheelRowPinned);
    controls.style.setProperty('--wheel-controls-sticky-offset', '0px');
  }

  if (imagePriorityMobile) {
    if (historyPanel) {
      historyPanel.style.display = deps.mobileModuleSelection === 'history' ? 'block' : 'none';
    }

    const layerSelection = deps.mobileModuleSelection === 'calibration'
      || deps.mobileModuleSelection === 'mapping'
      || deps.mobileModuleSelection === 'toning';
    const presetsSelection = deps.mobileModuleSelection === 'presets';
    if (panels) {
      panels.style.display = layerSelection ? 'block' : 'none';
    }

    if (bottomBar) {
      bottomBar.style.display = presetsSelection ? 'block' : 'none';
    }
    if (presetSection) {
      presetSection.style.display = presetsSelection ? 'flex' : 'none';
    }
    if (capabilities) {
      capabilities.style.display = presetsSelection ? 'block' : 'none';
    }

    if (wheelsPanel) {
      const wheelsSelection = deps.mobileModuleSelection === 'calibration' || deps.mobileModuleSelection === 'mapping';
      wheelsPanel.style.display = wheelsSelection ? 'block' : 'none';
    }
    if (calibrationPanel) calibrationPanel.style.display = deps.mobileModuleSelection === 'calibration' ? 'block' : 'none';
    if (xyPanel) xyPanel.style.display = deps.mobileModuleSelection === 'calibration' ? 'block' : 'none';
    if (mappingPanel) mappingPanel.style.display = deps.mobileModuleSelection === 'mapping' ? 'block' : 'none';
    if (toningPanel) toningPanel.style.display = deps.mobileModuleSelection === 'toning' ? 'block' : 'none';

    if (wheelsRow) {
      const shouldShowWheels = deps.mobileModuleSelection === 'calibration' || deps.mobileModuleSelection === 'mapping';
      const wheelsCollapsed = wheelsPanel?.classList.contains('is-collapsed') ?? false;
      wheelsRow.style.display = shouldShowWheels && !wheelsCollapsed ? 'flex' : 'none';
    }
  } else {
    if (wheelsPanel) wheelsPanel.style.display = wheelsAvailableByLayer ? 'block' : 'none';
    if (historyPanel) historyPanel.style.display = 'block';
    if (panels) panels.style.display = 'block';
    if (bottomBar) bottomBar.style.display = 'block';
    if (presetSection) presetSection.style.display = 'flex';
    if (capabilities) capabilities.style.display = 'block';
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
  }

  const layoutToggleBtn = document.getElementById('layout-toggle-btn') as HTMLButtonElement | null;
  if (layoutToggleBtn) {
    const layoutMode = deps.getCurrentLayoutMode();
    layoutToggleBtn.classList.toggle('active', layoutMode === 'image-priority');
    layoutToggleBtn.setAttribute('aria-pressed', String(layoutMode === 'image-priority'));
    const label = layoutToggleBtn.querySelector('span') || layoutToggleBtn;
    label.textContent = layoutMode === 'image-priority' ? 'Layout: Image' : 'Layout: Controls';
  }

  const holdCompareBtn = document.getElementById('hold-compare-btn') as HTMLButtonElement | null;
  if (holdCompareBtn) {
    holdCompareBtn.classList.toggle('active', state.ui.holdCompareActive);
    holdCompareBtn.setAttribute('aria-pressed', String(state.ui.holdCompareActive));
    holdCompareBtn.disabled = !state.imageLoaded;
  }

  const wheelPinBtn = document.getElementById('wheel-pin-btn') as HTMLButtonElement | null;
  if (wheelPinBtn) {
    wheelPinBtn.style.display = stickyContext ? 'inline-flex' : 'none';
    wheelPinBtn.classList.toggle('active', wheelRowPinned);
    wheelPinBtn.setAttribute('aria-pressed', String(wheelRowPinned));
    wheelPinBtn.textContent = wheelRowPinned ? 'Pin: On' : 'Pin: Off';
    wheelPinBtn.disabled = !stickyContext;
    wheelPinBtn.title = stickyContext
      ? 'Pin wheel area while scrolling'
      : 'Pin is available in image-priority mode with an opened module';
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
    gamutToggle.textContent = state.ui.gamutCompressionEnabled ? 'On' : 'Off';
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
  updateSlider('global-hue-slider', state.globalHueShift);
  deps.updateToneCurveControlUI(state);

  updateMappingDetail(state);
  updateMappingList(state, {
    onSelectMapping: (id) => deps.onSelectMapping(id, state),
  });

  deps.applyPreviewControlsSplit(state);
  deps.updateSplitDividerUI(state);
}
