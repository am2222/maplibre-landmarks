# Development

```bash
npm install
npm test               # unit tests
npm run test:browser   # Playwright, uses the live Open Landmarks API
cp .env.example .env.local   # add a Protomaps key for the demo
npm run dev            # demo at http://localhost:5179
npm run build
```

## Extending

`ModuleLayer` + `LayerModule` let other 3D content share the same Three.js renderer:
implement `onAdd`, `update(view)`, `place(origin)`, optional `frame(time)` and `onRemove`, and
wrap it in `new ModuleLayer(id, module)`. Coordinates are metres in glTF axes (X east, Y up, Z south)
relative to the per-frame `origin`; use `localPosition(origin, lngLat, elevation)`.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`,
`fix:`, `feat!:` for breaking changes). On every push to `main`, release-please keeps a release
pull request open with the next version and the changelog; merging it tags the release and
publishes the package to npm with provenance. Before 1.0, breaking changes bump the minor
version.

## Documentation site

`npm run docs:dev` serves this guide; `npm run docs:build` builds the guide and the demo into
`docs/.vitepress/dist` (the demo needs `VITE_PROTOMAPS_KEY` for its basemap); `npm run
docs:preview` serves the result. Pushes to `main` deploy it to GitHub Pages.
