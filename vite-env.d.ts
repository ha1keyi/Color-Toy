/// <reference types="vite/client" />

declare module '*.glsl' {
  const value: string;
  export default value;
}

declare module 'libraw-wasm' {
  interface LibRawOpenSettings {
    outputColor?: number;
    outputBps?: 8 | 16;
    noAutoBright?: boolean;
    useCameraWb?: boolean;
    useCameraMatrix?: number;
    highlight?: number;
    userQual?: number;
  }

  interface LibRawInstance {
    open(data: Uint8Array, settings?: LibRawOpenSettings): Promise<unknown>;
    metadata(fullOutput?: boolean): Promise<Record<string, unknown>>;
    imageData(): Promise<Uint8Array | Uint16Array>;
  }

  const LibRaw: {
    new (): LibRawInstance;
  };

  export default LibRaw;
}
