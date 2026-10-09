import { EARTH_RADIUS_M } from './mercator';
import { tileBounds } from './tileFeed';
import type { LngLat, ViewState } from './types';

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
const M_PER_DEG = EARTH_CIRCUMFERENCE_M / 360;
/** Screen heights of ground kept around the view centre once the view is pitched. */
const SCREENS = 3;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How far from the view centre 3D detail (trees, roofs) is drawn, in metres: about three screen
 * heights of ground. Like Mapbox's fill-extrusion and model cutoff, it only applies to pitched
 * views, easing in from 45° to 60°, where tiles reach towards the horizon. Infinity when off.
 */
export function farCutoffM(view: ViewState): number {
  const blend = smoothstep(45, 60, view.pitch);
  if (!(blend > 0) || !view.heightPx) return Infinity;
  const metresPerPixel =
    (EARTH_CIRCUMFERENCE_M * Math.cos((view.center[1] * Math.PI) / 180)) / (512 * 2 ** view.zoom);
  return (SCREENS * view.heightPx * metresPerPixel) / blend;
}

/** Ground distance (metres) from a point to the nearest point of a tile; 0 inside it. */
export function tileNearestM(key: string, [lng, lat]: LngLat): number {
  const [w, s, e, n] = tileBounds(key);
  const dx = Math.max(w - lng, 0, lng - e) * Math.cos((lat * Math.PI) / 180) * M_PER_DEG;
  const dy = Math.max(s - lat, 0, lat - n) * M_PER_DEG;
  return Math.hypot(dx, dy);
}
