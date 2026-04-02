/**
 * WebGL Renderer - manages the GPU pipeline.
 * Handles context creation, shader compilation, texture management, and rendering.
 */
import {
  VERTEX_SHADER, FRAGMENT_SHADER,
  VERTEX_SHADER_V1, FRAGMENT_SHADER_V1
} from './shaders/colorProcessing';
import type { AppState } from '../state/types';
import { identityMat3, buildCalibrationMatrix } from '../core/matrix/operations';
import type { Mat3 } from '../core/matrix/operations';
import { createBitmapRasterSource, isRawRasterSource, type RasterSource } from '../core/image/rasterSource';

type TextureNorm16Extension = {
  RGBA16_EXT: number;
};

type RendererImageSource = RasterSource | HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export interface RendererCapabilities {
  webgl2: boolean;
  maxTextureSize: number;
  maxMappings: number;
  losslessRawImport: boolean;
}

export class Renderer {
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private program: WebGLProgram | null = null;
  private imageTexture: WebGLTexture | null = null;
  private toneCurveTexture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null; // WebGL2 only
  private posBuffer: WebGLBuffer | null = null;
  private texBuffer: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private isWebGL2: boolean;
  private _capabilities: RendererCapabilities;
  private _imageWidth = 0;
  private _imageHeight = 0;
  private needsRender = true;
  private animFrameId = 0;
  private fpsCallback: ((fps: number) => void) | null = null;
  private frameCount = 0;
  private lastFpsTime = 0;
  private currentFps = 60;
  private renderScale = 1;
  private logicalWidth = 0;
  private logicalHeight = 0;

  // FBO for color picker
  private pickFBO: WebGLFramebuffer | null = null;
  private pickTexture: WebGLTexture | null = null;

  // Cached matrix to avoid recalculation
  private cachedCalibrationMatrix: Mat3 = identityMat3();
  private readonly toneCurveLutSize = 256;
  private textureNorm16Ext: TextureNorm16Extension | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // Try WebGL2/WebGL1 with strict and relaxed options to maximize compatibility.
    const strictAttrs = {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    } as const;

    const relaxedAttrs = {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    } as const;

    let gl = canvas.getContext('webgl2', strictAttrs) as (WebGL2RenderingContext | WebGLRenderingContext | null);
    this.isWebGL2 = !!gl;

    if (!gl) {
      gl = canvas.getContext('webgl2', relaxedAttrs) as (WebGL2RenderingContext | WebGLRenderingContext | null);
      this.isWebGL2 = !!gl;
    }

    if (!gl) {
      gl = canvas.getContext('webgl', strictAttrs) as (WebGL2RenderingContext | WebGLRenderingContext | null);
      this.isWebGL2 = false;
    }

    if (!gl) {
      gl = canvas.getContext('webgl', relaxedAttrs) as (WebGL2RenderingContext | WebGLRenderingContext | null);
      this.isWebGL2 = false;
    }

    if (!gl) {
      throw new Error('WebGL not supported');
    }

    this.gl = gl;
    this.textureNorm16Ext = this.isWebGL2
      ? (gl.getExtension('EXT_texture_norm16') as TextureNorm16Extension | null)
      : null;
    this._capabilities = {
      webgl2: this.isWebGL2,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxMappings: this.isWebGL2 ? 8 : 4,
      losslessRawImport: !!this.textureNorm16Ext,
    };

