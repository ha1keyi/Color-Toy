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

  // Highlights affect bright areas
  float highMask = smoothstep(0.5, 1.0, lum);
  rgb += u_highlights * highMask * 0.5;

  // Shadows affect dark areas
  float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
  rgb += u_shadows * shadowMask * 0.5;

  // Whites (top end)
  float whiteMask = smoothstep(0.75, 1.0, lum);
  rgb += u_whites * whiteMask * 0.3;

  // Blacks (bottom end)
  float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
  rgb += u_blacks * blackMask * 0.3;

  return clamp(rgb, 0.0, 1.0);
}

void main() {
  vec4 texColor = texture(u_image, v_texCoord);

  // Split view: left side original
  if (u_splitView == 1 && v_texCoord.x < u_splitPosition) {
    fragColor = texColor;
    return;
  }

  if (u_enableProcessing == 0) {
    fragColor = texColor;
    return;
  }

  // Step 1: sRGB -> Linear
  vec3 linearRGB = srgb_to_linear_v(texColor.rgb);

  // Step 2: Primary calibration (linear RGB -> calibrated linear RGB via XYZ)
  // Uses smooth gamut mapping instead of hard clamp to avoid white/black edges.
  // Preserves hue by desaturating toward the neutral axis when out-of-gamut.
  vec3 calibratedRGB = u_primaryMatrix * linearRGB;
  {
    float maxC = max(calibratedRGB.r, max(calibratedRGB.g, calibratedRGB.b));
    float minC = min(calibratedRGB.r, min(calibratedRGB.g, calibratedRGB.b));
    // Compute luminance (neutral axis value) from original calibrated result
    float lum = dot(calibratedRGB, vec3(0.2126, 0.7152, 0.0722));
    lum = clamp(lum, 0.0, 1.0);
    // If any channel exceeds [0, 1], desaturate toward luminance to pull it back in
    if (maxC > 1.0 || minC < 0.0) {
      vec3 lumVec = vec3(lum);
      vec3 diff = calibratedRGB - lumVec;
      // Find the smallest blend factor t in [0,1] such that lum + t*diff is in [0,1]
      float t = 1.0;
      for (int ch = 0; ch < 3; ch++) {
        float d = (ch == 0) ? diff.r : ((ch == 1) ? diff.g : diff.b);
        float c = (ch == 0) ? calibratedRGB.r : ((ch == 1) ? calibratedRGB.g : calibratedRGB.b);
        if (c > 1.0 && d > 0.001) {
          t = min(t, (1.0 - lum) / d);
        }
        if (c < 0.0 && d < -0.001) {
          t = min(t, -lum / d);
        }
      }
      t = clamp(t, 0.0, 1.0);
      calibratedRGB = lumVec + diff * t;
    }
    calibratedRGB = clamp(calibratedRGB, 0.0, 1.0);
  }

  // Step 3: HSV local mapping
  vec3 hsv = rgb2hsv(calibratedRGB);
  float hueShift = calculateLocalShift(hsv.x);
  hsv.x = fract(hsv.x + hueShift + u_globalHueShift);
  vec3 mappedRGB = hsv2rgb(hsv);

  // Step 4: Toning (sRGB space for v1.2)
  vec3 tonedRGB = applyToning(mappedRGB);

  // Step 5: Linear -> sRGB output
  vec3 outputRGB = linear_to_srgb_v(tonedRGB);

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
  float highMask = smoothstep(0.5, 1.0, lum);
  rgb += u_highlights * highMask * 0.5;
  float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
  rgb += u_shadows * shadowMask * 0.5;
  float whiteMask = smoothstep(0.75, 1.0, lum);
  rgb += u_whites * whiteMask * 0.3;
  float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
  rgb += u_blacks * blackMask * 0.3;
  return clamp(rgb, 0.0, 1.0);
}

void main() {
  vec4 texColor = texture2D(u_image, v_texCoord);
  if (u_splitView == 1 && v_texCoord.x < u_splitPosition) {
    gl_FragColor = texColor;
    return;
  }
  if (u_enableProcessing == 0) {
    gl_FragColor = texColor;
    return;
  }
  vec3 linearRGB = srgb_to_linear_v(texColor.rgb);
  vec3 calibratedRGB = u_primaryMatrix * linearRGB;
  {
    float maxC = max(calibratedRGB.r, max(calibratedRGB.g, calibratedRGB.b));
    float minC = min(calibratedRGB.r, min(calibratedRGB.g, calibratedRGB.b));
    float lum = dot(calibratedRGB, vec3(0.2126, 0.7152, 0.0722));
    lum = clamp(lum, 0.0, 1.0);
    if (maxC > 1.0 || minC < 0.0) {
      vec3 lumVec = vec3(lum);
      vec3 diff = calibratedRGB - lumVec;
      float t = 1.0;
      for (int ch = 0; ch < 3; ch++) {
        float d = (ch == 0) ? diff.r : ((ch == 1) ? diff.g : diff.b);
        float c = (ch == 0) ? calibratedRGB.r : ((ch == 1) ? calibratedRGB.g : calibratedRGB.b);
        if (c > 1.0 && d > 0.001) {
          t = min(t, (1.0 - lum) / d);
        }
        if (c < 0.0 && d < -0.001) {
          t = min(t, -lum / d);
        }
      }
      t = clamp(t, 0.0, 1.0);
      calibratedRGB = lumVec + diff * t;
    }
    calibratedRGB = clamp(calibratedRGB, 0.0, 1.0);
  }
  vec3 hsv = rgb2hsv(calibratedRGB);
  float hueShift = calculateLocalShift(hsv.x);
  hsv.x = fract(hsv.x + hueShift + u_globalHueShift);
  vec3 mappedRGB = hsv2rgb(hsv);
  vec3 tonedRGB = applyToning(mappedRGB);
  vec3 outputRGB = linear_to_srgb_v(tonedRGB);
  gl_FragColor = vec4(clamp(outputRGB, 0.0, 1.0), texColor.a);
}
`;
