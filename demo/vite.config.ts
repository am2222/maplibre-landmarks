import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname),
  envDir: resolve(import.meta.dirname, '..'),
  server: {
    port: 5179,
    strictPort: true,
    // Keyless local dev: Protomaps daily planet builds have no CORS headers, so proxy them.
    // VITE_PMTILES_URL=http://localhost:5179/protomaps-build/<YYYYMMDD>.pmtiles
    proxy: {
      '/protomaps-build': {
        target: 'https://build.protomaps.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/protomaps-build/, ''),
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        e2e: resolve(import.meta.dirname, 'e2e.html'),
        trees: resolve(import.meta.dirname, 'e2e-trees.html'),
      },
    },
  },
});
