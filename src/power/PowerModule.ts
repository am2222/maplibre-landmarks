import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { EARTH_RADIUS_M, localPosition, originAt } from '../core/mercator';
import type { Theme } from '../core/theme';
import { TileFeed, type FeedFeature, type FeedMap } from '../core/tileFeed';
import { WaterMask } from '../core/waterMask';
import type { LngLat, Origin, ViewState } from '../core/types';
import {
  attachments,
  haloTexture,
  LAMP_HEAD,
  lampHeadGeometry,
  lampPostGeometry,
  sagCurve,
  supportGeometry,
} from './geometry';
import { buildNetwork, type LinePiece, type Support } from './network';

export interface PowerOptions {
  /** Vector source with Overture's `base` schema (`infrastructure` layer). */
  source: string;
  /** Source layer holding the power features (default 'infrastructure'). */
  sourceLayer?: string;
  /** Power lines appear from this zoom (default 14). */
  minZoom?: number;
  /** Nearest supports drawn at most (default 2000). */
  maxSupports?: number;
  /** Pitched views draw supports only to about three screen heights away (default true). */
  farCutoff?: boolean;
  /**
   * Water polygons (default: the same source's `water` layer, as in Overture's base tiles):
   * lines without mapped supports get no pole in water. `false` turns this off.
   */
  water?: false | { source?: string; sourceLayer?: string };
  /**
   * Street lamps from the same source's `street_lamp` points: posts whose lamps glow at dusk and
   * night (default true). `maxLamps`: the nearest drawn at most (default 3000).
   */
  streetLamps?: boolean | { maxLamps?: number };
  onError?: (err: unknown) => void;
}

export interface PowerStats {
  supports: number;
  spans: number;
  /** Tallest support drawn, metres. */
  tallest: number;
  /** Street lamps drawn. */
  lamps: number;
}

const REBUILD_DEBOUNCE_MS = 150;
/** Segments per wire span. */
const WIRE_STEPS = 12;
const LINE_CLASSES = ['power_line', 'minor_line'];
const SUPPORT_CLASSES = ['power_tower', 'power_pole'];
const LAMP_CLASS = 'street_lamp';
/** Street lamps are rarely tagged with a height: a typical urban lamp post. */
const LAMP_HEIGHT_M = 6;
/** Width of the glow around a lit lamp head, metres. */
const HALO_M = 9;
/** Warm sodium-like light. */
const LAMP_LIGHT = 0xffcf8a;
/** How brightly the lamps glow in each theme (off by day). */
const LAMP_GLOW: Record<Theme, number> = { day: 0, dawn: 0.5, dusk: 0.85, night: 1 };

const heightOf = (f: FeedFeature): number | undefined => {
  try {
    const tags = JSON.parse(String(f.properties?.source_tags ?? '{}')) as Record<string, unknown>;
    const h = Number.parseFloat(String(tags.height ?? '').replace(',', '.'));
    return h > 0 ? h : undefined;
  } catch {
    return undefined;
  }
};

