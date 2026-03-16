/**
 * Preset system - save/load color grading presets.
 * Type A: Color style (calibration + toning; primaries derived via calibrationToPrimaries)
 * Type B: Creative mapping (local mappings + global hue shift)
 *
 * Built-in presets are based on professional color grading techniques:
 *   - Warm Autumn: golden warmth inspired by analog Kodak Portra stock
 *   - Cool Blue: blue-shifted shadows common in thriller / sci-fi grading
 *   - Vintage Film: lifted blacks + desaturation evoking 1970s print stock
 *   - Cinematic Teal & Orange: complementary teal-orange split popular in blockbusters
 *   - Standard sRGB: neutral reference (Rec. 709 / sRGB primaries, no toning)
 *   - Portrait Soft: flattering skin-tone rendering with gentle contrast rolloff
 */
import {
  DEFAULT_CALIBRATION,
  DEFAULT_TONING,
  calibrationToPrimaries,
} from '../state/types';
import type {
  AppState,
  PrimariesState,
  CalibrationChannel,
  CalibrationState,
  ToningState,
  LocalMapping,
} from '../state/types';

// ---------------------------------------------------------------------------
// Preset interfaces
// ---------------------------------------------------------------------------

export interface ColorStylePreset {
  version: string;
  type: 'color_style';
  name: string;
  calibration: CalibrationState;
  toning: ToningState;
  createdAt: string;
}

export interface CreativeMappingPreset {
  version: string;
  type: 'creative_mapping';
  name: string;
  localMappings: LocalMapping[];
  globalHueShift: number;
  baseCalibration: CalibrationState; // For compatibility check
  createdAt: string;
}

export type Preset = ColorStylePreset | CreativeMappingPreset;

const PRESET_SCHEMA_VERSION = '2.0';

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const PRESETS_KEY = 'color-toy-presets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeCreatedAt(value: unknown): string {
  if (typeof value !== 'string') {
    return new Date().toISOString();
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? new Date().toISOString() : new Date(timestamp).toISOString();
}

function normalizeCalibrationChannel(value: unknown): CalibrationChannel {
  const record = isRecord(value) ? value : {};
  return {
    hueShift: clampNumber(record.hueShift, -180, 180, 0),
    saturation: clampNumber(record.saturation, -100, 100, 0),
  };
}

function normalizeCalibration(value: unknown): CalibrationState {
  const record = isRecord(value) ? value : {};
  return {
    red: normalizeCalibrationChannel(record.red),
    green: normalizeCalibrationChannel(record.green),
    blue: normalizeCalibrationChannel(record.blue),
  };
}

function normalizeToning(value: unknown): ToningState {
  const record = isRecord(value) ? value : {};
  return {
    exposure: clampNumber(record.exposure, -2, 2, DEFAULT_TONING.exposure),
    contrast: clampNumber(record.contrast, 0.5, 2.0, DEFAULT_TONING.contrast),
    highlights: clampNumber(record.highlights, -1, 1, DEFAULT_TONING.highlights),
    shadows: clampNumber(record.shadows, -1, 1, DEFAULT_TONING.shadows),
    whites: clampNumber(record.whites, -1, 1, DEFAULT_TONING.whites),
    blacks: clampNumber(record.blacks, -1, 1, DEFAULT_TONING.blacks),
  };
}

function normalizeLocalMapping(value: unknown, index: number): LocalMapping | null {
  const record = isRecord(value) ? value : null;
  if (!record) {
    return null;
  }

  const srcHue = clampNumber(record.srcHue, 0, 1, NaN);
  const dstHue = clampNumber(record.dstHue, 0, 1, NaN);
  if (Number.isNaN(srcHue) || Number.isNaN(dstHue)) {
    return null;
  }

  return {
    id: normalizeName(record.id, `mapping-${index + 1}`),
    srcHue,
    dstHue,
    range: clampNumber(record.range, 0, 0.5, 0.08),
    strength: clampNumber(record.strength, 0, 1, 1),
  };
}

function normalizeVersion(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '1.0';
}

