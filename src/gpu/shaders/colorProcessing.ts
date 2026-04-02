// Vertex shader - shared fullscreen quad
export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

// Main color processing fragment shader
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_image;
uniform sampler2D u_toneCurveTex;
uniform mat3 u_primaryMatrix;   // Combined calibration matrix
uniform float u_globalHueShift; // 0-1
uniform int u_numMappings;
uniform vec4 u_mappings[8];     // [srcHue, dstHue, range, strength]
uniform float u_exposure;       // -2 to +2
uniform float u_contrast;       // 0.5 to 2.0
uniform float u_highlights;     // -1 to +1
uniform float u_shadows;        // -1 to +1
uniform float u_whites;         // -1 to +1
uniform float u_blacks;         // -1 to +1
uniform float u_splitPosition;  // 0-1, position of split view divider
uniform int u_splitView;        // 0 or 1
uniform int u_enableProcessing; // 1 = process, 0 = passthrough
uniform int u_useToneCurve;     // 1 = apply tone curve LUT
uniform int u_workingColorSpace; // 0 = linear sRGB, 1 = ACEScg
uniform int u_gamutCompression;  // 1 = enable compression
uniform int u_inputIsLinear;     // 1 = source texture is already linear

// sRGB <-> Linear (IEC 61966-2-1)
float srgb_to_linear(float c) {
  return (c <= 0.04045) ? (c / 12.92) : pow((c + 0.055) / 1.055, 2.4);
}

float linear_to_srgb(float c) {
  c = clamp(c, 0.0, 1.0);
  return (c <= 0.0031308) ? (c * 12.92) : (1.055 * pow(c, 1.0 / 2.4) - 0.055);
}

vec3 srgb_to_linear_v(vec3 c) {
  return vec3(srgb_to_linear(c.r), srgb_to_linear(c.g), srgb_to_linear(c.b));
}

vec3 linear_to_srgb_v(vec3 c) {
  return vec3(linear_to_srgb(c.r), linear_to_srgb(c.g), linear_to_srgb(c.b));
}

vec3 linear_srgb_to_acescg(vec3 c) {
  mat3 M = mat3(
    0.61313242, 0.33953802, 0.04741670,
    0.07012438, 0.91639401, 0.01345152,
    0.02058766, 0.10957457, 0.86978540
  );
  return M * c;
}

vec3 acescg_to_linear_srgb(vec3 c) {
  mat3 M = mat3(
    1.70485868, -0.62171602, -0.08329937,
    -0.13007682, 1.14073577, -0.01055980,
    -0.02396407, -0.12897551, 1.15301402
  );
  return M * c;
}

