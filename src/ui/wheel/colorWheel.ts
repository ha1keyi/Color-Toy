/**
 * Color Wheel renderer using Canvas 2D.
 * Renders different wheel views for each layer:
 *   - calibration: hue ring + fixed sRGB R/G/B markers with dashed arrows to shifted positions
 *   - mapping: hue ring + mapping control points + global hue center
 *   - toning: empty (no wheel drawn)
 *
 * Also provides drawRendered() for a second canvas showing post-processing output.
 * Runs at 15fps independently from the main WebGL pipeline.
 */
import { hsvToRgb } from '../../core/color/conversions';
import {
  AppState,
  D65_WHITE_XY,
  SRGB_RED_XY,
  SRGB_GREEN_XY,
  SRGB_BLUE_XY,
  calibrationToPrimaries,
} from '../../state/types';
import {
  buildCalibrationMatrix,
  mulMat3Vec3,
  Mat3,
} from '../../core/matrix/operations';

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Chromaticity-to-hue helper
// ---------------------------------------------------------------------------

/**
 * Convert CIE xy chromaticity to an approximate perceptual hue (0-1).
 * Works by converting xy -> XYZ (Y=1) -> linear sRGB -> HSV hue.
 */
function xyToHue(x: number, y: number): number {
  if (y <= 0) return 0;
  const X = x / y;
  const Y = 1.0;
  const Z = (1 - x - y) / y;

  // XYZ to linear sRGB (standard IEC 61966-2-1 matrix)
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  // Normalize so the largest component is 1, then clamp negatives
  const maxC = Math.max(r, g, b);
  if (maxC > 0) {
    r /= maxC;
    g /= maxC;
    b /= maxC;
  }
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  // RGB -> HSV (just need hue)
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-10) return 0;

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return h;
}

/**
 * Compute the normalized distance from the D65 white point in xy space.
 * Used for the radial position of primary markers on the wheel.
 */
function xyToNormalizedRadius(x: number, y: number): number {
  const wx = D65_WHITE_XY[0];
  const wy = D65_WHITE_XY[1];
  const dist = Math.sqrt((x - wx) ** 2 + (y - wy) ** 2);
  // 0.4 is roughly the maximum gamut distance from the white point in xy
  return Math.min(dist / 0.4, 1);
}

/**
 * Convert a hue value (0-1) to a canvas angle.
 * Hue 0 (red) is at the TOP of the wheel (-PI/2 in canvas coords).
 */
function hueToCanvasAngle(hue: number): number {
  return hue * TWO_PI - Math.PI / 2;
}

/**
 * Convert a canvas angle back to a hue value (0-1).
 */
function canvasAngleToHue(angle: number): number {
  let hue = (angle + Math.PI / 2) / TWO_PI;
  if (hue < 0) hue += 1;
  if (hue >= 1) hue -= 1;
  return hue;
}

// ---------------------------------------------------------------------------
// ColorWheel class
// ---------------------------------------------------------------------------

export class ColorWheel {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private center: number;
  private radius: number;
  private innerRadius: number;

