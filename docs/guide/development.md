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

## How layers use tiles

Trees, water, roofs and landmark replacement build each source tile once, when MapLibre loads
it, and keep the result until the tile goes (as MapLibre does for its own layers). A shared
`TileFeed` (`src/core/tileFeed.ts`) turns the source into per-tile callbacks:

- **Arrivals:** MapLibre's `sourcedata` event carries the loaded tile; only that tile is read
  (`tile.querySourceFeatures`).
- **Departures:** when the camera settles, the feed holds exactly the tiles the source's tile
  manager renders, so tiles that left the view or were replaced on zooming are dropped.
- **Inactive layers** (below `minZoom`, no source) suspend their feeds and hold nothing.

Moving the camera then costs drawing plus a cheap selection; a new tile costs its own work.
Both hooks are MapLibre internals. Without them the feed falls back to the public
`map.querySourceFeatures`, grouped by tile: everything still works, as slowly as before.
`tests/browser/tileFeed.pw.ts` fails when a MapLibre upgrade breaks the fast path.

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

## One-time repository setup

For the workflows in `.github/workflows` to run:

- **Pages:** Settings → Pages → Source: **GitHub Actions**.
- **Basemap key:** add a `PROTOMAPS_KEY` repository secret, and allow
  `https://am2222.github.io` in the key's origins on protomaps.com.
- **Release pull requests:** Settings → Actions → General → enable **Allow GitHub Actions to
  create and approve pull requests** (release-please opens its PR with the workflow token).
- **npm (trusted publishing, no tokens):** npm can only trust a workflow for a package that
  exists, so publish the first version by hand, then link the workflow:
  1. On `main` at version 0.1.0: `npm login`, `npm pack --dry-run` (check the files), then
     `npm publish` (builds first through `prepublishOnly`).
  2. On npmjs.com → the package → Settings → Trusted publisher → GitHub Actions: owner
     `am2222`, repository `maplibre-landmarks`, workflow `release-please.yml`.
  3. Merge the "release 0.1.0" pull request: the publish job sees 0.1.0 on npm and skips it.
     Every later release is published by the workflow over OIDC, with provenance (the
     repository must be public for provenance).

Under `npm run docs:dev` the embedded demo frames show a 404: the demo is only built by
`npm run docs:build`; use `npm run docs:preview` to see them.

