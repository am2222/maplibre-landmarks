import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'maplibre-landmarks' },
    sourcemap: true,
    rollupOptions: {
      external: ['maplibre-gl', 'three', /^three\//],
    },
  },
  plugins: [dts({ include: ['src'], entryRoot: 'src' })],
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
