import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition, originAt } from '../core/mercator';
import { TileFeed, type FeedFeature, type FeedMap } from '../core/tileFeed';
import type { LngLat, Origin, ViewState } from '../core/types';
import { MeshBuilder, type RGB } from '../roofs/geometry/mesh';
import { basin, slab, strip, type Vec2 } from './areas';
import {
  directionDeg,
  hashedTurnDeg,
  PROP_COLOURS,
  PROP_KINDS,
  propGeometry,
  propScale,
  type PropKind,
} from './props';

export interface StreetFurnitureOptions {
  /** Vector source with Overture's `base` schema (`infrastructure` layer). */
  source: string;
  /** Source layer holding the props (default 'infrastructure'). */
  sourceLayer?: string;
  /** Props appear from this zoom (default 16: they are under 2 m tall). */
  minZoom?: number;
  /** Nearest props drawn per kind at most (default 1500). */
  maxPerKind?: number;
  /** Kinds to draw (default all). */
  kinds?: PropKind[];
  /** Pitched views draw props only to about three screen heights away (default true). */
  farCutoff?: boolean;
  /** Fountain basins, platforms and pier decks (default true). */
  areas?: boolean;
  onError?: (err: unknown) => void;
}

export interface StreetFurnitureStats {
  total: number;
  byKind: Partial<Record<PropKind, number>>;
  /** Fountain basins, platforms and pier decks drawn. */
  areas: number;
}

interface Prop {
  kind: PropKind;
  /** Overture's id: the same prop in every tile and zoom (its position is quantised per tile). */
  id?: string;
  lngLat: LngLat;
  /** Degrees clockwise from north the prop's front faces. */
  facing: number;
  /** Size from its tags (masts and tanks); 1 for the rest. */
  scale: [number, number, number];
}

type AreaClass = 'fountain' | 'platform' | 'pier';

/** A fountain basin, platform or pier: an outline (rings) or a line (piers). */
interface Area {
  cls: AreaClass;
  id?: string;
  rings?: LngLat[][];
  line?: LngLat[];
  centre: LngLat;
  /** Square metres (or the length for lines): the biggest clipped piece of an area wins. */
  size: number;
  tags: Record<string, unknown>;
}

const AREA_CLASSES: AreaClass[] = ['fountain', 'platform', 'pier'];
const REBUILD_DEBOUNCE_MS = 150;
const M_PER_DEG = 111_320;

const linear = (hex: number): RGB => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const STONE = linear(0xb7b2a6);
const WATER = linear(0x4f86a8);
const RAIL_PLATFORM = linear(0x9b9890);
const BUS_PLATFORM = linear(0xa8a49b);
const DECK = linear(0x8a6f52);

const num = (v: unknown): number | undefined => {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Platforms indoors, below ground or underground are not seen from the street. */
const hidden = (tags: Record<string, unknown>) =>
  String(tags.indoor ?? '') === 'yes' ||
  String(tags.location ?? '') === 'underground' ||
  (Number.parseFloat(String(tags.level ?? '0')) || 0) < 0;

/** Shoelace area (m²) and centroid of an outer ring in lng/lat. */
function ringArea(ring: LngLat[]): { area: number; centre: LngLat } {
  const lat0 = ring[0]?.[1] ?? 0;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    const cross = x0 * kx * (y1 * M_PER_DEG) - x1 * kx * (y0 * M_PER_DEG);
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-9) return { area: 0, centre: ring[0] ?? [0, 0] };
  return { area: Math.abs(a) / 2, centre: [cx / (3 * a), cy / (3 * a)] };
}

