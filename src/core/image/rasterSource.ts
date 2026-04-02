export type BitmapRenderableSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export interface BitmapRasterSource {
  kind: 'bitmap';
  bitmap: BitmapRenderableSource;
  width: number;
  height: number;
}

export interface RawRasterSource {
  kind: 'raw-rgba16';
  data: Uint16Array;
  width: number;
  height: number;
  metadata?: Record<string, unknown>;
}

export type RasterSource = BitmapRasterSource | RawRasterSource;

export interface PreviewRasterAssets {
  renderSource: RasterSource;
  analysisCanvas: HTMLCanvasElement;
}

function getBitmapWidth(bitmap: BitmapRenderableSource): number {
  return bitmap instanceof HTMLImageElement ? (bitmap.naturalWidth || bitmap.width) : bitmap.width;
}

function getBitmapHeight(bitmap: BitmapRenderableSource): number {
  return bitmap instanceof HTMLImageElement ? (bitmap.naturalHeight || bitmap.height) : bitmap.height;
}

export function createBitmapRasterSource(bitmap: BitmapRenderableSource): BitmapRasterSource {
  return {
    kind: 'bitmap',
    bitmap,
    width: getBitmapWidth(bitmap),
    height: getBitmapHeight(bitmap),
  };
}

export function isRawRasterSource(source: RasterSource | null | undefined): source is RawRasterSource {
  return !!source && source.kind === 'raw-rgba16';
}

export function getRasterWidth(source: RasterSource): number {
  return source.width;
}

export function getRasterHeight(source: RasterSource): number {
  return source.height;
}

export function getMaxRasterDimension(source: RasterSource): number {
  return Math.max(source.width, source.height);
}

export function getScaledRasterDimensions(width: number, height: number, maxDim: number): { width: number; height: number; scale: number } {
  const safeMaxDim = Math.max(1, Math.floor(maxDim));
  const scale = Math.min(safeMaxDim / Math.max(width, height), 1);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

function quantizeRaw16ToRgba8(data: Uint16Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i++) {
    rgba[i] = Math.max(0, Math.min(255, Math.round(data[i] / 257)));
  }
  return rgba;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function rasterSourceToCanvas(source: RasterSource): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create a canvas context for raster conversion.');
  }

  if (source.kind === 'bitmap') {
    ctx.drawImage(source.bitmap, 0, 0, source.width, source.height);
    return canvas;
  }

  const quantized = quantizeRaw16ToRgba8(source.data);
  const imageBytes = new Uint8ClampedArray(quantized.length);
  imageBytes.set(quantized);
  const imageData = new ImageData(imageBytes, source.width, source.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function scaleRawRgba16(
  data: Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint16Array {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return new Uint16Array(data);
  }

  const out = new Uint16Array(targetWidth * targetHeight * 4);
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    const srcY = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, srcY - y0));

    for (let x = 0; x < targetWidth; x++) {
      const srcX = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, srcX - x0));

      const dstOffset = (y * targetWidth + x) * 4;
      const topLeft = (y0 * sourceWidth + x0) * 4;
      const topRight = (y0 * sourceWidth + x1) * 4;
      const bottomLeft = (y1 * sourceWidth + x0) * 4;
      const bottomRight = (y1 * sourceWidth + x1) * 4;

      for (let channel = 0; channel < 4; channel++) {
        const top = data[topLeft + channel] * (1 - fx) + data[topRight + channel] * fx;
        const bottom = data[bottomLeft + channel] * (1 - fx) + data[bottomRight + channel] * fx;
        out[dstOffset + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }

  return out;
}

export function scaleRasterSourceToMaxDim(source: RasterSource, maxDim: number): RasterSource {
  const { width, height } = getScaledRasterDimensions(source.width, source.height, maxDim);

  if (width === source.width && height === source.height) {
    return source;
  }

  if (source.kind === 'bitmap') {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create a canvas context for bitmap scaling.');
    }
    ctx.drawImage(source.bitmap, 0, 0, width, height);
    return createBitmapRasterSource(canvas);
  }

  return {
    kind: 'raw-rgba16',
    data: scaleRawRgba16(source.data, source.width, source.height, width, height),
    width,
    height,
    metadata: source.metadata,
  };
}

export function buildPreviewRasterAssets(source: RasterSource, maxDim: number): PreviewRasterAssets {
  const renderSource = scaleRasterSourceToMaxDim(source, maxDim);
  return {
    renderSource,
    analysisCanvas: rasterSourceToCanvas(renderSource),
  };
}