    this.initShaders();
    this.initGeometry();
    this.initPickFBO();
    this.initToneCurveTexture();
  }

  get capabilities(): RendererCapabilities {
    return this._capabilities;
  }

  private initShaders(): void {
    const gl = this.gl;
    const vs = this.isWebGL2 ? VERTEX_SHADER : VERTEX_SHADER_V1;
    const fs = this.isWebGL2 ? FRAGMENT_SHADER : FRAGMENT_SHADER_V1;

    const vertShader = this.compileShader(gl.VERTEX_SHADER, vs);
    const fragShader = this.compileShader(gl.FRAGMENT_SHADER, fs);

    const program = gl.createProgram()!;
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(program));
    }

    this.program = program;
    gl.useProgram(program);

    // Cache uniform locations
    const uniformNames = [
      'u_image', 'u_toneCurveTex', 'u_primaryMatrix', 'u_globalHueShift',
      'u_numMappings', 'u_exposure', 'u_contrast',
      'u_highlights', 'u_shadows', 'u_whites', 'u_blacks',
      'u_splitPosition', 'u_splitView', 'u_enableProcessing', 'u_useToneCurve',
      'u_workingColorSpace', 'u_gamutCompression', 'u_inputIsLinear',
    ];
    for (const name of uniformNames) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    // Array uniform locations
    for (let i = 0; i < (this.isWebGL2 ? 8 : 4); i++) {
      this.uniforms[`u_mappings[${i}]`] = gl.getUniformLocation(program, `u_mappings[${i}]`);
    }
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + info);
    }
    return shader;
  }

  private initGeometry(): void {
    const gl = this.gl;

    // Fullscreen quad vertices
    const positions = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]);
    const texCoords = new Float32Array([
      0, 1, 1, 1, 0, 0,
      0, 0, 1, 1, 1, 0,
    ]);

    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      this.vao = gl2.createVertexArray();
      gl2.bindVertexArray(this.vao);
    }

    // Position buffer
    this.posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.program!, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // TexCoord buffer
    this.texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    const texLoc = gl.getAttribLocation(this.program!, 'a_texCoord');
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    if (this.isWebGL2) {
      (gl as WebGL2RenderingContext).bindVertexArray(null);
    }
  }

  private initPickFBO(): void {
    const gl = this.gl;
    this.pickFBO = gl.createFramebuffer();
    this.pickTexture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private initToneCurveTexture(): void {
    const gl = this.gl;
    this.toneCurveTexture = gl.createTexture();
    if (!this.toneCurveTexture) return;

    gl.bindTexture(gl.TEXTURE_2D, this.toneCurveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const identity = new Float32Array(this.toneCurveLutSize);
    for (let i = 0; i < this.toneCurveLutSize; i++) {
      identity[i] = i / (this.toneCurveLutSize - 1);
    }
    this.setToneCurveLut(identity);
  }

  setToneCurveLut(lut: Float32Array): void {
    const gl = this.gl;
    if (!this.toneCurveTexture) return;

    const data = new Uint8Array(this.toneCurveLutSize * 4);
    for (let i = 0; i < this.toneCurveLutSize; i++) {
      const v = Math.max(0, Math.min(1, lut[Math.min(i, lut.length - 1)] ?? 0));
      const u8 = Math.round(v * 255);
      const o = i * 4;
      data[o] = u8;
      data[o + 1] = u8;
      data[o + 2] = u8;
      data[o + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.toneCurveTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.toneCurveLutSize,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data
    );

    this.needsRender = true;
  }

  loadImage(image: RendererImageSource): void {
    const gl = this.gl;
    const rasterSource = image instanceof HTMLImageElement
      || image instanceof HTMLCanvasElement
      || image instanceof ImageBitmap
      ? createBitmapRasterSource(image)
      : image;

    if (this.imageTexture) {
      gl.deleteTexture(this.imageTexture);
    }

    this.imageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (isRawRasterSource(rasterSource)) {
      if (!this.isWebGL2 || !this.textureNorm16Ext) {
        throw new Error('Lossless RAW import requires WebGL2 with EXT_texture_norm16 support.');
      }

      const gl2 = gl as WebGL2RenderingContext;
      gl2.texImage2D(
        gl2.TEXTURE_2D,
        0,
        this.textureNorm16Ext.RGBA16_EXT,
        rasterSource.width,
        rasterSource.height,
        0,
        gl2.RGBA,
        gl2.UNSIGNED_SHORT,
        rasterSource.data,
      );
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rasterSource.bitmap);
    }

    gl.useProgram(this.program);
    gl.uniform1i(
      this.uniforms['u_inputIsLinear'],
      isRawRasterSource(rasterSource) && rasterSource.transfer === 'linear-srgb' ? 1 : 0,
    );

    this._imageWidth = rasterSource.width;
    this._imageHeight = rasterSource.height;
    this.logicalWidth = rasterSource.width;
    this.logicalHeight = rasterSource.height;
    this.needsRender = true;
  }

  resize(width: number, height: number): void {
    this.logicalWidth = Math.max(1, Math.floor(width));
    this.logicalHeight = Math.max(1, Math.floor(height));

    const maxTex = this._capabilities.maxTextureSize;
    const scaleByTexture = Math.min(
      1,
      maxTex / this.logicalWidth,
      maxTex / this.logicalHeight,
    );
    const effectiveScale = Math.max(0.5, Math.min(1, this.renderScale * scaleByTexture));

    const scaledWidth = Math.max(1, Math.floor(this.logicalWidth * effectiveScale));
    const scaledHeight = Math.max(1, Math.floor(this.logicalHeight * effectiveScale));

    if (this.canvas.width !== scaledWidth || this.canvas.height !== scaledHeight) {
      this.canvas.width = scaledWidth;
      this.canvas.height = scaledHeight;
      this.needsRender = true;
    }
  }

  setRenderScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(1, scale));
    if (Math.abs(clamped - this.renderScale) < 1e-4) {
      return;
    }
    this.renderScale = clamped;
    this.resize(this.logicalWidth || this.canvas.width || 1, this.logicalHeight || this.canvas.height || 1);
    this.needsRender = true;
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  updateUniforms(state: AppState): void {
    const gl = this.gl;
    if (!this.program) return;

    gl.useProgram(this.program);

    // Calibration matrix
    const newMatrix = buildCalibrationMatrix(
      state.primaries.red,
      state.primaries.green,
      state.primaries.blue
    );
    if (newMatrix) {
      this.cachedCalibrationMatrix = newMatrix;
    }
    gl.uniformMatrix3fv(this.uniforms['u_primaryMatrix'], false, this.cachedCalibrationMatrix);

    // Global hue shift
    gl.uniform1f(this.uniforms['u_globalHueShift'], state.globalHueShift);

    // Mappings
    const maxMappings = this.isWebGL2 ? 8 : 4;
    const numMappings = Math.min(state.localMappings.length, maxMappings);
    gl.uniform1i(this.uniforms['u_numMappings'], numMappings);

    for (let i = 0; i < maxMappings; i++) {
      const loc = this.uniforms[`u_mappings[${i}]`];
      if (i < numMappings) {
        const m = state.localMappings[i];
        gl.uniform4f(loc, m.srcHue, m.dstHue, m.range, m.strength);
      } else {
        gl.uniform4f(loc, 0, 0, 0, 0);
      }
    }

    // Toning
    gl.uniform1f(this.uniforms['u_exposure'], state.toning.exposure);
    gl.uniform1f(this.uniforms['u_contrast'], state.toning.contrast);
    gl.uniform1f(this.uniforms['u_highlights'], state.toning.highlights);
    gl.uniform1f(this.uniforms['u_shadows'], state.toning.shadows);
    gl.uniform1f(this.uniforms['u_whites'], state.toning.whites);
    gl.uniform1f(this.uniforms['u_blacks'], state.toning.blacks);

    // Split view
    gl.uniform1i(this.uniforms['u_splitView'], state.ui.splitView ? 1 : 0);
    gl.uniform1f(this.uniforms['u_splitPosition'], Math.max(0, Math.min(1, state.ui.splitPosition)));
    gl.uniform1i(this.uniforms['u_enableProcessing'], state.ui.holdCompareActive ? 0 : 1);
    const useToneCurve = state.ui.toneCurveEnabled && !state.ui.toneCurveBypassPreview;
    gl.uniform1i(this.uniforms['u_useToneCurve'], useToneCurve ? 1 : 0);
    gl.uniform1i(this.uniforms['u_workingColorSpace'], state.ui.workingColorSpace === 'acescg' ? 1 : 0);
    gl.uniform1i(this.uniforms['u_gamutCompression'], state.ui.gamutCompressionEnabled ? 1 : 0);

    this.needsRender = true;
  }

  render(): void {
    const gl = this.gl;
    if (!this.program || !this.imageTexture) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(this.uniforms['u_image'], 0);

    if (this.toneCurveTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.toneCurveTexture);
      gl.uniform1i(this.uniforms['u_toneCurveTex'], 1);
      gl.activeTexture(gl.TEXTURE0);
    }

    if (this.isWebGL2 && this.vao) {
      (gl as WebGL2RenderingContext).bindVertexArray(this.vao);
    } else {
      // Rebind for WebGL1
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      const posLoc = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
      const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (this.isWebGL2 && this.vao) {
      (gl as WebGL2RenderingContext).bindVertexArray(null);
    }

    this.needsRender = false;
    this.trackFps();
  }

  /** Pick color at normalized (0-1) coordinates on the image */
  pickColor(nx: number, ny: number, sampleRadiusPx = 0): [number, number, number] | null {
    const gl = this.gl;
    if (!this.program || !this.imageTexture) return null;

    // Render to pick FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFBO);
    gl.viewport(0, 0, 2, 2);

    // We need to render the full image and read from the right spot
    // Instead, render full and readPixels at the correct position
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const width = this.canvas.width;
    const height = this.canvas.height;
    const centerX = Math.floor(nx * width);
    const centerY = Math.floor((1 - ny) * height); // Flip Y

    const radius = Math.max(0, Math.floor(sampleRadiusPx));
    const startX = Math.max(0, centerX - radius);
    const startY = Math.max(0, centerY - radius);
    const endX = Math.min(width - 1, centerX + radius);
    const endY = Math.min(height - 1, centerY + radius);
    const sampleW = Math.max(1, endX - startX + 1);
    const sampleH = Math.max(1, endY - startY + 1);

    const pixels = new Uint8Array(sampleW * sampleH * 4);
    gl.readPixels(startX, startY, sampleW, sampleH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let r = 0;
    let g = 0;
    let b = 0;
    const total = sampleW * sampleH;
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
    }

    return [r / (255 * total), g / (255 * total), b / (255 * total)];
  }

  /** Export the current render at full resolution */
  exportImage(fullImage: HTMLImageElement, state: AppState): HTMLCanvasElement {
    // Create offscreen canvas at full resolution
    const offscreen = document.createElement('canvas');
    offscreen.width = fullImage.naturalWidth;
    offscreen.height = fullImage.naturalHeight;

    const gl = offscreen.getContext('webgl2', {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    }) as WebGL2RenderingContext;

    if (!gl) {
      // Fallback: return current canvas
      return this.canvas;
    }

    // Create a temporary renderer for export
    const tempRenderer = new Renderer(offscreen);
    tempRenderer.loadImage(fullImage);
    tempRenderer.updateUniforms(state);
    tempRenderer.render();
    tempRenderer.destroy();

    return offscreen;
  }

  startRenderLoop(): void {
    const loop = () => {
      if (this.needsRender) {
        this.render();
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  requestRender(): void {
    this.needsRender = true;
  }

  onFps(callback: (fps: number) => void): void {
    this.fpsCallback = callback;
  }

  getFps(): number {
    return this.currentFps;
  }

  private trackFps(): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      this.currentFps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
      if (this.fpsCallback) this.fpsCallback(this.currentFps);
    }
  }

  destroy(): void {
    this.stopRenderLoop();
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.imageTexture) gl.deleteTexture(this.imageTexture);
    if (this.toneCurveTexture) gl.deleteTexture(this.toneCurveTexture);
    if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
    if (this.texBuffer) gl.deleteBuffer(this.texBuffer);
    if (this.pickFBO) gl.deleteFramebuffer(this.pickFBO);
    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.isWebGL2 && this.vao) {
      (gl as WebGL2RenderingContext).deleteVertexArray(this.vao);
    }
  }
}