function normalizePreset(value: unknown): Preset | null {
  const record = isRecord(value) ? value : null;
  if (!record) {
    return null;
  }

  const type = record.type;
  const name = normalizeName(record.name, 'Imported Preset');
  const createdAt = normalizeCreatedAt(record.createdAt);
  const version = normalizeVersion(record.version);

  if (type === 'color_style') {
    return {
      version: PRESET_SCHEMA_VERSION,
      type,
      name,
      calibration: normalizeCalibration(record.calibration),
      toning: normalizeToning(record.toning),
      createdAt: version === PRESET_SCHEMA_VERSION ? createdAt : new Date(createdAt).toISOString(),
    };
  }

  if (type === 'creative_mapping') {
    const mappings = Array.isArray(record.localMappings)
      ? record.localMappings
          .map((mapping, index) => normalizeLocalMapping(mapping, index))
          .filter((mapping): mapping is LocalMapping => mapping !== null)
      : [];

    return {
      version: PRESET_SCHEMA_VERSION,
      type,
      name,
      localMappings: mappings,
      globalHueShift: clampNumber(record.globalHueShift, -1, 1, 0),
      baseCalibration: normalizeCalibration(record.baseCalibration),
      createdAt,
    };
  }

  return null;
}

export function getStoredPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((preset) => normalizePreset(preset))
      .filter((preset): preset is Preset => preset !== null);
  } catch {
    return [];
  }
}

