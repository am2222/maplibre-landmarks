import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'maplibre-landmarks',
  description:
    '3D landmarks, roof shapes, trees, fog and water for MapLibre GL JS, rendered with three.js',
  base: '/maplibre-landmarks/',
  cleanUrls: true,
  srcExclude: ['superpowers/**'],
  // The demo and the roof gallery are built next to the site, outside VitePress.
  ignoreDeadLinks: [/^\/demo\//],
  head: [['meta', { name: 'theme-color', content: '#3c6e8f' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Demo', link: '/demo/', target: '_blank' },
      { text: 'Roof gallery', link: '/demo/roofs-gallery.html', target: '_blank' },
      { text: 'npm', link: 'https://www.npmjs.com/package/maplibre-landmarks' },
    ],
    sidebar: [
      { text: 'Getting started', link: '/guide/getting-started' },
      {
        text: 'Layers',
        items: [
          { text: 'Landmarks', link: '/guide/landmarks' },
          { text: 'Roof shapes', link: '/guide/roofs' },
          { text: 'Roof attributes', link: '/guide/roof-attributes' },
          { text: 'Trees', link: '/guide/trees' },
          { text: 'Volumetric fog', link: '/guide/fog' },
          { text: 'Water', link: '/guide/water' },
        ],
      },
      { text: 'Development', link: '/guide/development' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/am2222/maplibre-landmarks' }],
    search: { provider: 'local' },
    footer: {
      message:
        'MIT licensed. Models: Open Landmarks; map data © OpenStreetMap contributors and Overture Maps Foundation.',
    },
  },
});
