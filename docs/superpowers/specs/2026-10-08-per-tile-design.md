# maplibre-landmarks: Per-Tile Pipelines

Date: 2026-10-08
Status: Draft for review
Branch: `refactor/per-tile` (from `feat/theme-sky` 5346982)

## 1. Goal

Move the four data-driven layers (trees, water, roofs, landmark building replacement) from
"re-read every loaded tile on every update" to "process each tile once when it arrives, keep the
result while the tile is loaded, drop it when the tile goes", as MapLibre does for its own
fill-extrusion buildings. Moving the camera then costs only drawing (plus a cheap selection when
it settles); a new tile costs only its own work.

### Why

Profiles (Eiffel Tower, M3 Pro GPU, all layers on) show the remaining lag is main-thread work
repeated over all loaded tiles on every `sourcedata` / `moveend`: `querySourceFeatures`, geometry
decoding, polygon tests. Low, near-horizontal views load many tiles toward the horizon and make
it worse (pitch-85 pan: 0.42–0.47 s of long tasks after the earlier fixes, worst ~80 ms).

### Decisions made

- **Approach A:** per-tile caching on the main thread. A Web Worker (approach B) only if new
  tiles still cause hitches afterwards; MapLibre's own workers (C) have no public hook.
- **All four layers** in this round: trees, water, roofs, landmark replacement.
- **MapLibre internals, with a fallback:** per-tile queries use the tile object carried by the
  public `sourcedata` event (`tile.querySourceFeatures`) and the tile coordinates on features
  (`_x`, `_y`, `_z`). When missing, the feed falls back to the public `querySourceFeatures` and
  groups features by tile, which costs what today's code costs. A browser test pins the fast
  path so a MapLibre upgrade that breaks it fails loudly.

### Non-goals

- Web Workers; moving geometry building off the main thread.
- Changing what the layers draw, except the per-piece tree skip check (3.2).
- New public options beyond those needed to keep current behaviour.

## 2. `TileFeed` (`src/core/tileFeed.ts`)

One feed per (map, source, source layer, filter), created by a module:

```ts
const feed = new TileFeed(map, {
  source: 'protomaps',
  sourceLayer: 'landuse',          // undefined for GeoJSON sources
  filter: [...],                   // optional MapLibre filter
  onTile(key: string, features: SourceFeatureLike[]): void,
  onDrop(key: string): void,
});
feed.keys(): string[];                         // tiles currently held
feed.featuresOf(key: string): SourceFeatureLike[] | undefined;  // re-query a held tile
feed.reset(): void;                            // style swap: drop everything, start over
feed.dispose(): void;
```

- **Keys** are canonical tile ids (`z/x/y` of the data tile). Overscaled tiles (zoom 18 showing
  Protomaps z15 data) share their canonical key, so a data tile is processed once.
- **Arrivals:** on `sourcedata` for the source with a `tile` (MapLibre fires one per loaded
  tile), the feed queries that tile only (`tile.querySourceFeatures(result, { sourceLayer,
  filter })`) and calls `onTile`. A tile already held with the same data is ignored; a reloaded
  tile calls `onDrop` then `onTile`.
- **Departures:** MapLibre fires no event. After the camera settles (`moveend`, debounced like
  module updates), the feed computes the canonical tiles covering the view bounds at the
  source's data zoom, plus one ring, and calls `onDrop` for held tiles outside that set. A cap
  (default 256 held tiles) drops the farthest first.
- **Fallback:** when the event carries no tile or the tile has no `querySourceFeatures`, the
  feed runs the public `map.querySourceFeatures` once per settle, groups features by
  `_x/_y/_z` (or treats everything as one pseudo-tile `*` if those are missing too) and diffs
  the groups against what it holds.
- **Style swap / source removed:** `reset()` drops every tile (`onDrop`), then arrivals start
  again.

## 3. Layers

### 3.1 Common shape

Each module keeps `Map<tileKey, TileResult>`; `onTile` builds a result, `onDrop` disposes it.
`update(view)` (camera settled) no longer queries the source; it only selects/budgets among
cached results and refreshes per-frame state.

### 3.2 Trees (`src/trees`)

