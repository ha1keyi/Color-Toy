/**
 * 3x3 Matrix operations for color space transforms.
 * Column-major storage for WebGL compatibility.
 * Pure functions with numerical stability checks.
 */

export type Mat3 = Float32Array; // 9 elements, column-major

// Standard color science constants
export const D65_WHITE_XYZ: [number, number, number] = [0.95047, 1.0, 1.08883];

export const SRGB_PRIMARIES = {
  red: [0.6400, 0.3300] as [number, number],
  green: [0.3000, 0.6000] as [number, number],
  blue: [0.1500, 0.0600] as [number, number],
};

// Standard sRGB -> XYZ matrix (column-major for WebGL)
export const SRGB_TO_XYZ: Mat3 = new Float32Array([
  0.4124564, 0.2126729, 0.0193339,  // col 0
  0.3575761, 0.7151522, 0.1191920,  // col 1
  0.1804375, 0.0721750, 0.9503041,  // col 2
]);

// Standard XYZ -> sRGB matrix (column-major for WebGL)
export const XYZ_TO_SRGB: Mat3 = new Float32Array([
   3.2404542, -0.9692660,  0.0556434,  // col 0
  -1.5371385,  1.8760108, -0.2040259,  // col 1
  -0.4985314,  0.0415560,  1.0572252,  // col 2
]);

export function createMat3(): Mat3 {
  return new Float32Array(9);
}

export function identityMat3(): Mat3 {
  const m = new Float32Array(9);
  m[0] = 1; m[4] = 1; m[8] = 1;
  return m;
}

// Set from row-major 2D array to column-major flat array
export function fromRows(rows: number[][]): Mat3 {
  const m = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      m[col * 3 + row] = rows[row][col];
    }
  }
  return m;
}

// Get element at (row, col) from column-major storage
export function getElement(m: Mat3, row: number, col: number): number {
  return m[col * 3 + row];
}

export function setElement(m: Mat3, row: number, col: number, v: number): void {
  m[col * 3 + row] = v;
}

// Determinant of 3x3 (column-major)
export function determinant(m: Mat3): number {
  const a = m[0], b = m[3], c = m[6];
  const d = m[1], e = m[4], f = m[7];
  const g = m[2], h = m[5], i = m[8];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

// Inverse of 3x3 (returns null if singular)
export function inverseMat3(m: Mat3): Mat3 | null {
  const det = determinant(m);
  if (Math.abs(det) < 1e-10) return null;

  const invDet = 1.0 / det;
  const a = m[0], b = m[3], c = m[6];
  const d = m[1], e = m[4], f = m[7];
  const g = m[2], h = m[5], i = m[8];

  const out = new Float32Array(9);
  out[0] = (e * i - f * h) * invDet;
  out[1] = (f * g - d * i) * invDet;
  out[2] = (d * h - e * g) * invDet;
  out[3] = (c * h - b * i) * invDet;
  out[4] = (a * i - c * g) * invDet;
  out[5] = (b * g - a * h) * invDet;
  out[6] = (b * f - c * e) * invDet;
  out[7] = (c * d - a * f) * invDet;
  out[8] = (a * e - b * d) * invDet;

  return out;
}

// Multiply two 3x3 matrices (column-major)
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        a[0 * 3 + row] * b[col * 3 + 0] +
        a[1 * 3 + row] * b[col * 3 + 1] +
        a[2 * 3 + row] * b[col * 3 + 2];
    }
  }
  return out;
}

// Multiply mat3 * vec3 (column-major)
export function mulMat3Vec3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/**
 * Build a primary matrix from xy chromaticity coordinates.
 * Maps linear RGB [0,1]^3 to XYZ, with white point normalization to D65.
 * Returns null if the primaries are degenerate (near-singular matrix).
 */
export function buildPrimaryMatrix(
  redXY: [number, number],
  greenXY: [number, number],
  blueXY: [number, number],
  whiteXYZ: [number, number, number] = D65_WHITE_XYZ
): Mat3 | null {
  // xyY -> XYZ (Y=1)
  const toXYZ = (x: number, y: number): [number, number, number] => {
    if (y === 0) return [0, 0, 0];
    return [x / y, 1.0, (1 - x - y) / y];
  };

  const R = toXYZ(redXY[0], redXY[1]);
  const G = toXYZ(greenXY[0], greenXY[1]);
  const B = toXYZ(blueXY[0], blueXY[1]);

  // Build M as column-major (columns are R, G, B XYZ values)
  const M = new Float32Array([
    R[0], R[1], R[2],  // col 0 (red primary)
    G[0], G[1], G[2],  // col 1 (green primary)
    B[0], B[1], B[2],  // col 2 (blue primary)
  ]);

  // Check numerical stability
  const det = determinant(M);
  if (Math.abs(det) < 1e-6) {
    return null; // Degenerate color space
  }

  // Solve for scaling factors: M * S = whiteXYZ
  const Minv = inverseMat3(M);
  if (!Minv) return null;

  const S = mulMat3Vec3(Minv, whiteXYZ);

  // Apply scaling to columns
  const result = new Float32Array(9);
  result[0] = M[0] * S[0]; result[1] = M[1] * S[0]; result[2] = M[2] * S[0];
  result[3] = M[3] * S[1]; result[4] = M[4] * S[1]; result[5] = M[5] * S[1];
  result[6] = M[6] * S[2]; result[7] = M[7] * S[2]; result[8] = M[8] * S[2];

  // Verify white point: M * [1,1,1] should equal whiteXYZ
  const test = mulMat3Vec3(result, [1, 1, 1]);
  const err = Math.abs(test[0] - whiteXYZ[0]) + Math.abs(test[1] - whiteXYZ[1]) + Math.abs(test[2] - whiteXYZ[2]);
  if (err > 1e-4) {
    console.warn('White point normalization error:', err);
    return null;
  }

  return result;
}

/**
 * Build the combined calibration matrix:
 * calibrated_XYZ = customPrimaryMatrix * linearRGB
 * calibrated_linearRGB = XYZ_TO_SRGB * calibrated_XYZ
 * Combined: calibrated_linearRGB = XYZ_TO_SRGB * customPrimaryMatrix * linearRGB
 */
export function buildCalibrationMatrix(
  redXY: [number, number],
  greenXY: [number, number],
  blueXY: [number, number]
): Mat3 | null {
  const primary = buildPrimaryMatrix(redXY, greenXY, blueXY);
  if (!primary) return null;
  return mulMat3(XYZ_TO_SRGB, primary);
}