/** Power lines: pylons and poles where they are mapped, with sagging wires between them. */
export class PowerModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly group = new Group();
  private readonly supportMeshes = new Map<'tower' | 'pole', InstancedMesh>();
  private wires?: LineSegments<BufferGeometry, LineBasicMaterial>;
  private lampPosts?: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  private lampHeads?: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  private halos?: Points<BufferGeometry, PointsMaterial>;
  private feed?: TileFeed;
  private water?: WaterMask;
  /** Each held tile's line pieces and supports. */
  private readonly tiles = new Map<
    string,
    { lines: LinePiece[]; supports: Support[]; lamps: LngLat[] }
  >();
  private network?: ReturnType<typeof buildNetwork>;
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: PowerStats = { supports: 0, spans: 0, tallest: 0, lamps: 0 };
  private reported = false;

  constructor(private readonly options: PowerOptions) {
    this.group.name = 'power';
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const steel = new MeshStandardMaterial({ color: 0x7a7f86, roughness: 0.7, metalness: 0.3 });
    for (const kind of ['tower', 'pole'] as const) {
      const mesh = new InstancedMesh(supportGeometry(kind), steel, this.maxSupports);
      mesh.name = kind;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.supportMeshes.set(kind, mesh);
      this.group.add(mesh);
    }
    this.wires = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x2b2d30 }));
    this.wires.name = 'wires';
    this.wires.frustumCulled = false;
    this.group.add(this.wires);
    if (this.options.streetLamps !== false) this.addLamps();
    this.themeChanged(ctx.core.theme);
    ctx.scene.add(this.group);
  }

  /** Lamps glow at dusk and night: lantern and halo brightness follow the theme. */
  themeChanged(theme: Theme): void {
    const glow = LAMP_GLOW[theme] ?? 0;
    if (this.lampHeads) this.lampHeads.material.emissiveIntensity = 1.6 * glow;
    if (this.halos) {
      this.halos.material.opacity = 0.75 * glow;
      this.halos.visible = glow > 0;
    }
    this.ctx?.requestRepaint();
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    this.group.position.set(...localPosition(origin, this.anchor, 0));
    this.group.updateMatrixWorld(true);
    if (this.halos) this.halos.material.size = this.haloSize();
  }

  getStats(): PowerStats {
    return { ...this.stats };
  }

  styleChanged(attached: boolean): void {
    this.feed?.reset();
    this.water?.reset();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    clearTimeout(this.timer);
    this.feed?.dispose();
    this.feed = undefined;
    this.water?.dispose();
    this.water = undefined;
    this.ctx?.scene.remove(this.group);
    for (const mesh of this.supportMeshes.values()) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const lamp of [this.lampPosts, this.lampHeads]) {
      lamp?.geometry.dispose();
      lamp?.material.dispose();
      lamp?.dispose();
    }
    this.halos?.geometry.dispose();
    this.halos?.material.map?.dispose();
    this.halos?.material.dispose();
    (this.supportMeshes.get('tower')?.material as MeshStandardMaterial | undefined)?.dispose();
    this.wires?.geometry.dispose();
    this.wires?.material.dispose();
    this.ctx = undefined;
  }

  private get maxSupports(): number {
    return this.options.maxSupports ?? 2000;
  }

  private get maxLamps(): number {
    const lamps = this.options.streetLamps;
    return lamps === false ? 0 : ((typeof lamps === 'object' ? lamps.maxLamps : undefined) ?? 3000);
  }

  private addLamps(): void {
    const post = new MeshStandardMaterial({ color: 0x3d4146, roughness: 0.6, metalness: 0.4 });
    const head = new MeshStandardMaterial({
      color: 0x2e3135,
      emissive: LAMP_LIGHT,
      emissiveIntensity: 0,
      roughness: 0.4,
    });
    this.lampPosts = new InstancedMesh(lampPostGeometry(), post, this.maxLamps);
    this.lampHeads = new InstancedMesh(lampHeadGeometry(), head, this.maxLamps);
    this.halos = new Points(
      new BufferGeometry(),
      new PointsMaterial({
        map: haloTexture(),
        color: LAMP_LIGHT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.lampPosts.name = 'lamp-posts';
    this.lampHeads.name = 'lamp-heads';
    this.halos.name = 'lamp-halos';
    for (const o of [this.lampPosts, this.lampHeads, this.halos]) {
      if ('count' in o) o.count = 0;
      o.frustumCulled = false;
      this.group.add(o);
    }
  }

  /**
   * Point size giving the halos HALO_M metres across. Camera space is in screen pixels here (the
   * view matrix comes from MapLibre's), and three scales a point by half the drawing-buffer
   * height over its depth: so metres × pixels per metre over tan(fov / 2).
   */
  private haloSize(): number {
    const map = this.ctx?.map as
      | { getZoom(): number; getCenter(): { lat: number }; getVerticalFieldOfView?(): number }
      | undefined;
    if (!map) return 1;
    const lat = map.getCenter().lat;
    const pixelsPerMetre =
      (512 * 2 ** map.getZoom()) / (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180));
    const fov = ((map.getVerticalFieldOfView?.() ?? 36.87) * Math.PI) / 180;
    return (HALO_M * pixelsPerMetre) / Math.tan(fov / 2);
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const active = view.zoom >= (this.options.minZoom ?? 14);
    if (!ctx.map.getSource(this.options.source)) {
      if (!this.reported) {
        this.reported = true;
        const err = new Error(`source "${this.options.source}" not found`);
        if (this.options.onError) this.options.onError(err);
        else console.warn('[maplibre-landmarks] power', err);
      }
    } else if (active) {
      this.feedFor(ctx).settle();
      this.waterFor(ctx)?.settle();
    }
    if (!active || !ctx.map.getSource(this.options.source)) {
      this.feed?.suspend();
      this.water?.suspend();
      this.draw(view, [], []);
      return;
    }
    this.network ??= buildNetwork(
      [...this.tiles.values()].flatMap((t) => t.lines),
      [...this.tiles.values()].flatMap((t) => t.supports),
      (p) => this.water?.contains(p) ?? false,
    );
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = 111_320 * Math.cos((view.center[1] * Math.PI) / 180);
    const distance = ([lng, lat]: LngLat) =>
      Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * 111_320);
    const chosen = this.network.supports
      .map((s, i) => ({ i, d: distance(s.lngLat) }))
      .filter(({ d }) => d <= cutoff)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.maxSupports)
      .map(({ i }) => i);
    // A lamp near a tile edge is in both tiles' buffers: once each.
    const lamps = new Map<string, LngLat>();
    for (const t of this.tiles.values())
      for (const p of t.lamps) lamps.set(`${p[0].toFixed(7)},${p[1].toFixed(7)}`, p);
    const nearLamps = [...lamps.values()]
      .map((p) => ({ p, d: distance(p) }))
      .filter(({ d }) => d <= cutoff)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.maxLamps)
      .map(({ p }) => p);
    this.draw(view, chosen, nearLamps);
  }

  private feedFor(ctx: ModuleContext): TileFeed {
    this.feed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.sourceLayer ?? 'infrastructure',
      filter: this.filter(),
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        this.tiles.set(key, this.read(features));
        this.network = undefined;
        this.schedule();
      },
      onDrop: (key) => {
        if (this.tiles.delete(key)) this.network = undefined;
        this.schedule();
      },
    });
    return this.feed;
  }

  private filter(): unknown[] {
    const power = [
      'all',
      ['==', ['get', 'subtype'], 'power'],
      ['in', ['get', 'class'], ['literal', [...SUPPORT_CLASSES, ...LINE_CLASSES]]],
    ];
    return this.maxLamps > 0 ? ['any', power, ['==', ['get', 'class'], LAMP_CLASS]] : power;
  }

  private waterFor(ctx: ModuleContext): WaterMask | undefined {
    const water = this.options.water;
    if (water === false) return undefined;
    this.water ??= new WaterMask(ctx.map as unknown as FeedMap, {
      source: water?.source ?? this.options.source,
      sourceLayer: water?.sourceLayer ?? 'water',
      onChange: () => {
        this.network = undefined;
        this.schedule();
      },
    });
    return this.water;
  }

  private read(features: FeedFeature[]): {
    lines: LinePiece[];
    supports: Support[];
    lamps: LngLat[];
  } {
    const lines: LinePiece[] = [];
    const supports: Support[] = [];
    const lamps: LngLat[] = [];
    for (const f of features) {
      const cls = String(f.properties?.class);
      if (cls === LAMP_CLASS && f.geometry.type === 'Point') {
        if (this.maxLamps > 0) lamps.push(f.geometry.coordinates as LngLat);
      } else if (SUPPORT_CLASSES.includes(cls) && f.geometry.type === 'Point') {
        const height = heightOf(f);
        supports.push({
          lngLat: f.geometry.coordinates as LngLat,
          kind: cls === 'power_pole' ? 'pole' : 'tower',
          ...(height !== undefined ? { height } : {}),
        });
      } else if (LINE_CLASSES.includes(cls)) {
        const id = String(f.properties?.id ?? f.id ?? '');
        const kind = cls === 'minor_line' ? 'minor_line' : 'line';
        const parts =
          f.geometry.type === 'LineString'
            ? [f.geometry.coordinates as LngLat[]]
            : f.geometry.type === 'MultiLineString'
              ? (f.geometry.coordinates as LngLat[][])
              : [];
        for (const coords of parts) lines.push({ id, kind, coords });
      }
    }
    return { lines, supports, lamps };
  }

  /** Instance the chosen supports and string the wires between them, around the view centre. */
  private draw(view: ViewState, chosen: number[], lamps: LngLat[]): void {
    const ctx = this.ctx!;
    const net = this.network;
    this.anchor = view.center;
    const origin = originAt(this.anchor);
    const ground = (p: LngLat) =>
      ctx.map.getTerrain() ? (ctx.map.queryTerrainElevation(p) ?? 0) : 0;
    const drawn = new Set(chosen);
    const placed = new Map<number, { base: Vector3; across: Vector3; height: number }>();
    const counts = { tower: 0, pole: 0 };
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    let tallest = 0;
    for (const i of chosen) {
      const s = net!.supports[i]!;
      const base = new Vector3(...localPosition(origin, s.lngLat, ground(s.lngLat)));
      // Arms across the line: the support's local x turned to bearing + 90°.
      const angle = -((s.bearing + 90) * Math.PI) / 180;
      q.setFromAxisAngle(up, angle + Math.PI / 2);
      const across = new Vector3(1, 0, 0).applyQuaternion(q);
      placed.set(i, { base, across, height: s.height });
      const mesh = this.supportMeshes.get(s.kind)!;
      m.compose(base, q, new Vector3(s.height, s.height, s.height));
      mesh.setMatrixAt(counts[s.kind]++, m);
      tallest = Math.max(tallest, s.height);
    }
    for (const [kind, mesh] of this.supportMeshes) {
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
    }
    const positions: number[] = [];
    let spans = 0;
    for (const [i, j] of net?.spans ?? []) {
      if (!drawn.has(i) || !drawn.has(j)) continue;
      const a = placed.get(i)!;
      const b = placed.get(j)!;
      const kind = net!.supports[i]!.kind;
      // Keep each wire on its side: flip one end's arms if they point the other way.
      const flip = a.across.dot(b.across) < 0 ? -1 : 1;
      for (const [x, y] of attachments(kind)) {
        const end = (p: typeof a, sign: number) =>
          [
            p.base.x + p.across.x * x * p.height * sign,
            p.base.y + y * p.height,
            p.base.z + p.across.z * x * p.height * sign,
          ] as [number, number, number];
        const curve = sagCurve(end(a, 1), end(b, flip), WIRE_STEPS);
        for (let k = 0; k < WIRE_STEPS; k++) positions.push(...curve[k]!, ...curve[k + 1]!);
      }
      spans++;
    }
    this.wires!.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.drawLamps(lamps, origin, ground);
    this.stats = { supports: chosen.length, spans, tallest, lamps: lamps.length };
    ctx.requestRepaint();
  }

  /** Posts, lamp heads and their halos; each turned its own way (the street side is unknown). */
  private drawLamps(lamps: LngLat[], origin: Origin, ground: (p: LngLat) => number): void {
    if (!this.lampPosts || !this.lampHeads || !this.halos) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scale = new Vector3(LAMP_HEIGHT_M, LAMP_HEIGHT_M, LAMP_HEIGHT_M);
    const halos: number[] = [];
    lamps.forEach((p, i) => {
      const base = new Vector3(...localPosition(origin, p, ground(p)));
      // A stable turn per lamp from its position.
      const turn = ((Math.abs(Math.sin(p[0] * 12_989.8 + p[1] * 78_233.1)) * 43_758.5) % 1) * 2;
      q.setFromAxisAngle(up, turn * Math.PI);
      m.compose(base, q, scale);
      this.lampPosts!.setMatrixAt(i, m);
      this.lampHeads!.setMatrixAt(i, m);
      const head = new Vector3(LAMP_HEAD[0], LAMP_HEAD[1], 0).multiplyScalar(LAMP_HEIGHT_M);
      head.applyQuaternion(q).add(base);
      halos.push(head.x, head.y, head.z);
    });
    for (const mesh of [this.lampPosts, this.lampHeads]) {
      mesh.count = lamps.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.halos.geometry.setAttribute('position', new Float32BufferAttribute(halos, 3));
  }
}