- `onTile` (points feed: `pois` kind=tree; polygons feed: `landuse` green kinds): the tile's
  mapped trees and its polygon pieces; scatter each piece (`scatterPiece`, deterministic per
  piece, so a polygon split across tiles comes out as today). Candidates per tile in compact
  arrays (keys, mercator x/y).
- **Behaviour change:** the "already has enough mapped trees" skip becomes per piece (mapped
  trees inside the piece vs its target density) instead of per whole polygon. Mapped trees only
  exist in z15 tiles, so this only matters from zoom 15.
- `update`: zoom thinning (unchanged rule) and the nearest `maxTrees` across all cached tiles
  by quickselect, then instance buffers. No tile queries.
- Drop: forget the tile's candidates.

### 3.3 Water (`src/water`)

- `onTile` (polygons and river lines of the water layer): build that tile's pieces (body, shore
  ribbons, flow) into one mesh per tile, positioned relative to the tile's corner (float
  precision).
- **Cut edges:** a piece edge counts as a cut only when the neighbouring tile is held. When a
  tile arrives, the pieces of its 8 neighbours re-check their cut edges and rebuild if any
  changed (fixes today's transient foam line at the edge of loaded tiles).
- Terrain heights per piece at arrival; recomputed when DEM data arrives. Lake pieces share a
  level through the existing tile-cut links (now across tile results).
- Budget: whole tiles, nearest first (`maxTriangles`).
- Drop: dispose the tile mesh.

### 3.4 Roofs (`src/roofs`)

- Pieces per building per tile: `Map<buildingKey, Map<tileKey, polygons>>` (building key =
  source layer + id). Arrival adds the tile's roofed buildings and marks them changed; drop
  removes the tile's pieces, marking those buildings changed (a building with no pieces left
  loses its roof).
- Only changed buildings are rebuilt (union, then `buildRoof`); the existing roof cache by
  signature stays.
- **Split-building rule:** a roof belongs to the tile containing its merged footprint's centre;
  meshes are per owner tile. A completed or shrunk building whose owner changes moves to the
  other tile's mesh; only the tiles involved rebuild.
- Wall shortening (feature-state per building and source layer) and the landmark exemption
  (no roof on claimed buildings) are unchanged.
- Budget: `maxBuildings`, nearest owner tiles first.

### 3.5 Landmark replacement (`src/landmarks/replacement.ts`)

- On arrival: check only that tile's buildings against the current landmark regions (far-tile
  skip, centre inside, or ≥ 40% inside); claims stored per tile.
- On drop: the tile's claims go, unless another held tile claims the same building.
- On a change of landmark regions: re-check only held tiles overlapping the changed regions,
  through `feed.featuresOf(key)`. No decoded geometry is stored between checks.
- Listeners (roofs) are notified when the claimed set changes, as today.

## 4. Error handling

| Situation                                          | Behaviour                                                   |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Internals missing (`tile.querySourceFeatures`)     | Fallback path; logged once in development builds            |
| `_x/_y/_z` missing on features                     | Fallback treats the source as one pseudo-tile               |
| Tile reloads (expiry, style data change)           | `onDrop` then `onTile`                                      |
| Style swap / source removed                        | `reset()`: everything dropped, rebuilt as tiles arrive      |
| Building or lake split across tiles, one side only | Built from the pieces seen; rebuilt when the other arrives  |

## 5. Testing

- **Unit, with a fake feed / fake tiles:** arrivals and drops; overscaled keys; fallback path;
  a building split across two tiles (owner tile, roof rebuilt when the second arrives, removed
  when both drop); a lake split across tiles (cut edges re-checked when the neighbour arrives);
  a landmark loading after its tiles; claims surviving the drop of one of two tiles.
- **Equivalence:** for each layer, the per-tile result on fixture data equals the current
  whole-view result (trees excepted for the per-piece skip).
- **Browser:** a test that loads real tiles in the e2e page and asserts the fast path is used
  (the feed reports per-tile arrivals), so a MapLibre change fails loudly.
- **Performance:** the existing runs (Eiffel Tower orbit, pitch-85 forward pan), before and
  after; target: no long task over 50 ms during movement once tiles are loaded.
