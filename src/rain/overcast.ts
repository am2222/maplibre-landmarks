import type { Map as MlMap, SkySpecification } from 'maplibre-gl';
import { Color } from 'three';
import { sameValue } from '../core/expressions';
import { SKY_COLORS, type Theme } from '../core/theme';

export type SkyMap = Pick<MlMap, 'getSky' | 'setSky'>;

/** Style-spec defaults of the keys we set (setSky only updates keys it is given). */
const DEFAULTS = { 'sky-color': '#88c6fc', 'horizon-color': '#ffffff', 'fog-color': '#ffffff' };
/** Rain-cloud grey that the theme's sky colours are drawn toward. */
const CLOUD = new Color('#7d858e');

/** The theme's sky colours, `amount` (0–1) of the way to rain-cloud grey, a little darker. */
export function overcastColors(
  theme: Theme,
  amount: number,
): Record<keyof typeof DEFAULTS, string> {
  const base = SKY_COLORS[theme];
  const mix = (hex: string) => {
    const c = new Color(hex);
    const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    // Grey keeps the theme's brightness (a night stays dark), then dims with the clouds.
    const grey = CLOUD.clone().multiplyScalar(Math.min(1.4, lum / 0.5));
    return `#${c
      .lerp(grey, amount)
      .multiplyScalar(1 - 0.25 * amount)
      .getHexString()}`;
  };
  return {
    'sky-color': mix(base.sky),
    'horizon-color': mix(base.horizon),
    'fog-color': mix(base.fog),
  };
}

/** Greys MapLibre's sky for rain; restores it only if the sky is still the one we set. */
export class Overcast {
  private original?: SkySpecification;
  private applied?: SkySpecification;

  constructor(private readonly map: SkyMap) {}

  apply(theme: Theme, amount: number): void {
    const current = this.map.getSky() ?? undefined;
    // First time, or the app changed the sky since ours: that sky becomes the base.
    if (!this.applied || !sameValue(current ?? {}, this.applied)) this.original = current;
    const next = { ...(this.original ?? {}), ...overcastColors(theme, amount) } as SkySpecification;
    this.map.setSky(next);
    this.applied = next;
  }

  restore(): void {
    if (this.applied && sameValue(this.map.getSky() ?? {}, this.applied)) {
      // No sky before: undefined clears it. Otherwise reset our keys explicitly, since keys
      // missing from the original would keep our greys.
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
