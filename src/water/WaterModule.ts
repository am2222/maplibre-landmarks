import type { Map as MlMap } from 'maplibre-gl';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import { pointInPolygons, polygonsOf } from '../core/geometry';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition, mercatorUnitsPerMetre, originAt } from '../core/mercator';
import { THEMES, type Theme } from '../core/theme';
import type { LngLat, Origin, ViewState } from '../core/types';
import { noiseOrigin } from '../fog/slices';
import { FlowIndex, segmentsOf } from './flow';
import { buildPiece, latitudeOf, longitudeOf, type WaterPiece } from './geometry';
import { flatLevel, levelGroups } from './levels';
import { TIME_PERIOD_S, WATER_FRAGMENT, WATER_VERTEX } from './shaders';
import { WATER_STYLES, WAVES, waterColors, waterStyle, type WaterStyle } from './styles';

export interface WaterOptions {
  /** Vector source with a water layer (default 'protomaps'), or a GeoJSON source. */
  source?: string;
  /** Source layer of a vector source (default 'water'). */
  sourceLayer?: string;
  minZoom?: number;
  /** Wave strength multiplier (0 = still). */
  waves?: number;
  /** Beyond this, the farthest pieces are dropped. */
  maxTriangles?: number;
  /** Per-style shallow colour overrides (CSS colours). */
  colors?: Partial<Record<WaterStyle, string>>;
  onError?: (err: unknown) => void;
}

export interface WaterUniforms {
  [name: string]: IUniform;
  uDeep: IUniform<Color[]>;
  uShallow: IUniform<Color[]>;
  uWave: IUniform<Vector4[]>;
  uSky: IUniform<Color>;
  uSunColor: IUniform<Color>;
  uSunDir: IUniform<Vector3>;
  uOrigin: IUniform<Vector2>;
  uNoiseScale: IUniform<number>;
  uTime: IUniform<number>;
  uWaves: IUniform<number>;
}

interface SourceFeatureLike {
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
}

/** A polygon piece from the source (one part of one tile's feature). */
interface Entry {
  /** Own signature plus the neighbours' (tile cuts depend on them). */
  key: string;
  sig: string;
  style: WaterStyle;
  props: string;
  rings: number[][][];
  /** Lng/lat bounds of the outer ring. */
  bounds: [number, number, number, number];
}

interface Built {
  piece: WaterPiece;
  sig: string;
  /** Signatures of the pieces across this piece's tile cuts. */
  links: string[];
  style: WaterStyle;
  props: string;
  /** Rivers: flow (x, z) per body vertex, then per shore vertex. */
  flow?: Float32Array;
  /** Rivers with terrain: ground per body vertex, then per shore vertex. */
  ground?: Float32Array;
  /** Lakes, sea, pools with terrain: this piece's flat level (see flatLevel). */
  level?: number | null;
}

const REBUILD_DEBOUNCE_MS = 150;
const FLOW_RADIUS_M = 300;
/** Above the ground so the water never flickers against the draped fill. */
const LIFT_M = 0.3;
const POLYGONS = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const FLOW_LINES = [
  'all',
  ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]],
  ['in', ['get', 'kind'], ['literal', ['river', 'canal']]],
];

function boundsOf(ring: number[][]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    b[0] = Math.min(b[0], x!);
    b[1] = Math.min(b[1], y!);
    b[2] = Math.max(b[2], x!);
    b[3] = Math.max(b[3], y!);
  }
  return b;
}
const touches = (a: number[], b: number[]) =>
  a[0]! <= b[2]! && b[0]! <= a[2]! && a[1]! <= b[3]! && b[1]! <= a[3]!;
const signatureOf = (rings: number[][][]) =>
  rings.map((r) => `${r.length}:${r[0]}:${r[r.length >> 1]}`).join(';');

/** Grid cell for piece lookups, degrees (about 150–220 m). */
const GRID_DEG = 0.002;
/** Pieces covering more cells than this (a sea, a big lake) are checked directly. */
const GRID_MAX_CELLS = 256;

/** Grid over piece bounds (lng/lat): pieces whose bounds touch given bounds, without all-pairs scans. */
class EntryGrid {
  private readonly cells = new Map<string, Entry[]>();
  private readonly big: Entry[] = [];

