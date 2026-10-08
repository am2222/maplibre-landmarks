import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// DEMO_SITE=1: the demo and roof gallery for the documentation site (GitHub Pages), served
// under /maplibre-landmarks/demo/ next to the VitePress build. The e2e pages are not published.
const site = process.env.DEMO_SITE === '1';
const page = (name: string) => resolve(import.meta.dirname, name);

export default defineConfig({
  root: resolve(import.meta.dirname),
  envDir: resolve(import.meta.dirname, '..'),
  base: site ? '/maplibre-landmarks/demo/' : '/',
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
    outDir: site
      ? resolve(import.meta.dirname, '../docs/.vitepress/dist/demo')
      : resolve(import.meta.dirname, '../dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: site
        ? { main: page('index.html'), roofs: page('roofs-gallery.html') }
        : {
            main: page('index.html'),
            e2e: page('e2e.html'),
            trees: page('e2e-trees.html'),
            roofs: page('roofs-gallery.html'),
          },
    },
  },
});
