import type { RawRasterSource } from './rasterSource';

const SUPPORTED_RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'nef']);

type RawPixelBuffer = Uint8Array | Uint16Array;

interface LibRawOpenSettings {
  outputColor?: number;
  outputBps?: 8 | 16;
  noAutoBright?: boolean;
  useCameraWb?: boolean;
  useCameraMatrix?: number;
  highlight?: number;
  userQual?: number;
}

interface LibRawMetadata extends Record<string, unknown> {
  sizes?: Record<string, unknown>;
  make?: string;
  model?: string;
}

interface LibRawInstance {
  open(data: Uint8Array, settings?: LibRawOpenSettings): Promise<unknown>;
  metadata(fullOutput?: boolean): Promise<LibRawMetadata>;
  imageData(): Promise<RawPixelBuffer>;
}

interface LibRawConstructor {
  new (): LibRawInstance;
}

export interface DecodedRawImage extends RawRasterSource {
  metadata: LibRawMetadata;
}

const DEFAULT_RAW_SETTINGS: LibRawOpenSettings = {
  outputColor: 1,
  outputBps: 16,
  noAutoBright: true,
  useCameraWb: true,
  useCameraMatrix: 3,
  highlight: 5,
  userQual: 3,
};

let decoderCtorPromise: Promise<LibRawConstructor> | null = null;

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot < 0 || lastDot === fileName.length - 1) {
    return '';
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function readPathNumber(source: Record<string, unknown> | undefined, path: string): number | null {
  if (!source) {
    return null;
  }

  const segments = path.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return readNumber(current);
}

function resolveDecodedDimensions(metadata: LibRawMetadata, sampleCount: number): { width: number; height: number; channels: number } {
  const candidatePairs: Array<[string, string]> = [
    ['sizes.width', 'sizes.height'],
    ['sizes.iwidth', 'sizes.iheight'],
    ['width', 'height'],
    ['iwidth', 'iheight'],
    ['sizes.raw_width', 'sizes.raw_height'],
    ['raw_width', 'raw_height'],
  ];

  for (const [widthPath, heightPath] of candidatePairs) {
    const width = readPathNumber(metadata, widthPath);
    const height = readPathNumber(metadata, heightPath);
    if (!width || !height) {
      continue;
    }

    for (const channels of [3, 4]) {
      if (width * height * channels === sampleCount) {
        return { width, height, channels };
      }
    }
  }

  for (const [widthPath, heightPath] of candidatePairs) {
    const width = readPathNumber(metadata, widthPath);
    const height = readPathNumber(metadata, heightPath);
    if (!width || !height) {
      continue;
    }

    const channels = Math.max(1, Math.round(sampleCount / (width * height)));
    if (channels === 3 || channels === 4) {
      return { width, height, channels };
    }
  }

  throw new Error('RAW decode succeeded but decoded dimensions could not be resolved.');
}

function convertRgbBufferToRgba16(buffer: RawPixelBuffer, width: number, height: number, channels: number): Uint16Array {
  const pixels = width * height;
  const rgba = new Uint16Array(pixels * 4);
  const is16Bit = buffer instanceof Uint16Array;
  const normalize = is16Bit
    ? (value: number) => Math.max(0, Math.min(65535, value))
    : (value: number) => Math.max(0, Math.min(65535, value * 257));

  for (let i = 0; i < pixels; i++) {
    const src = i * channels;
    const dst = i * 4;
    rgba[dst] = normalize(buffer[src] ?? 0);
    rgba[dst + 1] = normalize(buffer[src + 1] ?? buffer[src] ?? 0);
    rgba[dst + 2] = normalize(buffer[src + 2] ?? buffer[src] ?? 0);
    rgba[dst + 3] = channels >= 4 ? normalize(buffer[src + 3] ?? 65535) : 65535;
  }

  return rgba;
}

async function getDecoderConstructor(): Promise<LibRawConstructor> {
  if (!decoderCtorPromise) {
    decoderCtorPromise = import('libraw-wasm')
      .then((module) => module.default as LibRawConstructor)
      .catch((error) => {
        decoderCtorPromise = null;
        throw error;
      });
  }
  return decoderCtorPromise;
}

async function createDecoder(): Promise<LibRawInstance> {
  const LibRaw = await getDecoderConstructor();
  return new LibRaw();
}

export function isSupportedRawFile(file: File): boolean {
  return SUPPORTED_RAW_EXTENSIONS.has(getFileExtension(file.name));
}

export function getSupportedRawExtensions(): string[] {
  return Array.from(SUPPORTED_RAW_EXTENSIONS);
}

export async function decodeRawFile(file: File): Promise<DecodedRawImage> {
  if (!isSupportedRawFile(file)) {
    throw new Error('Unsupported RAW format. Supported formats: CR2, CR3, NEF.');
  }

  const decoder = await createDecoder();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await decoder.open(bytes, DEFAULT_RAW_SETTINGS);

  let metadata: LibRawMetadata = {};
  try {
    metadata = await decoder.metadata(true);
  } catch {
    metadata = await decoder.metadata(false);
  }

  const pixelBuffer = await decoder.imageData();
  const { width, height, channels } = resolveDecodedDimensions(metadata, pixelBuffer.length);
  const data = convertRgbBufferToRgba16(pixelBuffer, width, height, channels);

  return {
    kind: 'raw-rgba16',
    data,
    width,
    height,
    metadata,
  };
}