  constructor(private readonly all: Entry[]) {
    for (const e of all) {
      const [x0, y0, x1, y1] = this.range(e.bounds);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > GRID_MAX_CELLS) {
        this.big.push(e);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          const list = this.cells.get(k);
          if (list) list.push(e);
          else this.cells.set(k, [e]);
        }
    }
  }

  near(b: number[]): Entry[] {
    const [x0, y0, x1, y1] = this.range(b);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > GRID_MAX_CELLS)
      return this.all.filter((e) => touches(e.bounds, b));
    const found = new Set<Entry>(this.big);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (const e of this.cells.get(`${x},${y}`) ?? []) found.add(e);
    return [...found].filter((e) => touches(e.bounds, b));
  }

  private range(b: number[]): [number, number, number, number] {
    const c = (v: number) => Math.floor(v / GRID_DEG);
    return [c(b[0]!), c(b[1]!), c(b[2]!), c(b[3]!)];
  }
}

/** Animated, lit water drawn over the basemap's water polygons. */
export class WaterModule implements LayerModule {
  readonly uniforms: WaterUniforms;
  body?: Mesh<BufferGeometry, ShaderMaterial>;
  shore?: Mesh<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private anchor?: LngLat;
  private cache = new Map<string, Built | null>();
  /** Grid over the pieces of the current rebuild. */
  private grid?: EntryGrid;
  private drawn: Built[] = [];
  private lastFrame?: number;
  private waves: number;
  private readonly source: string;
  private readonly sourceLayer: string;
  private readonly reported = new Set<string>();

  constructor(private readonly options: WaterOptions = {}) {
    this.source = options.source ?? 'protomaps';
    this.sourceLayer = options.sourceLayer ?? 'water';
    this.waves = Math.max(0, options.waves ?? 1);
    this.uniforms = {
      uDeep: { value: WATER_STYLES.map(() => new Color()) },
      uShallow: { value: WATER_STYLES.map(() => new Color()) },
      uWave: {
        value: WATER_STYLES.map((s) => {
          const w = WAVES[s];
          return new Vector4(w.scale, w.amplitude, w.speed, w.shininess);
        }),
      },
      uSky: { value: new Color() },
      uSunColor: { value: new Color() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uOrigin: { value: new Vector2() },
      uNoiseScale: { value: 1 },
      uTime: { value: 0 },
      uWaves: { value: this.waves },
    };
    this.applyTheme('day');
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const mesh = (ribbon: boolean) => {
      const material = new ShaderMaterial({
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
        uniforms: { ...this.uniforms, uRibbon: { value: ribbon ? 1 : 0 } },
        transparent: ribbon,
        // Depth-tested against the ground, never written: layers draped after ours stay visible.
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
      });
      const m = new Mesh(new BufferGeometry(), material);
      m.frustumCulled = false;
      m.visible = false;
      ctx.scene.add(m);
      return m;
    };
    this.body = mesh(false);
    this.shore = mesh(true);
    this.themeChanged((ctx.core as { theme?: Theme }).theme ?? 'day');
    ctx.map.on('sourcedata', this.onSourceData);
    ctx.map.on('terrain', this.onTerrain);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    const [x, z, scale] = noiseOrigin(origin);
    this.uniforms.uOrigin.value.set(x, z);
    this.uniforms.uNoiseScale.value = scale;
    if (!this.anchor) return;
    for (const m of [this.body, this.shore]) {
      if (!m) continue;
      m.position.set(...localPosition(origin, this.anchor, 0));
      m.updateMatrixWorld();
    }
  }

  frame(timeMs: number): boolean {
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, (timeMs - this.lastFrame) / 1000);
    this.lastFrame = timeMs;
    this.uniforms.uTime.value = (this.uniforms.uTime.value + dt) % TIME_PERIOD_S;
    return this.waves > 0 && !!this.body?.visible;
  }

  themeChanged(theme: Theme): void {
    this.applyTheme(theme);
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    this.cache.clear();
    if (attached) this.schedule();
  }

  setWaves(waves: number): void {
    this.waves = Math.max(0, waves);
    this.uniforms.uWaves.value = this.waves;
    this.ctx?.requestRepaint();
  }