const tagsOf = (f: FeedFeature): Record<string, unknown> => {
  try {
    return JSON.parse(String(f.properties?.source_tags ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Benches, bins, bollards, hydrants and other street furniture, instanced per kind. */
export class StreetFurnitureModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly group = new Group();
  private readonly meshes = new Map<PropKind, InstancedMesh>();
  private areasMesh?: Mesh<BufferGeometry, MeshStandardMaterial>;
  private feed?: TileFeed;
  private readonly tiles = new Map<string, { props: Prop[]; areas: Area[] }>();
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: StreetFurnitureStats = { total: 0, byKind: {}, areas: 0 };
  private reported = false;
  private readonly kinds: PropKind[];

  constructor(private readonly options: StreetFurnitureOptions) {
    this.group.name = 'street-furniture';
    // Once each: a kind listed twice would get two meshes and overfill one.
    this.kinds = [...new Set(options.kinds ?? PROP_KINDS)];
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    for (const kind of this.kinds) {
      const material = new MeshStandardMaterial({ color: PROP_COLOURS[kind], roughness: 0.8 });
      const mesh = new InstancedMesh(propGeometry(kind), material, this.maxPerKind);
      mesh.name = kind;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
    if (this.options.areas !== false) {
      this.areasMesh = new Mesh(
        new BufferGeometry(),
        new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.85 }),
      );
      this.areasMesh.name = 'street-areas';
      this.areasMesh.frustumCulled = false;
      this.group.add(this.areasMesh);
    }
    ctx.scene.add(this.group);
    ctx.map.on('terrain', this.schedule);
    ctx.map.on('sourcedata', this.onSourceData);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    this.group.position.set(...localPosition(origin, this.anchor, 0));
    this.group.updateMatrixWorld(true);
  }

  getStats(): StreetFurnitureStats {
    return { ...this.stats, byKind: { ...this.stats.byKind } };
  }

  styleChanged(attached: boolean): void {
    this.feed?.reset();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    clearTimeout(this.timer);
    this.ctx?.map.off('terrain', this.schedule);
    this.ctx?.map.off('sourcedata', this.onSourceData);
    this.feed?.dispose();
    this.feed = undefined;
    this.ctx?.scene.remove(this.group);
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
      mesh.dispose();
    }
    this.meshes.clear();
    this.areasMesh?.geometry.dispose();
    this.areasMesh?.material.dispose();
    this.areasMesh = undefined;
    this.ctx = undefined;
  }

  private get maxPerKind(): number {
    return this.options.maxPerKind ?? 1500;
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const hasSource = !!ctx.map.getSource(this.options.source);
    if (!hasSource && !this.reported) {
      this.reported = true;
      const err = new Error(`source "${this.options.source}" not found`);
      if (this.options.onError) this.options.onError(err);
      else console.warn('[maplibre-landmarks] street furniture', err);
    }
    if (!hasSource || view.zoom < (this.options.minZoom ?? 16)) {
      this.feed?.suspend();
      this.draw(view, [], []);
      return;
    }
    this.feedFor(ctx).settle();
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = 111_320 * Math.cos((view.center[1] * Math.PI) / 180);
    const distance = ([lng, lat]: LngLat) =>
      Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * 111_320);
    // A prop near a tile edge is in both tiles' buffers, and in a parent and a child tile while
    // zooming: once each, by id (by position when the data has none).
    const unique = new Map<string, Prop>();
    for (const { props } of this.tiles.values())
      for (const p of props)
        unique.set(p.id ?? `${p.kind}|${p.lngLat[0].toFixed(7)},${p.lngLat[1].toFixed(7)}`, p);
    const byKind = new Map<PropKind, { p: Prop; d: number }[]>();
    for (const p of unique.values()) {
      const d = distance(p.lngLat);
      if (d > cutoff) continue;
      const list = byKind.get(p.kind);
      if (list) list.push({ p, d });
      else byKind.set(p.kind, [{ p, d }]);
    }
    const chosen = [...byKind.values()].flatMap((list) =>
      list
        .sort((a, b) => a.d - b.d)
        .slice(0, this.maxPerKind)
        .map(({ p }) => p),
    );
    // An area is clipped into every tile holding it: keep its biggest piece.
    const areas = new Map<string, Area>();
    for (const tile of this.tiles.values())
      for (const a of tile.areas) {
        const key = a.id ?? `${a.cls}|${a.centre[0].toFixed(7)},${a.centre[1].toFixed(7)}`;
        const known = areas.get(key);
        if (!known || a.size > known.size) areas.set(key, a);
      }
    const nearAreas = [...areas.values()].filter((a) => distance(a.centre) <= cutoff);
    this.draw(view, chosen, nearAreas);
  }

  /** The terrain's elevation tiles arrived: stand the props on the ground they now have. */
  private readonly onSourceData = (e: { sourceId?: string }): void => {
    const terrain = this.ctx?.map.getTerrain()?.source;
    if (terrain && e.sourceId === terrain) this.schedule();
  };

  private feedFor(ctx: ModuleContext): TileFeed {
    this.feed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.sourceLayer ?? 'infrastructure',
      filter: ['in', ['get', 'class'], ['literal', this.classes()]],
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        this.tiles.set(key, this.read(features));
        this.schedule();
      },
      onDrop: (key) => {
        this.tiles.delete(key);
        this.schedule();
      },
    });
    return this.feed;
  }

  /** Overture classes read: the prop kinds, and the area classes unless areas are off. */
  private classes(): string[] {
    const areas = this.options.areas === false ? [] : AREA_CLASSES;
    return [...new Set<string>([...this.kinds, ...areas])];
  }

  private read(features: FeedFeature[]): { props: Prop[]; areas: Area[] } {
    const props: Prop[] = [];
    const areas: Area[] = [];
    const areasOn = this.options.areas !== false;
    for (const f of features) {
      const cls = String(f.properties?.class);
      const tags = tagsOf(f);
      const rawId = f.properties?.id;
      const id = rawId !== undefined && rawId !== null && rawId !== '' ? String(rawId) : undefined;
      const type = f.geometry.type;
      const polygons =
        type === 'Polygon'
          ? [f.geometry.coordinates as LngLat[][]]
          : type === 'MultiPolygon'
            ? (f.geometry.coordinates as LngLat[][][])
            : [];
      if (type === 'Point' && this.kinds.includes(cls as PropKind)) {
        const kind = cls as PropKind;
        const scale = propScale(kind, tags);
        if (!scale) continue;
        const lngLat = f.geometry.coordinates as LngLat;
        props.push({
          kind,
          ...(id ? { id } : {}),
          lngLat,
          facing: directionDeg(tags) ?? hashedTurnDeg(lngLat),
          scale,
        });
      } else if (cls === 'storage_tank' && polygons.length && this.kinds.includes('storage_tank')) {
        // A tank's outline: a cylinder of the same area at its centre.
        if (!propScale('storage_tank', tags)) continue;
        const { area, centre } = ringArea(polygons[0]![0] ?? []);
        const r = Math.sqrt(area / Math.PI);
        if (!(r > 0.5)) continue;
        props.push({
          kind: 'storage_tank',
          ...(id ? { id } : {}),
          lngLat: centre,
          facing: 0,
          scale: [r, num(tags.height) ?? 8, r],
        });
      } else if (areasOn && AREA_CLASSES.includes(cls as AreaClass)) {
        const areaCls = cls as AreaClass;
        if (areaCls === 'platform' && hidden(tags)) continue;
        for (const rings of polygons) {
          const { area, centre } = ringArea(rings[0] ?? []);
          if (area > 0)
            areas.push({ cls: areaCls, ...(id ? { id } : {}), rings, centre, size: area, tags });
        }
        // Piers mapped as lines become decks; platform lines are bus stops (not drawn here).
        if (areaCls === 'pier' && (type === 'LineString' || type === 'MultiLineString')) {
          const lines =
            type === 'LineString'
              ? [f.geometry.coordinates as LngLat[]]
              : (f.geometry.coordinates as LngLat[][]);
          for (const line of lines) {
            if (line.length < 2) continue;
            const mid = line[Math.floor(line.length / 2)]!;
            const k = M_PER_DEG * Math.cos((mid[1] * Math.PI) / 180);
            let length = 0;
            for (let i = 1; i < line.length; i++)
              length += Math.hypot(
                (line[i]![0] - line[i - 1]![0]) * k,
                (line[i]![1] - line[i - 1]![1]) * M_PER_DEG,
              );
            areas.push({
              cls: 'pier',
              ...(id ? { id } : {}),
              line,
              centre: mid,
              size: length,
              tags,
            });
          }
        }
      }
    }
    return { props, areas };
  }

  /** Write the chosen props into their meshes, around the view centre. */
  private draw(view: ViewState, chosen: Prop[], areas: Area[]): void {
    const ctx = this.ctx!;
    this.anchor = view.center;
    const origin = originAt(this.anchor);
    const ground = (p: LngLat) =>
      ctx.map.getTerrain() ? (ctx.map.queryTerrainElevation(p) ?? 0) : 0;
    const counts = new Map<PropKind, number>();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scale = new Vector3();
    for (const p of chosen) {
      const mesh = this.meshes.get(p.kind);
      if (!mesh) continue;
      const i = counts.get(p.kind) ?? 0;
      const base = new Vector3(...localPosition(origin, p.lngLat, ground(p.lngLat)));
      // Front is −Z (north); turning clockwise seen from above is negative about +Y.
      q.setFromAxisAngle(up, (-p.facing * Math.PI) / 180);
      mesh.setMatrixAt(i, m.compose(base, q, scale.set(...p.scale)));
      counts.set(p.kind, i + 1);
    }
    const byKind: Partial<Record<PropKind, number>> = {};
    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count) byKind[kind] = mesh.count;
    }
    this.drawAreas(areas, origin, ground);
    this.stats = { total: chosen.length, byKind, areas: this.areasMesh ? areas.length : 0 };
    ctx.requestRepaint();
  }

  /** Basins, platforms and decks in one mesh, each standing on the ground at its centre. */
  private drawAreas(areas: Area[], origin: Origin, ground: (p: LngLat) => number): void {
    const mesh = this.areasMesh;
    if (!mesh) return;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const local = (p: LngLat): Vec2 => {
      const [x, , z] = localPosition(origin, p, 0);
      return [x, z];
    };
    for (const a of areas) {
      const b = new MeshBuilder();
      const rings = a.rings?.map((ring) => ring.map(local));
      if (a.cls === 'fountain' && rings) {
        const rim = num(a.tags.height) ?? 0.5;
        basin(b, rings, rim, rim * 0.8, STONE, WATER);
      } else if (a.cls === 'platform' && rings) {
        const rail = a.tags.railway === 'platform' || a.tags.train === 'yes';
        slab(b, rings, rail ? 0.9 : 0.2, rail ? RAIL_PLATFORM : BUS_PLATFORM);
      } else if (a.cls === 'pier') {
        if (rings) slab(b, rings, 0.6, DECK);
        else if (a.line) strip(b, a.line.map(local), 3, 0.6, DECK);
      }
      const built = b.build();
      const lift = ground(a.centre);
      for (let i = 0; i < built.positions.length; i += 3)
        positions.push(
          built.positions[i]!,
          built.positions[i + 1]! + lift,
          built.positions[i + 2]!,
        );
      normals.push(...built.normals);
      colors.push(...built.colors);
    }
    const geometry = mesh.geometry;
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
  }
}
