import type { Map as MlMap, SkySpecification } from 'maplibre-gl';
import { sameValue } from '../core/expressions';

export type SkyMap = Pick<MlMap, 'getSky' | 'setSky'>;

const BLEND = { 'fog-ground-blend': 0.4, 'horizon-fog-blend': 0.6 };
/** Style-spec defaults of the keys we set (setSky only updates keys it is given). */
const DEFAULTS = { 'fog-color': '#ffffff', 'fog-ground-blend': 0.5, 'horizon-fog-blend': 0.8 };

/** Tints MapLibre's sky fog toward the horizon; restores the sky only if it is still ours. */
export class Haze {
  private original?: SkySpecification;
  private applied?: SkySpecification;

  constructor(private readonly map: SkyMap) {}

  apply(color: string): void {
    const current = this.map.getSky() ?? undefined;
    // First tint, or the app changed the sky since ours: that sky becomes the base.
    if (!this.applied || !sameValue(current ?? {}, this.applied)) this.original = current;
    const next = { ...(this.original ?? {}), 'fog-color': color, ...BLEND } as SkySpecification;
    this.map.setSky(next);
    this.applied = next;
  }

  restore(): void {
    if (this.applied && sameValue(this.map.getSky() ?? {}, this.applied)) {
      // No sky before: undefined clears it (MapLibre accepts it at runtime). Otherwise reset our
      // keys explicitly, since keys missing from the original would keep our values.
      this.map.setSky(
        (this.original ? { ...DEFAULTS, ...this.original } : undefined) as SkySpecification,
      );
    }
    this.applied = undefined;
  }

  /** Forget after a style swap without touching the (new) style. */
  reset(): void {
    this.applied = undefined;
  }
}
