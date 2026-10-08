import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  FeatureIdentifier,
  Map as MlMap,
} from 'maplibre-gl';
import { Tweens } from '../landmarks/fade';
import { CandidateScanner, labelLayerIds, styleLayersOf, type Candidate } from './candidates';
import { exemptionsFor, offExemptionsChanged, onExemptionsChanged } from './exemptions';
import { LABEL_STATE, LabelOpacity } from './opacity';
import { OcclusionProbe } from './probe';

export interface LabelOcclusionOptions {
  id?: string;
  /** Label layers to manage; default: point labels of POI and building layers. */
  labelLayers?: string[];
  /** Below this zoom every label is shown. */
  minZoom?: number;
  fadeMs?: number;
  /** Labels probed at once, nearest to the screen centre first. */
  maxLabels?: number;
  onError?: (err: unknown) => void;
}

const PROBE_PX = 4;
type Listener = (e?: { sourceDataType?: string; sourceId?: string }) => void;

const nextFrame = (fn: (now: number) => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(() => fn(performance.now()), 16);
};

/**
 * Fades out basemap point labels hidden behind 3D content, using WebGL2 occlusion queries
 * against the depth buffer. Add it anywhere: it moves itself after the 3D layers.
 */
export class LabelOcclusion implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  readonly id: string;
  private map?: MlMap;
  private scanner?: CandidateScanner;
  private opacity?: LabelOpacity;
  private probe?: OcclusionProbe;
  private failed = false;
  private candidates: Candidate[] = [];
  private targetsChanged = false;
  private readonly labels = new Map<string, FeatureIdentifier>();
  private readonly written = new Map<string, number>();
  private readonly fades: Tweens<string>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastScan = 0;
  /** Candidate keys and probe heights of the last scan; unchanged scans cost nothing. */
  private signature = '';
  private looping = false;
  private placing = false;
  /** False while every label is being shown (no probing): late answers are ignored. */
  private probing = false;

  constructor(private readonly options: LabelOcclusionOptions = {}) {
    this.id = options.id ?? 'label-occlusion';
    this.fades = new Tweens(options.fadeMs ?? 180);
  }

  private readonly handlers: [string, Listener][] = [
    ['move', () => this.changed(Math.max(0, 250 - (performance.now() - this.lastScan)))],
    ['moveend', () => this.changed(60)],
    // Symbols are placed after tiles and collisions settle, with no event of their own.
    ['idle', () => this.schedule(60)],
    [
      'sourcedata',
      (e) => {
        if (e?.sourceDataType && e.sourceDataType !== 'content') return;
        if (e?.sourceId && this.isExtrusionSource(e.sourceId)) this.scanner?.forgetGround();
        this.changed(150);
      },
    ],
    [
      'terrain',
      () => {
        this.scanner?.clearRoofs();
        this.changed(100);
      },
    ],
    [
      'styledata',
      () => {
        this.place();
        // Hidden with visibility 'none', render stops: hand every label back now.
        if (this.hidden() && this.labels.size) this.schedule(0);
      },
    ],
    ['style.load', () => this.onStyleLoad()],
    ['webglcontextlost', () => this.contextLost()],
    ['webglcontextrestored', () => this.changed(0)],
  ];

  onAdd(map: MlMap, _gl?: WebGL2RenderingContext): void {
    this.map = map;
    this.scanner = new CandidateScanner(map);
    this.opacity = new LabelOpacity(map, (message) => this.report(new Error(message)));
    this.opacity.wrap(this.layerIds());
    onExemptionsChanged(map, this.refresh);
    for (const [type, fn] of this.handlers) map.on(type as 'move', fn as never);
    this.place();
    this.schedule(0);
  }

  onRemove(_map?: MlMap, _gl?: WebGL2RenderingContext): void {
    this.teardown();
  }

  /** Re-scan labels now (e.g. after the app changed its label layers). */
  readonly refresh = (): void => this.changed(0);

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || this.failed) return;
    if (
      args.defaultProjectionData.projectionTransition > 0 ||
      map.getZoom() < (this.options.minZoom ?? 15)
    ) {
      this.probing = false;
      this.showAll();
      return;
    }
    if (typeof gl.createQuery !== 'function' || gl.isContextLost()) return;
    try {
      this.probe ??= new OcclusionProbe(gl);
      if (this.targetsChanged) {
        this.probe.setTargets(this.candidates.filter((c) => !c.exempt && !c.pending));
        this.targetsChanged = false;
      }
      // The drawing buffer's ratio (option or canvas-size clamp), not the device's.
      this.probe.draw(args.defaultProjectionData.mainMatrix, PROBE_PX * map.getPixelRatio());
      this.probing = true;
      this.startLoop();
    } catch (err) {
      this.failed = true;
      this.probe = undefined;
      this.report(err);
      this.showAll();
    }
  }

  private layerIds(): string[] {
    return this.map ? labelLayerIds(styleLayersOf(this.map), this.options.labelLayers) : [];
  }

  private changed(delayMs: number): void {
    this.schedule(delayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.map || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, delayMs);
  }

  private scan(): void {
    const map = this.map;
    if (!map || !this.scanner) return;
    this.lastScan = performance.now();
    const layers = this.layerIds();
    this.opacity?.wrap(layers);
    this.scanner.setExemptions(exemptionsFor(map));
    const next =
      map.getZoom() >= (this.options.minZoom ?? 15) && !this.hidden()
        ? this.scanner.scan(layers, this.options.maxLabels ?? 256)
        : [];
    // Labels whose roof lookup was deferred get their turn soon, not at the next idle.
    if (next.some((c) => c.pending)) this.schedule(50);
    const keep = new Set(next.map((c) => c.key));
    for (const [key, feature] of this.labels) if (!keep.has(key)) this.drop(key, feature);
    for (const c of next) {
      if (!this.labels.has(c.key)) {
        this.labels.set(c.key, c.feature);
        this.fades.set(c.key, 1);
      }
      if (c.exempt) this.fades.to(c.key, 1);
    }
    this.candidates = next;
    const signature = next
      .map((c) => `${c.key}:${c.elevation}:${+c.exempt}:${+c.pending}`)
      .join('|');
    if (signature === this.signature) return; // keeps idle → scan from looping
    this.signature = signature;
    this.targetsChanged = true;
    this.startLoop();
    map.triggerRepaint();
  }

  /** A label left the screen or the managed set: back to the style default (shown). */
  private drop(key: string, feature: FeatureIdentifier): void {
    if (this.written.has(key))
      this.safely(() => this.map!.removeFeatureState(feature, LABEL_STATE));
    this.written.delete(key);
    this.labels.delete(key);
    this.fades.delete(key);
  }

  private showAll(): void {
    let any = false;
    for (const key of this.labels.keys()) {
      if (this.fades.target(key) !== 1) {
        this.fades.to(key, 1);
        any = true;
      }
    }
    if (any) this.startLoop();
  }

  private startLoop(): void {
    if (this.looping || !this.map) return;
    this.looping = true;
    nextFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.looping = false;
    const map = this.map;
    if (!map) return;
    const probe = this.probe;
    if (probe) {
      const answers = probe.poll(); // always drained, so queries return to the pool
      if (this.probing) {
        for (const [key, visible] of answers) {
          if (this.labels.has(key)) this.fades.to(key, visible ? 1 : 0);
        }
      }
      if (probe.needsDraw) map.triggerRepaint();
    }
    this.fades.step(now);
    this.write();
    if (probe?.pending || this.fades.active()) this.startLoop();
  };

  private write(): void {
    for (const [key, feature] of this.labels) {
      const value = this.fades.value(key);
      if (this.written.get(key) === value) continue;
      this.safely(() => this.map!.setFeatureState(feature, { [LABEL_STATE]: value }));
      this.written.set(key, value);
    }
  }

  /** Keep this layer after the last 3D layer and before the first label layer. */
  private place(): void {
    const map = this.map;
    if (!map || this.placing || !map.getLayer(this.id)) return;
    this.placing = true;
    try {
      const order = map.getLayersOrder();
      const typeOf = (id: string) => (map.getLayer(id) as { type?: string } | undefined)?.type;
      // 3D content that writes depth: extrusions and 3D custom layers. 2D custom layers and other
      // occlusion layers are skipped, or two instances would keep moving past each other.
      const is3d = (id: string) => {
        const layer = map.getLayer(id) as
          { type?: string; implementation?: Partial<CustomLayerInterface> } | undefined;
        if (layer?.type === 'fill-extrusion') return true;
        if (layer?.type !== 'custom') return false;
        const impl = layer.implementation;
        return !(impl instanceof LabelOcclusion) && impl?.renderingMode !== '2d';
      };
      let last3d = -1;
      order.forEach((id, i) => {
        if (id !== this.id && is3d(id)) last3d = i;
      });
      const firstLabel = order.findIndex((id) => typeOf(id) === 'symbol');
      const at = order.indexOf(this.id);
      const afterLast3d = at > last3d;
      const beforeLabels = firstLabel === -1 || firstLabel < last3d || at < firstLabel;
      if (afterLast3d && beforeLabels) return;
      map.moveLayer(
        this.id,
        order.slice(last3d + 1).find((id) => id !== this.id),
      );
    } catch (err) {
      this.report(err);
    } finally {
      this.placing = false;
    }
  }

  private onStyleLoad(): void {
    const map = this.map;
    if (!map) return;
    // The new style owns its paint; forget our wrapping without touching it.
    this.opacity?.reset();
    this.signature = '';
    if (!map.getLayer(this.id)) {
      this.written.clear();
      this.labels.clear();
      this.teardown();
      return;
    }
    // A diffed swap keeps sources and their feature-state: hand our labels back (shown) rather
    // than forget them, or one not found again would stay hidden.
    for (const [key, feature] of this.labels) this.drop(key, feature);
    this.place();
    this.changed(0);
  }

  private isExtrusionSource(sourceId: string): boolean {
    return (
      !!this.map &&
      styleLayersOf(this.map).some((l) => l.type === 'fill-extrusion' && l.source === sourceId)
    );
  }

  private hidden(): boolean {
    try {
      return this.map?.getLayoutProperty(this.id, 'visibility') === 'none';
    } catch {
      return false;
    }
  }

  private contextLost(): void {
    this.probe = undefined; // its handles died with the context
    this.targetsChanged = true;
    this.signature = '';
    this.showAll();
  }

  private teardown(): void {
    const map = this.map;
    if (!map) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [type, fn] of this.handlers) map.off(type as 'move', fn as never);
    offExemptionsChanged(map, this.refresh);
    for (const [key, feature] of this.labels) {
      if (this.written.has(key)) this.safely(() => map.removeFeatureState(feature, LABEL_STATE));
    }
    this.opacity?.restore();
    this.safely(() => this.probe?.dispose());
    this.probe = undefined;
    this.labels.clear();
    this.written.clear();
    this.fades.clear();
    this.candidates = [];
    this.signature = '';
    this.map = undefined;
  }

  private report(err: unknown): void {
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] label occlusion', err);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // The style or context was torn down.
    }
  }
}