export function savePreset(preset: Preset): void {
  const presets = getStoredPresets();
  const normalizedPreset = normalizePreset(preset);
  if (!normalizedPreset) {
    return;
  }
  presets.push(normalizedPreset);
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

export function deletePreset(index: number): void {
  const presets = getStoredPresets();
  presets.splice(index, 1);
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

// ---------------------------------------------------------------------------
// Preset creation
// ---------------------------------------------------------------------------

export function createColorStylePreset(name: string, state: AppState): ColorStylePreset {
  return {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: normalizeName(name, 'Color Style'),
    calibration: {
      red: { ...state.calibration.red },
      green: { ...state.calibration.green },
      blue: { ...state.calibration.blue },
    },
    toning: { ...state.toning },
    createdAt: new Date().toISOString(),
  };
}

export function createCreativeMappingPreset(name: string, state: AppState): CreativeMappingPreset {
  return {
    version: PRESET_SCHEMA_VERSION,
    type: 'creative_mapping',
    name: normalizeName(name, 'Creative Mapping'),
    localMappings: state.localMappings.map(m => ({ ...m })),
    globalHueShift: state.globalHueShift,
    baseCalibration: {
      red: { ...state.calibration.red },
      green: { ...state.calibration.green },
      blue: { ...state.calibration.blue },
    },
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Preset application
// ---------------------------------------------------------------------------

export function applyPreset(preset: Preset, currentState: AppState): Partial<AppState> {
  if (preset.type === 'color_style') {
    const calibration: CalibrationState = {
      red: { ...preset.calibration.red },
      green: { ...preset.calibration.green },
      blue: { ...preset.calibration.blue },
    };
    const primaries: PrimariesState = calibrationToPrimaries(calibration);
    return {
      calibration,
      primaries,
      toning: { ...preset.toning },
    };
  } else {
    // Creative mapping preset - check calibration compatibility
    const cc = currentState.calibration;
    const bc = preset.baseCalibration;
    const diff =
      Math.abs(cc.red.hueShift - bc.red.hueShift) +
      Math.abs(cc.red.saturation - bc.red.saturation) +
      Math.abs(cc.green.hueShift - bc.green.hueShift) +
      Math.abs(cc.green.saturation - bc.green.saturation) +
      Math.abs(cc.blue.hueShift - bc.blue.hueShift) +
      Math.abs(cc.blue.saturation - bc.blue.saturation);

    if (diff > 30) { // significant calibration difference
      console.warn('Calibration mismatch detected, creative mapping effect may differ');
    }

    return {
      localMappings: preset.localMappings.map(m => ({ ...m })),
      globalHueShift: preset.globalHueShift,
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in presets 鈥?based on professional color grading research
// ---------------------------------------------------------------------------

export const BUILTIN_PRESETS: ColorStylePreset[] = [
  // ---- Warm Autumn --------------------------------------------------------
  // Inspired by warm analog film stocks (Kodak Portra / Ektachrome push).
  // Reds are pushed warmer with extra saturation for rich autumn foliage,
  // greens are shifted toward yellow/olive (-15 hue, -10 sat),
  // blues are nudged teal with slight desaturation for atmospheric haze.
  // Toning adds gentle lift in exposure + contrast with warm highlight bias
  // and deeper shadows for dimension.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Warm Autumn',
    calibration: {
      red: { hueShift: -5, saturation: 15 },
      green: { hueShift: -15, saturation: -10 },
      blue: { hueShift: -8, saturation: -5 },
    },
    toning: {
      exposure: 0.15,
      contrast: 1.12,
      highlights: 0.08,
      shadows: -0.12,
      whites: -0.05,
      blacks: 0.05,
    },
    createdAt: '2024-01-01T00:00:00Z',
  },

  // ---- Cool Blue ----------------------------------------------------------
  // Cooler palette with blue-shifted shadows used in thriller / sci-fi grading.
  // Reds gain a slight magenta lean with reduced saturation,
  // greens push toward cyan (+5 hue, +5 sat) for cooler foliage,
  // blues are shifted teal with significantly boosted saturation (+20)
  // to create rich, deep blues.
  // Toning pulls exposure slightly down, lifts shadows for a hazy feel,
  // and crushes blacks gently for cinematic depth.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Cool Blue',
    calibration: {
      red: { hueShift: 3, saturation: -8 },
      green: { hueShift: 5, saturation: 5 },
      blue: { hueShift: -10, saturation: 20 },
    },
    toning: {
      exposure: -0.08,
      contrast: 1.08,
      highlights: -0.10,
      shadows: 0.15,
      whites: 0.05,
      blacks: -0.08,
    },
    createdAt: '2024-01-01T00:00:00Z',
  },

  // ---- Vintage Film -------------------------------------------------------
  // Emulates aged 1970s print stock: overall desaturation, lifted blacks,
  // reduced contrast, and warm shadow tones.
  // Reds are gently muted (-15 sat), greens shift olive with heavy
  // desaturation (-20 sat) for faded foliage, blues gain a slight purple
  // cast (+5 hue) with reduced saturation.
  // Toning uses sub-unity contrast (0.88) for a flat, faded look with
  // crushed highlights, heavily lifted shadows, and raised blacks.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Vintage Film',
    calibration: {
      red: { hueShift: -3, saturation: -15 },
      green: { hueShift: -10, saturation: -20 },
      blue: { hueShift: 5, saturation: -10 },
    },
    toning: {
      exposure: 0.05,
      contrast: 0.88,
      highlights: -0.18,
      shadows: 0.20,
      whites: -0.10,
      blacks: 0.15,
    },
    createdAt: '2024-01-01T00:00:00Z',
  },

  // ---- Cinematic Teal & Orange --------------------------------------------
  // The complementary teal-orange color scheme dominant in modern blockbusters
  // (Michael Bay, David Fincher, Ridley Scott).
  // Reds are pushed warmer/orange (-8 hue, +10 sat),
  // greens rotate strongly toward teal (+10 hue) with reduced saturation
  // so midtones lean teal rather than green,
  // blues shift teal (-15 hue) with boosted saturation for vivid shadows.
  // Toning adds punchier contrast (1.15) with subtly crushed shadows/blacks
  // for a dramatic, high-contrast cinematic feel.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Cinematic Teal & Orange',
    calibration: {
      red: { hueShift: -8, saturation: 10 },
      green: { hueShift: 10, saturation: -15 },
      blue: { hueShift: -15, saturation: 10 },
    },
    toning: {
      exposure: 0,
      contrast: 1.15,
      highlights: -0.05,
      shadows: -0.10,
      whites: -0.08,
      blacks: -0.05,
    },
    createdAt: '2024-01-01T00:00:00Z',
  },

  // ---- Standard sRGB ------------------------------------------------------
  // Neutral reference: sRGB / Rec. 709 primaries with no toning adjustments.
  // Useful as a baseline reset.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Standard sRGB',
    calibration: { ...DEFAULT_CALIBRATION },
    toning: { ...DEFAULT_TONING },
    createdAt: '2024-01-01T00:00:00Z',
  },

  // ---- Portrait Soft ------------------------------------------------------
  // Flattering skin-tone rendering with gentle highlight roll-off.
  // Reds are nudged slightly warm with minor desaturation for natural skin,
  // greens lose saturation to prevent colour-cast in ambient light,
  // blues warm up slightly (-5 hue) for softer background tones.
  // Toning lifts exposure gently, uses sub-unity contrast (0.95) for a
  // soft roll-off, raises highlights and shadows for an airy, open feel
  // with slightly lifted blacks to avoid harsh shadows.
  {
    version: PRESET_SCHEMA_VERSION,
    type: 'color_style',
    name: 'Portrait Soft',
    calibration: {
      red: { hueShift: -3, saturation: -5 },
      green: { hueShift: 0, saturation: -8 },
      blue: { hueShift: -5, saturation: -5 },
    },
    toning: {
      exposure: 0.10,
      contrast: 0.95,
      highlights: 0.12,
      shadows: 0.08,
      whites: 0.05,
      blacks: 0.03,
    },
    createdAt: '2024-01-01T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

export function exportPresetAsJSON(preset: Preset): string {
  return JSON.stringify(preset, null, 2);
}

export function importPresetFromJSON(json: string): Preset | null {
  try {
    const data = JSON.parse(json);
    return normalizePreset(data);
  } catch {
    return null;
  }
}
