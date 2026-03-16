/**
 * Application state types and initial values.
 * Central definition for the entire state tree.
 */

export type LayerType = 'calibration' | 'mapping' | 'toning';

export interface LocalMapping {
  id: string;
  srcHue: number;    // 0-1
  dstHue: number;    // 0-1
  range: number;     // 0-0.5 (angular)
  strength: number;  // 0-1
}

/** Camera Raw style calibration: hue offset + saturation multiplier per primary */
export interface CalibrationChannel {
  hueShift: number;    // -180 to +180 degrees
  saturation: number;  // -100 to +100 (percentage offset)
}

export interface CalibrationState {
  red: CalibrationChannel;
  green: CalibrationChannel;
  blue: CalibrationChannel;
}

export interface PrimariesState {
  red: [number, number];
  green: [number, number];
  blue: [number, number];
}

export interface ToningState {
  exposure: number;    // -2 to +2
  contrast: number;    // 0.5 to 2.0
  highlights: number;  // -1 to +1
  shadows: number;     // -1 to +1
  whites: number;      // -1 to +1
  blacks: number;      // -1 to +1
}

export interface UIState {
  activeLayer: LayerType;
  selectedMappingId: string | null;
  previewResolution: 1080 | 720 | 512;
  splitView: boolean;
  splitPosition: number;
  colorPickerActive: boolean;
  showXYPanel: boolean;
  toneCurveEnabled: boolean;
  toneCurveBypassPreview: boolean;
  holdCompareActive: boolean;
  holdCompareHintDismissed: boolean;
}

export interface AppState {
  calibration: CalibrationState;
  primaries: PrimariesState;
  localMappings: LocalMapping[];
  globalHueShift: number;
  toning: ToningState;
  ui: UIState;
  imageLoaded: boolean;
}

export const DEFAULT_CALIBRATION: CalibrationState = {
  red: { hueShift: 0, saturation: 0 },
  green: { hueShift: 0, saturation: 0 },
  blue: { hueShift: 0, saturation: 0 },
};

export const DEFAULT_PRIMARIES: PrimariesState = {
  red: [0.6400, 0.3300],
  green: [0.3000, 0.6000],
  blue: [0.1500, 0.0600],
};

export const DEFAULT_TONING: ToningState = {
  exposure: 0,
  contrast: 1.0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
};

export const SRGB_RED_XY: [number, number] = [0.6400, 0.3300];
export const SRGB_GREEN_XY: [number, number] = [0.3000, 0.6000];
export const SRGB_BLUE_XY: [number, number] = [0.1500, 0.0600];
export const D65_WHITE_XY: [number, number] = [0.3127, 0.3290];

/** Convert calibration (hue shift + saturation) to xy chromaticity coordinates */
export function calibrationToPrimaries(cal: CalibrationState): PrimariesState {
  const wx = D65_WHITE_XY[0], wy = D65_WHITE_XY[1];
  function shiftPrimary(baseXY: [number, number], ch: CalibrationChannel): [number, number] {
    const dx = baseXY[0] - wx, dy = baseXY[1] - wy;
    const baseAngle = Math.atan2(dy, dx);
    const baseDist = Math.sqrt(dx * dx + dy * dy);
    const newAngle = baseAngle + (ch.hueShift * Math.PI / 180);
    const satFactor = Math.max(0, 1 + ch.saturation / 100);
    const newDist = baseDist * satFactor;
    return [
      Math.max(0.01, Math.min(0.99, wx + Math.cos(newAngle) * newDist)),
      Math.max(0.01, Math.min(0.99, wy + Math.sin(newAngle) * newDist)),
    ];
  }
  return {
    red: shiftPrimary(SRGB_RED_XY, cal.red),
    green: shiftPrimary(SRGB_GREEN_XY, cal.green),
    blue: shiftPrimary(SRGB_BLUE_XY, cal.blue),
  };
}

/** Convert xy primaries back to calibration parameters */
export function primariesToCalibration(primaries: PrimariesState): CalibrationState {
  const wx = D65_WHITE_XY[0], wy = D65_WHITE_XY[1];
  function calcChannel(baseXY: [number, number], curXY: [number, number]): CalibrationChannel {
    const bdx = baseXY[0] - wx, bdy = baseXY[1] - wy;
    const cdx = curXY[0] - wx, cdy = curXY[1] - wy;
    const baseAngle = Math.atan2(bdy, bdx);
    const baseDist = Math.sqrt(bdx * bdx + bdy * bdy);
    const curAngle = Math.atan2(cdy, cdx);
    const curDist = Math.sqrt(cdx * cdx + cdy * cdy);
    let angleDiff = (curAngle - baseAngle) * 180 / Math.PI;
    while (angleDiff > 180) angleDiff -= 360;
    while (angleDiff < -180) angleDiff += 360;
    const saturation = baseDist > 0.001 ? ((curDist / baseDist) - 1) * 100 : 0;
    return {
      hueShift: Math.round(angleDiff * 10) / 10,
      saturation: Math.round(Math.max(-100, Math.min(100, saturation)) * 10) / 10,
    };
  }
  return {
    red: calcChannel(SRGB_RED_XY, primaries.red),
    green: calcChannel(SRGB_GREEN_XY, primaries.green),
    blue: calcChannel(SRGB_BLUE_XY, primaries.blue),
  };
}

export function createInitialState(): AppState {
  return {
    calibration: { ...DEFAULT_CALIBRATION },
    primaries: { ...DEFAULT_PRIMARIES },
    localMappings: [],
    globalHueShift: 0,
    toning: { ...DEFAULT_TONING },
    ui: {
      activeLayer: 'calibration',
      selectedMappingId: null,
      previewResolution: 1080,
      splitView: false,
      splitPosition: 0.5,
      colorPickerActive: false,
      showXYPanel: false,
      toneCurveEnabled: true,
      toneCurveBypassPreview: false,
      holdCompareActive: false,
      holdCompareHintDismissed: false,
    },
    imageLoaded: false,
  };
}