  getStats(): { pieces: number; triangles: number } {
    return {
      pieces: this.drawn.length,
      triangles: this.drawn.reduce((n, b) => n + b.piece.triangles, 0),
    };
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    clearTimeout(this.timer);
    ctx.map.off('sourcedata', this.onSourceData);
    ctx.map.off('terrain', this.onTerrain);
    for (const m of [this.body, this.shore]) {
      if (!m) continue;
      ctx.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.body = undefined;
    this.shore = undefined;
    this.ctx = undefined;
  }

  private applyTheme(theme: Theme): void {
    const colors = waterColors(theme, this.options.colors);
    WATER_STYLES.forEach((s, i) => {
      this.uniforms.uDeep.value[i]!.set(colors[s].deep);
      this.uniforms.uShallow.value[i]!.set(colors[s].shallow);
    });
    const t = THEMES[theme];
    this.uniforms.uSky.value.setHex(t.sky);
    this.uniforms.uSunColor.value.setHex(t.sunColor);
    this.uniforms.uSunDir.value.set(...t.sunDir).normalize();
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private readonly onSourceData = (e: { sourceId?: string; sourceDataType?: string }): void => {
    if (e.sourceDataType && e.sourceDataType !== 'content') return;
    const terrain = this.ctx?.map.getTerrain();
    if (terrain && e.sourceId === terrain.source) this.forgetGround();
    else if (e.sourceId !== this.source) return;
    this.schedule();
  };

  private readonly onTerrain = (): void => {
    this.forgetGround();
    this.schedule();
  };

  private forgetGround(): void {
    for (const b of this.cache.values()) {
      if (!b) continue;
      b.ground = undefined;
      b.level = undefined;
    }
  }

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const map = ctx.map;
    let drawn: Built[] = [];
    const source = map.getSource(this.source) as
      { type?: string; vectorLayerIds?: string[] } | undefined;
    if (!source) this.report('source', new Error(`source "${this.source}" not found`));
    else if (view.zoom >= (this.options.minZoom ?? 12)) drawn = this.collect(map, view, source);
    this.drawn = drawn;
    this.merge(map, view);
    ctx.requestRepaint();
  }

  private collect(
    map: MlMap,
    view: ViewState,
    source: { type?: string; vectorLayerIds?: string[] },
  ): Built[] {
    const vector = source.type === 'vector';
    if (vector && source.vectorLayerIds && !source.vectorLayerIds.includes(this.sourceLayer)) {
      this.report(
        'sourceLayer',
        new Error(`source "${this.source}" has no layer "${this.sourceLayer}"`),
      );
      return [];
    }
    const query = (filter: unknown[]) =>
      map.querySourceFeatures(this.source, {
        ...(vector ? { sourceLayer: this.sourceLayer } : {}),
        filter: filter as never,
      }) as unknown as SourceFeatureLike[];
    this.grid = undefined;
    const entries = this.entries(query(POLYGONS));
    const flow = new FlowIndex(
      segmentsOf(query(FLOW_LINES)),
      FLOW_RADIUS_M * mercatorUnitsPerMetre(view.center[1]),
    );
    const grid = this.grid ?? new EntryGrid(entries);
    const waterAt = (ll: LngLat): Entry | undefined =>
      grid.near([...ll, ...ll]).find((e) => pointInPolygons(ll, [e.rings]));
    // Nearest first: distance from the view centre to each piece's bounds (0 when inside).
    const [cx, cy] = view.center;
    const k = Math.cos((cy * Math.PI) / 180);
    const dist = (b: number[]) =>
      Math.hypot(Math.max(b[0]! - cx, 0, cx - b[2]!) * k, Math.max(b[1]! - cy, 0, cy - b[3]!));
    entries.sort((a, b) => dist(a.bounds) - dist(b.bounds));
    const max = this.options.maxTriangles ?? 300_000;
    const cache = new Map<string, Built | null>();
    const out: Built[] = [];
    let triangles = 0;
    for (const e of entries) {
      let built = this.cache.get(e.key);
      if (built === undefined) built = this.build(e, waterAt, flow);
      cache.set(e.key, built);
      if (!built) continue;
      if (triangles + built.piece.triangles > max) break;
      triangles += built.piece.triangles;
      out.push(built);
    }
    this.cache = cache;
    return out;
  }

  /** Polygon pieces (deduplicated), keyed by their own and their neighbours' signatures. */
  private entries(features: SourceFeatureLike[]): Entry[] {
    const seen = new Map<string, Entry>();
    for (const f of features) {
      const props = f.properties ?? {};
      const style = waterStyle(props, f.geometry.type);
      if (!style) continue;
      const propsKey = JSON.stringify(props);
      for (const rings of polygonsOf(f.geometry)) {
        const bounds = boundsOf(rings[0] ?? []);
        const sig = `${style}|${propsKey}|${signatureOf(rings)}|${bounds.join()}`;
        if (!seen.has(sig)) seen.set(sig, { key: sig, sig, style, props: propsKey, rings, bounds });
      }
    }
    const list = [...seen.values()];
    const grid = new EntryGrid(list);
    const keys = list.map((e) =>
      [
        e.sig,
        ...grid
          .near(e.bounds)
          .filter((o) => o !== e)
          .map((o) => o.sig)
          .sort(),
      ].join('§'),
    );
    list.forEach((e, i) => (e.key = keys[i]!));
    this.grid = grid;
    return list;
  }

  private build(
    e: Entry,
    waterAt: (ll: LngLat) => Entry | undefined,
    flow: FlowIndex,
  ): Built | null {
    try {
      // Record which pieces lie across the tile cuts: they are the same water body.
      const links = new Set<string>();
      const piece = buildPiece(e.rings, (ll) => {
        const other = waterAt(ll);
        if (other) links.add(other.sig);
        return !!other;
      });
      if (!piece) return null;
      const built: Built = { piece, sig: e.sig, links: [...links], style: e.style, props: e.props };
      if (e.style === 'river') {
        const xy = [...piece.body.xy, ...piece.shore.xy];
        const f = new Float32Array(xy.length);
        for (let i = 0; i < xy.length; i += 2) f.set(flow.at(xy[i]!, xy[i + 1]!), i);
        built.flow = f;
      }
      return built;
    } catch (err) {
      this.report(`piece:${e.sig}`, err);
      return null;
    }
  }

  /** One body and one shore geometry around the view centre. */
  private merge(map: MlMap, view: ViewState): void {
    const body = this.body;
    const shore = this.shore;
    if (!body || !shore) return;
    const terrain = !!map.getTerrain();
    const sample = (x: number, y: number) =>
      map.queryTerrainElevation([longitudeOf(x), latitudeOf(y)]) ?? null;
    // Lakes, sea and pools: the highest level of all pieces of the same water body, so the
    // whole body clears the ground.
    const levels = new Map<string, number>();
    const levelOf = new Map<Built, number>();
    if (terrain) {
      const groups = levelGroups(
        this.drawn.map((b) => ({ key: b.sig, props: b.props, links: b.links })),
      );
      this.drawn.forEach((b) => {
        if (b.style === 'river') {
          if (!b.ground) {
            const xy = [...b.piece.body.xy, ...b.piece.shore.xy];
            b.ground = new Float32Array(xy.length / 2);
            for (let j = 0; j < xy.length; j += 2)
              b.ground[j / 2] = sample(xy[j]!, xy[j + 1]!) ?? 0;
          }
          return;
        }
        if (b.level === undefined) b.level = flatLevel(b.piece.samples, sample);
        const root = groups.get(b.sig)!;
        const current = levels.get(root);
        if (b.level !== null && (current === undefined || b.level > current))
          levels.set(root, b.level);
      });
      this.drawn.forEach((b) => {
        const level = levels.get(groups.get(b.sig)!);
        if (b.style !== 'river' && level !== undefined) levelOf.set(b, level);
      });
    }
    this.anchor = view.center;
    const origin = originAt(this.anchor);
    const parts = { body: newParts(), shore: newParts() };
    for (const b of this.drawn) {
      const style = WATER_STYLES.indexOf(b.style);
      const nBody = b.piece.body.xy.length / 2;
      const height = (v: number) =>
        !terrain ? 0 : (b.style === 'river' ? b.ground![v]! : (levelOf.get(b) ?? 0)) + LIFT_M;
      const add = (
        p: Parts,
        xy: number[],
        index: number[],
        shoreValues: number[] | null,
        first: number,
      ) => {
        const base = p.positions.length / 3;
        for (let i = 0; i < xy.length; i += 2) {
          const v = first + i / 2;
          p.positions.push(
            (xy[i]! - origin.x) / origin.scale,
            height(v),
            (xy[i + 1]! - origin.y) / origin.scale,
          );
          p.shore.push(shoreValues ? shoreValues[i / 2]! : 0);
          p.style.push(style);
          p.flow.push(b.flow?.[v * 2] ?? 0, b.flow?.[v * 2 + 1] ?? 0);
        }
        for (const i of index) p.index.push(base + i);
      };
      add(parts.body, b.piece.body.xy, b.piece.body.index, null, 0);
      add(parts.shore, b.piece.shore.xy, b.piece.shore.index, b.piece.shore.shore, nBody);
    }
    upload(body, parts.body);
    upload(shore, parts.shore);
  }

  private report(key: string, err: unknown): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] water', err);
  }
}

interface Parts {
  positions: number[];
  shore: number[];
  style: number[];
  flow: number[];
  index: number[];
}
const newParts = (): Parts => ({ positions: [], shore: [], style: [], flow: [], index: [] });

function upload(mesh: Mesh<BufferGeometry, ShaderMaterial>, p: Parts): void {
  const g = mesh.geometry;
  g.setAttribute('position', new Float32BufferAttribute(p.positions, 3));
  g.setAttribute('aShore', new Float32BufferAttribute(p.shore, 1));
  g.setAttribute('aStyle', new Float32BufferAttribute(p.style, 1));
  g.setAttribute('aFlow', new Float32BufferAttribute(p.flow, 2));
  g.setIndex(p.index);
  g.computeBoundingSphere();
  mesh.visible = p.index.length > 0;
}
