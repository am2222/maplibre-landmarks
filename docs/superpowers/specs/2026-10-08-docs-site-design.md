# maplibre-landmarks: Documentation Site, Hosted Demo and Releases

Date: 2026-10-08
Status: Draft for review
Builds on: the roof-parts work (`feat/roof-parts`: Overture's official tiles as the demo default)

## 1. Goal

One public site at `https://am2222.github.io/maplibre-landmarks/` where people read the
documentation and try everything live: a VitePress guide, the full demo and the roof-types
gallery. Releases are automated: release-please turns conventional commits into a release pull
request (version bump and changelog); merging it publishes the package to npm.

### Decisions made

- **Hosting: GitHub Pages**, deployed by GitHub Actions on every push to `main`.
- **Approach A:** the existing Vite demo and roof gallery are built as they are and served next to
  the VitePress pages, which embed them in frames and link to them. No demo code moves into Vue.
- **Workflows:** CI, docs deploy and release-please (with npm publish), all GitHub Actions.

### Precondition

The roof-parts work is committed to `main` first (or this work starts on top of it): the hosted
demo has no local roof tileset, so its roofs come from Overture's official tiles.

### Non-goals

- Versioned docs (one version, the latest `main`).
- API reference generated from TypeScript (the guide documents options in tables, as today).
- Preview deploys for pull requests.

## 2. Site

### 2.1 Layout (`docs/`)

```
docs/
  .vitepress/config.ts      title, base '/maplibre-landmarks/', nav, sidebar, local search, GitHub link
  index.md                  home: hero, feature list, embedded demo
  guide/getting-started.md  install (npm, CDN + import map), first map, themes (setTheme)
  guide/landmarks.md        LandmarksLayer options, replaceBuildings, label occlusion
  guide/roofs.md            RoofsLayer, Overture's official tiles, building your own tileset,
                            embedded roof gallery
  guide/roof-attributes.md  the current docs/roofs.md (attribute and shape reference), moved
  guide/trees.md            TreesLayer, custom tree models
  guide/fog.md              FogLayer
  guide/water.md            WaterLayer
  guide/development.md      scripts, tests, extending (LayerModule), contributing, releases
  public/                   images if needed
```

Content comes from the README sections, split by topic and kept in sync from now on by editing
the guide. `docs/superpowers/` stays where it is and is excluded from the site
(`srcExclude: ['superpowers/**']`).

### 2.2 Navigation

- Top bar: **Guide** (`/guide/getting-started`), **Demo** (`/demo/`, new tab), **Roof gallery**
  (`/demo/roofs-gallery.html`, new tab), **npm**, GitHub icon.
- Sidebar: Getting started; Layers (Landmarks, Roof shapes, Roof attributes, Trees, Fog,
  Water); Development.
- Local search (VitePress built-in).

### 2.3 Embedded demo and gallery

A small Vue component `DemoFrame` (`docs/.vitepress/theme/DemoFrame.vue`) renders a responsive
16:10 iframe for a path under the site base (`withBase`), with a "Open full screen" link. Used on
the home page (`/demo/`) and on the Roof shapes page (`/demo/roofs-gallery.html`). The frames load
lazily (`loading="lazy"`).

### 2.4 Build

- `npm run docs:dev` / `docs:build` / `docs:preview` (VitePress).
- `docs:build` = `vitepress build docs` then the demo build into `docs/.vitepress/dist/demo`:
  `vite build --config demo/vite.config.ts` with `DEMO_SITE=1`, which sets
  `base: '/maplibre-landmarks/demo/'`, `outDir: docs/.vitepress/dist/demo`, and only the `main`
  and `roofs` inputs (the e2e pages are test-only and not published). Without `DEMO_SITE` the
  demo config is unchanged.
- VitePress fails the build on dead links (its default), which keeps the guide's links honest.
- `VITE_PROTOMAPS_KEY` comes from the environment at build time (a repository secret in CI).

## 3. Workflows (`.github/workflows/`)

### 3.1 `ci.yml` (pull requests and pushes to `main`)

Node 22, `npm ci`, then: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`,
`npm run docs:build` (without a key: the demo shows its "set a key" message; the build still
proves the site compiles and links resolve). A second job runs the browser tests that use fixed
local scenes (`water`, `fog`, `roofs`) with Playwright's Chromium; the landmarks and labels
browser tests call the Open Landmarks API, which rate-limits test runs, so they stay local-only.

### 3.2 `docs.yml` (pushes to `main`, manual dispatch)

Builds the site with `VITE_PROTOMAPS_KEY: ${{ secrets.PROTOMAPS_KEY }}`, uploads
`docs/.vitepress/dist` with `actions/upload-pages-artifact`, deploys with
`actions/deploy-pages`. Permissions: `pages: write`, `id-token: write`, `contents: read`.
Concurrency group `pages` (a newer push cancels an older deploy).

One-time setup (by the maintainer): repository Settings → Pages → Source: GitHub Actions; add
the `PROTOMAPS_KEY` secret; allow `https://am2222.github.io` in the Protomaps key's origins.

### 3.3 `release-please.yml` (pushes to `main`)

- `googleapis/release-please-action@v4` with `release-type: node`, reading
  `release-please-config.json` and `.release-please-manifest.json` (`{ ".": "0.1.0" }`). It keeps
  a release pull request open with the next version (from `feat:` / `fix:` / `feat!:` commits)
  and `CHANGELOG.md`; merging it tags `vX.Y.Z` and creates the GitHub release.
- When a release was created: a `publish` job (Node 22, `registry-url:
  https://registry.npmjs.org`) runs `npm ci`, `npm test`, `npm run build`, then
  `npm publish --provenance --access public`. Permissions: `id-token: write` (provenance and
  npm trusted publishing), `contents: read`.
- Auth: npm trusted publishing (OIDC, no stored token) once the package exists on npm. The very
  first publish of a new package needs a token: the job uses `NODE_AUTH_TOKEN:
  ${{ secrets.NPM_TOKEN }}` when that secret is set, so the maintainer adds it for the first
  release, then configures the trusted publisher on npmjs.com and deletes the secret.
- Pre-1.0: `bump-minor-pre-major: true` (a breaking change bumps 0.x minor, not 1.0).
- Known limit: pull requests opened by `GITHUB_TOKEN` do not trigger other workflows, so CI does
  not run on the release PR itself (its content is only version and changelog). A personal token
  would change that; not set up here.

## 4. Package

`package.json` additions:

- `repository` (`git+https://github.com/am2222/maplibre-landmarks.git`), `homepage` (the site),
  `bugs`, `keywords` (maplibre, maplibre-gl, threejs, 3d, landmarks, buildings, roofs, trees,
  fog, water).
- `publishConfig: { access: 'public', provenance: true }`.
- `files: ['dist', 'LICENSE']` (README and package.json are always included).
- Scripts: `prepublishOnly: npm run build`, `docs:dev`, `docs:build`, `docs:preview`.
- Peer ranges raised to what is tested: `maplibre-gl >=6.13.0`, `three >=0.186.0`.
- Dev dependency: `vitepress`.

README: shortened to a description, the install line, a minimal example, links to the site
(guide, demo, roof gallery) and the licence/attribution section. Details live in the guide.

## 5. Error handling and edge cases

| Situation                                   | Behaviour                                                        |
| ------------------------------------------- | ---------------------------------------------------------------- |
| No `PROTOMAPS_KEY` secret                   | Site deploys; the demo page shows its existing "set a key" note  |
| Key not allowed for the Pages origin        | Basemap tiles fail; documented in the one-time setup             |
| Dead link in the guide                      | `docs:build` fails in CI                                         |
| First npm release without `NPM_TOKEN`       | Publish job fails with npm's auth error; release notes say why   |
| Demo asset paths under the `/demo/` base     | Vite rewrites them from `base`; checked by the built-site check  |

## 6. Testing

- `docs:build` in CI (VitePress compile, dead links).
- A built-site check (`scripts/check-site.mjs`, run after `docs:build`): the output has
  `index.html`, every guide page, `demo/index.html` and `demo/roofs-gallery.html`, and the demo
  HTML references its assets under `/maplibre-landmarks/demo/`.
- Workflows validated with `actionlint` locally if available; otherwise by the first run.
- Visual check: `docs:preview` serves the site; open the home page, a guide page, the embedded
  gallery and the full-screen demo.
