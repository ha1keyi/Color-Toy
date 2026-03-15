/**
 * Core color space conversion functions.
 * Pure functions, zero dependencies. All operate on normalized [0,1] ranges.
 */

// sRGB <-> Linear RGB (IEC 61966-2-1 exact)
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

export function srgbToLinearVec3(rgb: [number, number, number]): [number, number, number] {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

export function linearToSrgbVec3(rgb: [number, number, number]): [number, number, number] {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}

// RGB <-> HSV (all in [0,1])
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (d !== 0) {
    if (max === r) {
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
      h = ((b - r) / d + 2) / 6;
    } else {
      h = ((r - g) / d + 4) / 6;
    }
  }

  return [h, s, v];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    case 5: return [v, p, q];
    default: return [0, 0, 0];
  }
}

// Clamp utility
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clampVec3(v: [number, number, number]): [number, number, number] {
  return [clamp(v[0], 0, 1), clamp(v[1], 0, 1), clamp(v[2], 0, 1)];
}

/**
 * Compress linear RGB into display gamut by pulling chroma toward the neutral axis.
 * This preserves white and avoids the harsh white/black clipping boundaries that
 * appear when channels are simply clamped.
 */
export function compressLinearGamutVec3(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  if (maxC <= 1 && minC >= 0) {
    return rgb;
  }

  const neutral = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
  const dr = r - neutral;
  const dg = g - neutral;
  const db = b - neutral;

  let scale = 1;
  for (const [channel, delta] of [[r, dr], [g, dg], [b, db]] as const) {
    if (channel > 1 && delta > 1e-6) {
      scale = Math.min(scale, (1 - neutral) / delta);
    }
    if (channel < 0 && delta < -1e-6) {
      scale = Math.min(scale, neutral / -delta);
    }
  }

  // Apply a soft shoulder near gamut boundaries to avoid hard white/black rims.
  const overshoot = Math.max(maxC - 1, -minC, 0);
  const softness = clamp(0.14 + overshoot * 0.35, 0.14, 0.4);
  scale = clamp(scale, 0, 1);
  const softenedScale = scale - softness * scale * (1 - scale);

  return clampVec3([
    neutral + dr * softenedScale,
    neutral + dg * softenedScale,
    neutral + db * softenedScale,
  ]);
}
