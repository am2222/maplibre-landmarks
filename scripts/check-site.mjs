// Checks the built site: guide pages, the demo and the roof gallery, and demo asset URLs.
import { existsSync, readFileSync } from 'node:fs';

const dist = 'docs/.vitepress/dist';
const base = '/maplibre-landmarks/';
const pages = [
  'index.html',
  'guide/getting-started.html',
  'guide/landmarks.html',
  'guide/roofs.html',
  'guide/roof-attributes.html',
  'guide/trees.html',
  'guide/fog.html',
  'guide/rain.html',
  'guide/snow.html',
  'guide/water.html',
  'guide/development.html',
  'demo/index.html',
  'demo/roofs-gallery.html',
  'demo/tree-seasons.html',
];
const problems = pages.filter((p) => !existsSync(`${dist}/${p}`)).map((p) => `missing ${p}`);
if (existsSync(`${dist}/superpowers`)) problems.push('docs/superpowers was published');
for (const page of ['demo/index.html', 'demo/roofs-gallery.html', 'demo/tree-seasons.html']) {
  if (!existsSync(`${dist}/${page}`)) continue;
  const html = readFileSync(`${dist}/${page}`, 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"]*)"/g))
    if (!url.startsWith(`${base}demo/`)) problems.push(`${page}: ${url} is outside ${base}demo/`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('site ok');