vec3 compress_to_unit_gamut(vec3 rgb) {
  float maxC = max(rgb.r, max(rgb.g, rgb.b));
  float minC = min(rgb.r, min(rgb.g, rgb.b));
  if (maxC <= 1.0 && minC >= 0.0) {
    return rgb;
  }

  float neutral = clamp(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  vec3 diff = rgb - vec3(neutral);
  float scale = 1.0;

  for (int ch = 0; ch < 3; ch++) {
    float channel = ch == 0 ? rgb.r : (ch == 1 ? rgb.g : rgb.b);
    float delta = ch == 0 ? diff.r : (ch == 1 ? diff.g : diff.b);
    if (channel > 1.0 && delta > 0.000001) {
      scale = min(scale, (1.0 - neutral) / delta);
    }
    if (channel < 0.0 && delta < -0.000001) {
      scale = min(scale, neutral / -delta);
    }
  }

  float overshoot = max(maxC - 1.0, max(-minC, 0.0));
  float softness = clamp(0.14 + overshoot * 0.35, 0.14, 0.4);
  scale = clamp(scale, 0.0, 1.0);
  float softenedScale = scale - softness * scale * (1.0 - scale);
  return clamp(vec3(neutral) + diff * softenedScale, 0.0, 1.0);
}

vec3 maybe_compress_to_unit_gamut(vec3 rgb) {
  return u_gamutCompression == 1 ? compress_to_unit_gamut(rgb) : rgb;
}

// RGB <-> HSV
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Gaussian weight for hue mapping
float calcWeight(float hue, float srcHue, float range) {
  float dist = abs(hue - srcHue);
  dist = min(dist, 1.0 - dist); // Hue wrapping
  float sigma = max(range, 0.001);
  return exp(-(dist * dist) / (2.0 * sigma * sigma));
}

// Calculate total hue shift from all mapping points
float calculateLocalShift(float hue) {
  float totalShift = 0.0;
  float totalWeight = 0.0;

  // Unrolled loop for 8 control points
  for (int i = 0; i < 8; i++) {
    if (i >= u_numMappings) break;
    vec4 mapping = u_mappings[i];
    float w = calcWeight(hue, mapping.x, mapping.z) * mapping.w;
    float shift = mapping.y - mapping.x;
    // Shortest path on hue circle
    if (shift > 0.5) shift -= 1.0;
    if (shift < -0.5) shift += 1.0;
    totalShift += shift * w;
    totalWeight += w;
  }

  return totalWeight > 0.001 ? totalShift : 0.0;
}

// Toning adjustments (sRGB space for v1.2)
vec3 applyToning(vec3 rgb) {
  // Exposure (linear multiplier applied in linear space conceptually, simplified here)
  rgb *= pow(2.0, u_exposure);

  // Contrast (pivot at 0.5)
  rgb = (rgb - 0.5) * u_contrast + 0.5;

  // Highlights/shadows (luminance-based)
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));

  // Highlights start earlier and respond a bit stronger.
  float highMask = smoothstep(0.35, 0.95, lum);
  rgb += u_highlights * highMask * 0.65;

  // Shadows are restricted to deeper darks to avoid affecting most of the image.
  float shadowMask = 1.0 - smoothstep(0.0, 0.35, lum);
  rgb += u_shadows * shadowMask * 0.4;

  // Whites (top end)
  float whiteMask = smoothstep(0.75, 1.0, lum);
  rgb += u_whites * whiteMask * 0.3;

  // Blacks (bottom end)
  float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
  rgb += u_blacks * blackMask * 0.3;

  return clamp(rgb, 0.0, 1.0);
}

vec3 applyToneCurve(vec3 rgb) {
  if (u_useToneCurve == 0) return rgb;
  float r = texture(u_toneCurveTex, vec2(clamp(rgb.r, 0.0, 1.0), 0.5)).r;
  float g = texture(u_toneCurveTex, vec2(clamp(rgb.g, 0.0, 1.0), 0.5)).r;
  float b = texture(u_toneCurveTex, vec2(clamp(rgb.b, 0.0, 1.0), 0.5)).r;
  return vec3(r, g, b);
}

void main() {
  vec4 texColor = texture(u_image, v_texCoord);
  vec3 inputLinearRGB = u_inputIsLinear == 1 ? texColor.rgb : srgb_to_linear_v(texColor.rgb);
  vec3 passthroughRGB = u_inputIsLinear == 1 ? linear_to_srgb_v(inputLinearRGB) : texColor.rgb;

  // Split view: left side original
  if (u_splitView == 1 && v_texCoord.x < u_splitPosition) {
    fragColor = vec4(clamp(passthroughRGB, 0.0, 1.0), texColor.a);
    return;
  }

  if (u_enableProcessing == 0) {
    fragColor = vec4(clamp(passthroughRGB, 0.0, 1.0), texColor.a);
    return;
  }

  // Step 1: input -> Linear
  vec3 linearRGB = inputLinearRGB;
  vec3 workingRGB = u_workingColorSpace == 1
    ? linear_srgb_to_acescg(linearRGB)
    : linearRGB;

  // Step 2: Primary calibration (linear RGB -> calibrated linear RGB via XYZ)
  // Uses smooth gamut mapping instead of hard clamp to avoid white/black edges.
  // Preserves hue by desaturating toward the neutral axis when out-of-gamut.
  vec3 calibratedRGB = maybe_compress_to_unit_gamut(u_primaryMatrix * workingRGB);

  // Step 3: HSV local mapping
  vec3 hsv = rgb2hsv(calibratedRGB);
  float hueShift = calculateLocalShift(hsv.x);
  hsv.x = fract(hsv.x + hueShift + u_globalHueShift);
  vec3 mappedRGB = hsv2rgb(hsv);

  // Step 4: Toning (sRGB space for v1.2)
  vec3 tonedRGB = maybe_compress_to_unit_gamut(applyToning(mappedRGB));

  vec3 outputLinearRGB = u_workingColorSpace == 1
    ? acescg_to_linear_srgb(tonedRGB)
    : tonedRGB;
  outputLinearRGB = maybe_compress_to_unit_gamut(outputLinearRGB);

  // Step 5: Linear -> sRGB output
  vec3 outputRGB = linear_to_srgb_v(outputLinearRGB);
  outputRGB = applyToneCurve(outputRGB);

  fragColor = vec4(clamp(outputRGB, 0.0, 1.0), texColor.a);
}
`;

// WebGL 1.0 fallback shaders
export const VERTEX_SHADER_V1 = `
precision highp float;

attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

export const FRAGMENT_SHADER_V1 = `
precision highp float;

varying vec2 v_texCoord;

uniform sampler2D u_image;
uniform sampler2D u_toneCurveTex;
uniform mat3 u_primaryMatrix;
uniform float u_globalHueShift;
uniform int u_numMappings;
uniform vec4 u_mappings[4]; // Limited to 4 in WebGL 1.0
uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_splitPosition;
uniform int u_splitView;
uniform int u_enableProcessing;
uniform int u_useToneCurve;
uniform int u_workingColorSpace;
uniform int u_gamutCompression;
uniform int u_inputIsLinear;

float srgb_to_linear(float c) {
  return (c <= 0.04045) ? (c / 12.92) : pow((c + 0.055) / 1.055, 2.4);
}

float linear_to_srgb(float c) {
  c = clamp(c, 0.0, 1.0);
  return (c <= 0.0031308) ? (c * 12.92) : (1.055 * pow(c, 1.0 / 2.4) - 0.055);
}

vec3 srgb_to_linear_v(vec3 c) {
  return vec3(srgb_to_linear(c.r), srgb_to_linear(c.g), srgb_to_linear(c.b));
}

vec3 linear_to_srgb_v(vec3 c) {
  return vec3(linear_to_srgb(c.r), linear_to_srgb(c.g), linear_to_srgb(c.b));
}

vec3 linear_srgb_to_acescg(vec3 c) {
  mat3 M = mat3(
    0.61313242, 0.33953802, 0.04741670,
    0.07012438, 0.91639401, 0.01345152,
    0.02058766, 0.10957457, 0.86978540
  );
  return M * c;
}

vec3 acescg_to_linear_srgb(vec3 c) {
  mat3 M = mat3(
    1.70485868, -0.62171602, -0.08329937,
    -0.13007682, 1.14073577, -0.01055980,
    -0.02396407, -0.12897551, 1.15301402
  );
  return M * c;
}

vec3 compress_to_unit_gamut(vec3 rgb) {
  float maxC = max(rgb.r, max(rgb.g, rgb.b));
  float minC = min(rgb.r, min(rgb.g, rgb.b));
  if (maxC <= 1.0 && minC >= 0.0) {
    return rgb;
  }

  float neutral = clamp(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  vec3 diff = rgb - vec3(neutral);
  float scale = 1.0;
  for (int ch = 0; ch < 3; ch++) {
    float channel = ch == 0 ? rgb.r : (ch == 1 ? rgb.g : rgb.b);
    float delta = ch == 0 ? diff.r : (ch == 1 ? diff.g : diff.b);
    if (channel > 1.0 && delta > 0.000001) {
      scale = min(scale, (1.0 - neutral) / delta);
    }
    if (channel < 0.0 && delta < -0.000001) {
      scale = min(scale, neutral / -delta);
    }
  }
  float overshoot = max(maxC - 1.0, max(-minC, 0.0));
  float softness = clamp(0.14 + overshoot * 0.35, 0.14, 0.4);
  scale = clamp(scale, 0.0, 1.0);
  float softenedScale = scale - softness * scale * (1.0 - scale);
  return clamp(vec3(neutral) + diff * softenedScale, 0.0, 1.0);
}

vec3 maybe_compress_to_unit_gamut(vec3 rgb) {
  return u_gamutCompression == 1 ? compress_to_unit_gamut(rgb) : rgb;
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float calcWeight(float hue, float srcHue, float range) {
  float dist = abs(hue - srcHue);
  dist = min(dist, 1.0 - dist);
  float sigma = max(range, 0.001);
  return exp(-(dist * dist) / (2.0 * sigma * sigma));
}

float calculateLocalShift(float hue) {
  float totalShift = 0.0;
  float totalWeight = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= u_numMappings) break;
    vec4 mapping = u_mappings[i];
    float w = calcWeight(hue, mapping.x, mapping.z) * mapping.w;
    float shift = mapping.y - mapping.x;
    if (shift > 0.5) shift -= 1.0;
    if (shift < -0.5) shift += 1.0;
    totalShift += shift * w;
    totalWeight += w;
  }
  return totalWeight > 0.001 ? totalShift : 0.0;
}

vec3 applyToning(vec3 rgb) {
  rgb *= pow(2.0, u_exposure);
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float highMask = smoothstep(0.35, 0.95, lum);
  rgb += u_highlights * highMask * 0.65;
  float shadowMask = 1.0 - smoothstep(0.0, 0.35, lum);
  rgb += u_shadows * shadowMask * 0.4;
  float whiteMask = smoothstep(0.75, 1.0, lum);
  rgb += u_whites * whiteMask * 0.3;
  float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
  rgb += u_blacks * blackMask * 0.3;
  return clamp(rgb, 0.0, 1.0);
}

vec3 applyToneCurve(vec3 rgb) {
  if (u_useToneCurve == 0) return rgb;
  float r = texture2D(u_toneCurveTex, vec2(clamp(rgb.r, 0.0, 1.0), 0.5)).r;
  float g = texture2D(u_toneCurveTex, vec2(clamp(rgb.g, 0.0, 1.0), 0.5)).r;
  float b = texture2D(u_toneCurveTex, vec2(clamp(rgb.b, 0.0, 1.0), 0.5)).r;
  return vec3(r, g, b);
}

void main() {
  vec4 texColor = texture2D(u_image, v_texCoord);
  vec3 inputLinearRGB = u_inputIsLinear == 1 ? texColor.rgb : srgb_to_linear_v(texColor.rgb);
  vec3 passthroughRGB = u_inputIsLinear == 1 ? linear_to_srgb_v(inputLinearRGB) : texColor.rgb;
  if (u_splitView == 1 && v_texCoord.x < u_splitPosition) {
    gl_FragColor = vec4(clamp(passthroughRGB, 0.0, 1.0), texColor.a);
    return;
  }
  if (u_enableProcessing == 0) {
    gl_FragColor = vec4(clamp(passthroughRGB, 0.0, 1.0), texColor.a);
    return;
  }
  vec3 linearRGB = inputLinearRGB;
  vec3 workingRGB = u_workingColorSpace == 1
    ? linear_srgb_to_acescg(linearRGB)
    : linearRGB;
  vec3 calibratedRGB = maybe_compress_to_unit_gamut(u_primaryMatrix * workingRGB);
  vec3 hsv = rgb2hsv(calibratedRGB);
  float hueShift = calculateLocalShift(hsv.x);
  hsv.x = fract(hsv.x + hueShift + u_globalHueShift);
  vec3 mappedRGB = hsv2rgb(hsv);
  vec3 tonedRGB = maybe_compress_to_unit_gamut(applyToning(mappedRGB));
  vec3 outputLinearRGB = u_workingColorSpace == 1
    ? acescg_to_linear_srgb(tonedRGB)
    : tonedRGB;
  outputLinearRGB = maybe_compress_to_unit_gamut(outputLinearRGB);
  vec3 outputRGB = linear_to_srgb_v(outputLinearRGB);
  outputRGB = applyToneCurve(outputRGB);
  gl_FragColor = vec4(clamp(outputRGB, 0.0, 1.0), texColor.a);
}
`;
