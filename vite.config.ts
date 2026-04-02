import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['libraw-wasm'],
  },
});