  // Interaction state
  private dragging: 'none' | 'mapping' | 'global' = 'none';
  private dragTarget: string | null = null;
  private onMappingChange: ((id: string, hue: number) => void) | null = null;
  private onMappingAdd: ((hue: number) => void) | null = null;
  private onGlobalHueChange: ((shift: number) => void) | null = null;
  private onMappingSelect: ((id: string | null) => void) | null = null;
  private onDragEnd: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.size = 0;
    this.center = 0;
    this.radius = 0;
    this.innerRadius = 0;
    this.setupInteraction();
  }

  setCallbacks(cbs: {
    onPrimaryChange?: (color: string, hue: number, sat: number) => void;
    onMappingChange?: (id: string, hue: number) => void;
    onMappingAdd?: (hue: number) => void;
    onGlobalHueChange?: (shift: number) => void;
    onMappingSelect?: (id: string | null) => void;
    onDragEnd?: () => void;
  }): void {
    this.onMappingChange = cbs.onMappingChange ?? null;
    this.onMappingAdd = cbs.onMappingAdd ?? null;
    this.onGlobalHueChange = cbs.onGlobalHueChange ?? null;
    this.onMappingSelect = cbs.onMappingSelect ?? null;
    this.onDragEnd = cbs.onDragEnd ?? null;
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    const cssSize = Math.min(rect.width, rect.height, 360);
    this.canvas.style.width = cssSize + 'px';
    this.canvas.style.height = cssSize + 'px';
    this.canvas.width = cssSize * dpr;
    this.canvas.height = cssSize * dpr;
    this.ctx.scale(dpr, dpr);
    this.size = cssSize;
    this.center = cssSize / 2;
    this.radius = cssSize / 2 - 16;
    this.innerRadius = this.radius * 0.3;
  }

  // -----------------------------------------------------------------------
  // Main draw (source/input wheel)
  // -----------------------------------------------------------------------

  draw(state: AppState): void {
    const ctx = this.ctx;
    if (!this.size) return;

    ctx.clearRect(0, 0, this.size, this.size);

    switch (state.ui.activeLayer) {
      case 'calibration': {
        this.drawHueRing(ctx, this.center, this.radius, this.innerRadius);
        this.drawCalibrationMarkers(ctx, state);
        break;
      }
      case 'mapping':
        this.drawHueRing(ctx, this.center, this.radius, this.innerRadius);
        this.drawGlobalHueCenter(ctx, state);
        this.drawMappingPoints(ctx, state);
        break;
      case 'toning':
        // Toning mode: clear canvas and return early, no wheel drawn
        return;
    }

    // White point indicator at center
    ctx.beginPath();
    ctx.arc(this.center, this.center, 3, 0, TWO_PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // -----------------------------------------------------------------------
  // Rendered / output draw (second canvas)
  // -----------------------------------------------------------------------

  /**
   * Draw the "rendered" color wheel onto a separate canvas, showing
   * what the output looks like after calibration processing is applied.
   *
   * - calibration tab: transformed hue ring + shifted R/G/B markers
   * - mapping tab: transformed hue ring + mapping control points at destination positions
   * - toning tab: clear canvas, return early (no wheel)
   */
  drawRendered(state: AppState, canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use the same size as the edit wheel for consistent appearance
    const cssSize = this.size || 160;
    if (!cssSize) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.scale(dpr, dpr);

    const center = cssSize / 2;
    const radius = cssSize / 2 - 16;
    const innerRadius = radius * 0.3;

    ctx.clearRect(0, 0, cssSize, cssSize);

    // Toning mode: no wheel rendered
    if (state.ui.activeLayer === 'toning') {
      return;
    }

    // Build calibration matrix from the current primaries
    const calibMatrix = buildCalibrationMatrix(
      state.primaries.red,
      state.primaries.green,
      state.primaries.blue
    );

    // Draw the transformed hue ring
    this.drawHueRingTransformed(ctx, center, radius, innerRadius, calibMatrix);

    switch (state.ui.activeLayer) {
      case 'calibration':
        this.drawRenderedPrimaryMarkers(ctx, state, center, radius, innerRadius);
        break;
      case 'mapping':
        this.drawRenderedMappingPoints(ctx, state, center, radius, innerRadius);
        break;
    }

    // White point indicator
    ctx.beginPath();
    ctx.arc(center, center, 3, 0, TWO_PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // -----------------------------------------------------------------------
  // Hue ring drawing
  // -----------------------------------------------------------------------

  /**
   * Draw the hue ring (no center fill, no white gradient).
   * The inner area is left empty/transparent.
   */
  private drawHueRing(
    ctx: CanvasRenderingContext2D,
    center: number,
    radius: number,
    innerRadius: number,
    transform?: ((r: number, g: number, b: number) => [number, number, number]) | null,
  ): void {
    const segments = 360;
    for (let i = 0; i < segments; i++) {
      const startAngle = (i / segments) * TWO_PI - Math.PI / 2;
      const endAngle = ((i + 1.5) / segments) * TWO_PI - Math.PI / 2;
      const hue = i / segments;

      let [r, g, b] = hsvToRgb(hue, 1, 1);

      if (transform) {
        [r, g, b] = transform(r, g, b);
        // Smooth gamut mapping: desaturate toward luminance instead of hard clamp
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const lumC = Math.max(0, Math.min(1, lum));
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        if (maxC > 1 || minC < 0) {
          const dr = r - lumC, dg = g - lumC, db = b - lumC;
          let t = 1;
          for (const [c, d] of [[r, dr], [g, dg], [b, db]]) {
            if (c > 1 && d > 0.001) t = Math.min(t, (1 - lumC) / d);
            if (c < 0 && d < -0.001) t = Math.min(t, -lumC / d);
          }
          t = Math.max(0, Math.min(1, t));
          r = lumC + dr * t;
          g = lumC + dg * t;
          b = lumC + db * t;
        }
        r = Math.max(0, Math.min(1, r));
        g = Math.max(0, Math.min(1, g));
        b = Math.max(0, Math.min(1, b));
      }

      ctx.beginPath();
      ctx.arc(center, center, radius, startAngle, endAngle);
      ctx.arc(center, center, innerRadius, endAngle, startAngle, true);
      ctx.closePath();

      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fill();
    }
  }

  /**
   * Draw the hue ring with a calibration matrix applied to each color.
   */
  private drawHueRingTransformed(
    ctx: CanvasRenderingContext2D,
    center: number,
    radius: number,
    innerRadius: number,
    matrix: Mat3 | null,
  ): void {
    const transform = matrix
      ? (r: number, g: number, b: number): [number, number, number] =>
          mulMat3Vec3(matrix, [r, g, b])
      : null;
    this.drawHueRing(ctx, center, radius, innerRadius, transform);
  }

  // -----------------------------------------------------------------------
  // Calibration markers (calibration mode - source wheel)
  // -----------------------------------------------------------------------

  /**
   * Draw fixed sRGB R/G/B markers at their standard positions, with dashed
   * lines showing where calibration shifts them to. The shifted position
   * is derived from calibrationToPrimaries(state.calibration).
   */
  private drawCalibrationMarkers(ctx: CanvasRenderingContext2D, state: AppState): void {
    const shiftedPrimaries = calibrationToPrimaries(state.calibration);

    const markers = [
      { fixedXY: SRGB_RED_XY, shiftedXY: shiftedPrimaries.red, color: '#ff3333', label: 'R' },
      { fixedXY: SRGB_GREEN_XY, shiftedXY: shiftedPrimaries.green, color: '#33cc33', label: 'G' },
      { fixedXY: SRGB_BLUE_XY, shiftedXY: shiftedPrimaries.blue, color: '#3366ff', label: 'B' },
    ];

    for (const m of markers) {
      // Fixed standard sRGB position
      const fixedHue = xyToHue(m.fixedXY[0], m.fixedXY[1]);
      const fixedNR = xyToNormalizedRadius(m.fixedXY[0], m.fixedXY[1]);
      const fixedPos = this.polarToCanvas(hueToCanvasAngle(fixedHue), fixedNR);

      // Shifted (calibrated) position
      const shiftedHue = xyToHue(m.shiftedXY[0], m.shiftedXY[1]);
      const shiftedNR = xyToNormalizedRadius(m.shiftedXY[0], m.shiftedXY[1]);
      const shiftedPos = this.polarToCanvas(hueToCanvasAngle(shiftedHue), shiftedNR);

      // Dashed line from fixed to shifted position (if they differ)
      const dx = shiftedPos.x - fixedPos.x;
      const dy = shiftedPos.y - fixedPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) {
        ctx.beginPath();
        ctx.moveTo(fixedPos.x, fixedPos.y);
        ctx.lineTo(shiftedPos.x, shiftedPos.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small filled dot at the shifted (destination) position
        ctx.beginPath();
        ctx.arc(shiftedPos.x, shiftedPos.y, 5, 0, TWO_PI);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Fixed marker circle (always at standard sRGB position)
      ctx.beginPath();
      ctx.arc(fixedPos.x, fixedPos.y, 14, 0, TWO_PI);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.label, fixedPos.x, fixedPos.y);
    }
  }

  /**
   * Draw R/G/B primary markers on the rendered wheel, showing where
   * the primaries land after calibration (at shifted positions).
   */
  private drawRenderedPrimaryMarkers(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    center: number,
    radius: number,
    innerRadius: number,
  ): void {
    const calibratedPrimaries = calibrationToPrimaries(state.calibration);

    const colors = [
      { xy: calibratedPrimaries.red, color: '#ff3333', label: 'R' },
      { xy: calibratedPrimaries.green, color: '#33cc33', label: 'G' },
      { xy: calibratedPrimaries.blue, color: '#3366ff', label: 'B' },
    ];

    for (const c of colors) {
      const hue = xyToHue(c.xy[0], c.xy[1]);
      const nRadius = xyToNormalizedRadius(c.xy[0], c.xy[1]);
      const canvasAngle = hueToCanvasAngle(hue);
      const r = innerRadius + nRadius * (radius - innerRadius);
      const px = center + Math.cos(canvasAngle) * r;
      const py = center + Math.sin(canvasAngle) * r;

      ctx.beginPath();
      ctx.arc(px, py, 14, 0, TWO_PI);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.label, px, py);
    }
  }

  // -----------------------------------------------------------------------
  // Mapping points (mapping mode)
  // -----------------------------------------------------------------------

  private drawMappingPoints(ctx: CanvasRenderingContext2D, state: AppState): void {
    const midR = (this.radius + this.innerRadius) / 2;

    for (const mapping of state.localMappings) {
      const srcAngle = hueToCanvasAngle(mapping.srcHue);
      const dstAngle = hueToCanvasAngle(mapping.dstHue);

      // Source position on ring
      const sx = this.center + Math.cos(srcAngle) * midR;
      const sy = this.center + Math.sin(srcAngle) * midR;

      // Destination indicator
      const dx = this.center + Math.cos(dstAngle) * midR;
      const dy = this.center + Math.sin(dstAngle) * midR;

      // Arrow from src to dst
      if (Math.abs(mapping.srcHue - mapping.dstHue) > 0.01) {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(dx, dy);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Influence range arc
      const rangeStart = hueToCanvasAngle(mapping.srcHue - mapping.range);
      const rangeEnd = hueToCanvasAngle(mapping.srcHue + mapping.range);
      ctx.beginPath();
      ctx.arc(this.center, this.center, midR + 8, rangeStart, rangeEnd);
      ctx.strokeStyle = `rgba(255,255,255,${0.15 + mapping.strength * 0.25})`;
      ctx.lineWidth = 4;
      ctx.stroke();

      // Source dot
      const isSelected = state.ui.selectedMappingId === mapping.id;
      const dotSize = isSelected ? 12 : 10;
      ctx.beginPath();
      ctx.arc(sx, sy, dotSize, 0, TWO_PI);
      const [r, g, b] = hsvToRgb(mapping.srcHue, 0.8, 0.9);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
    }
  }

  /**
   * Draw mapping control points on the rendered wheel at their
   * destination (final) hue positions.
   */
  private drawRenderedMappingPoints(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    center: number,
    radius: number,
    innerRadius: number,
  ): void {
    const midR = (radius + innerRadius) / 2;

    for (const mapping of state.localMappings) {
      const dstAngle = hueToCanvasAngle(mapping.dstHue);
      const dx = center + Math.cos(dstAngle) * midR;
      const dy = center + Math.sin(dstAngle) * midR;

      const isSelected = state.ui.selectedMappingId === mapping.id;
      const dotSize = isSelected ? 12 : 10;

      ctx.beginPath();
      ctx.arc(dx, dy, dotSize, 0, TWO_PI);
      const [r, g, b] = hsvToRgb(mapping.dstHue, 0.8, 0.9);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
    }
  }

  // -----------------------------------------------------------------------
  // Global hue center (mapping mode)
  // -----------------------------------------------------------------------

  private drawGlobalHueCenter(ctx: CanvasRenderingContext2D, state: AppState): void {
    const { center, innerRadius } = this;

    const globalAngle = hueToCanvasAngle(state.globalHueShift);
    const indicatorR = innerRadius * 0.6;

    // Background circle
    ctx.beginPath();
    ctx.arc(center, center, indicatorR, 0, TWO_PI);
    ctx.fillStyle = 'rgba(60,60,80,0.8)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Direction indicator dot
    const ix = center + Math.cos(globalAngle) * (indicatorR - 4);
    const iy = center + Math.sin(globalAngle) * (indicatorR - 4);
    ctx.beginPath();
    ctx.arc(ix, iy, 4, 0, TWO_PI);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HUE', center, center);
  }

  // -----------------------------------------------------------------------
  // Coordinate conversion helpers
  // -----------------------------------------------------------------------

  /**
   * Convert a polar position (canvas angle + normalized 0-1 radius) to
   * canvas pixel coordinates within the hue ring.
   */
  private polarToCanvas(angle: number, normalizedRadius: number): { x: number; y: number } {
    const r = this.innerRadius + normalizedRadius * (this.radius - this.innerRadius);
    return {
      x: this.center + Math.cos(angle) * r,
      y: this.center + Math.sin(angle) * r,
    };
  }

  /**
   * Convert canvas pixel coordinates to polar (angle + normalized radius).
   */
  private canvasToPolar(cx: number, cy: number): { angle: number; radius: number } {
    const dx = cx - this.center;
    const dy = cy - this.center;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const normalizedRadius = (dist - this.innerRadius) / (this.radius - this.innerRadius);
    return { angle, radius: Math.max(0, Math.min(1, normalizedRadius)) };
  }

  // -----------------------------------------------------------------------
  // Interaction handling
  // -----------------------------------------------------------------------

  private setupInteraction(): void {
    const getPos = (e: MouseEvent | Touch): { x: number; y: number } => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    const hitTest = (x: number, y: number, state: AppState): { type: string; id: string } | null => {
      const dist = Math.sqrt((x - this.center) ** 2 + (y - this.center) ** 2);

      if (state.ui.activeLayer === 'mapping') {
        // Test global hue center
        if (dist < this.innerRadius * 0.6) {
          return { type: 'global', id: '' };
        }

        // Test mapping points
        const midR = (this.radius + this.innerRadius) / 2;
        for (const m of state.localMappings) {
          const mAngle = hueToCanvasAngle(m.srcHue);
          const mx = this.center + Math.cos(mAngle) * midR;
          const my = this.center + Math.sin(mAngle) * midR;
          const d = Math.sqrt((x - mx) ** 2 + (y - my) ** 2);
          if (d < 22) return { type: 'mapping', id: m.id };
        }
      }

      // No interactive hit targets for calibration mode (markers are fixed)
      // No interactive hit targets for toning mode (no wheel drawn)

      return null;
    };

    // External state reference for interaction handlers
    let currentState: AppState | null = null;
    (this as any)._setState = (s: AppState) => { currentState = s; };

    const onDown = (x: number, y: number) => {
      if (!currentState) return;
      const hit = hitTest(x, y, currentState);
      if (hit) {
        this.dragging = hit.type as any;
        this.dragTarget = hit.id;
        if (hit.type === 'mapping' && this.onMappingSelect) {
          this.onMappingSelect(hit.id);
        }
      } else if (currentState.ui.activeLayer === 'mapping') {
        // Click on empty ring area: add new mapping point
        const { angle } = this.canvasToPolar(x, y);
        const dist = Math.sqrt((x - this.center) ** 2 + (y - this.center) ** 2);
        if (dist > this.innerRadius && dist < this.radius + 10) {
          const hue = canvasAngleToHue(angle);
          if (this.onMappingAdd) this.onMappingAdd(hue);
        }
      }
    };

    const onMove = (x: number, y: number) => {
      if (this.dragging === 'none' || !currentState) return;

      const { angle } = this.canvasToPolar(x, y);

      if (this.dragging === 'mapping' && this.dragTarget && this.onMappingChange) {
        const hue = canvasAngleToHue(angle);
        this.onMappingChange(this.dragTarget, hue);
      } else if (this.dragging === 'global' && this.onGlobalHueChange) {
        const hue = canvasAngleToHue(angle);
        this.onGlobalHueChange(hue);
      }
    };

    const onUp = () => {
      if (this.dragging !== 'none' && this.onDragEnd) {
        this.onDragEnd();
      }
      this.dragging = 'none';
      this.dragTarget = null;
    };

    // Mouse events
    this.canvas.addEventListener('mousedown', (e) => {
      const pos = getPos(e);
      onDown(pos.x, pos.y);
    });
    window.addEventListener('mousemove', (e) => {
      const pos = getPos(e);
      onMove(pos.x, pos.y);
    });
    window.addEventListener('mouseup', onUp);

    // Touch events
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const pos = getPos(e.touches[0]);
      onDown(pos.x, pos.y);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (this.dragging !== 'none') {
        const pos = getPos(e.touches[0]);
        onMove(pos.x, pos.y);
      }
    });
    window.addEventListener('touchend', onUp);
  }

  setState(state: AppState): void {
    (this as any)._setState(state);
  }
}
