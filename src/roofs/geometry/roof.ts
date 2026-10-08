import { roofRGB, toRGB } from '../colors';
import type { ProfileShape, RoofProps } from '../schema';
import { roofFrame, type RoofFrame, type Vec2 } from './frame';
import { MeshBuilder, type RoofMesh } from './mesh';
import { buildProfileRoof, profilePlanes, sawtoothTeeth } from './profiles';
import { domeRoof, onionRoof, pyramidRoof } from './radial';

export interface BuiltRoof {
  mesh: RoofMesh;
  /** Height of the roof drawn; the walls are shortened by exactly this. */
  roofHeight: number;
}

const TAN_30 = Math.tan(Math.PI / 6);
/** Curved shapes: no single pitch, so `roof_angle` is ignored. */
const ROUNDED = new Set(['dome', 'onion', 'round']);
const MIN_DEFAULT_M = 0.5;
/** Shapes whose end slopes assume the ridge runs along the longer side. */
const LONG_RIDGE = new Set(['hipped', 'half_hipped', 'hipped_and_gabled', 'mansard']);

/** Horizontal run of the roof faces, for a `roof_angle`. */
function pitchRun(shape: string, frame: Pick<RoofFrame, 'L' | 'W'>): number {
  if (shape === 'skillion') return 2 * frame.W;
  if (shape === 'sawtooth') return sawtoothTeeth(frame.W).width;
  if (shape === 'pyramidal' || shape === 'cone') return Math.min(frame.L, frame.W);
  return frame.W;
}

/**
 * Spec section 3: explicit heights (or pitches) fill up to the span; defaults are capped at half
 * of it.
 */
export function resolveRoofHeight(
  props: RoofProps,
  frame: Pick<RoofFrame, 'L' | 'W'>,
): number | null {
  const span = props.height - props.minHeight;
  if (props.roofHeight !== undefined) return Math.min(props.roofHeight, span);
  if (props.roofAngle !== undefined && !ROUNDED.has(props.shape)) {
    const fromAngle = Math.tan((props.roofAngle * Math.PI) / 180) * pitchRun(props.shape, frame);
    return Math.min(fromAngle, span);
  }
  // A sawtooth's height is per tooth, so its default pitch is measured over one tooth.
  const half =
    props.shape === 'sawtooth' ? sawtoothTeeth(frame.W).width / 2 : Math.min(frame.L, frame.W);
  const fallback = ROUNDED.has(props.shape) ? half : half * TAN_30;
  const capped = Math.min(fallback, span / 2);
  return capped >= MIN_DEFAULT_M ? capped : null;
}

const open = (ring: Vec2[]): Vec2[] => {
  const [f, l] = [ring[0]!, ring.at(-1)!];
  return ring.length > 1 && f[0] === l[0] && f[1] === l[1] ? ring.slice(0, -1) : ring;
};

function area(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * The roof for one building (local metres, base at y = 0), or null when it gets none.
 * `variance` shifts the roof colour's lightness (see `colorVariance`).
 */
export function buildRoof(props: RoofProps, polygons: Vec2[][][], variance = 0): BuiltRoof | null {
  const outers = polygons.map((rings) => open(rings[0] ?? []));
  const outer = outers.reduce((best, r) => (area(r) > area(best) ? r : best), outers[0] ?? []);
  if (outer.length < 3 || area(outer) < 1e-6) return null;
  let frame = roofFrame(outer, props.direction, props.orientation);
  if (LONG_RIDGE.has(props.shape) && frame.L < frame.W) {
    // Hips are symmetric: turn the frame so the ridge is on the long side and the roof
    // reaches its height (with u ⟂ v kept: v = perp(u)).
    frame = {
      origin: frame.origin,
      u: frame.v,
      v: [-frame.u[0], -frame.u[1]],
      L: frame.W,
      W: frame.L,
    };
  }
  if (frame.L < 0.25 || frame.W < 0.25) return null;
  const H = resolveRoofHeight(props, frame);
  if (H === null || !(H > 0)) return null;
  const roof = roofRGB(props.roofColor, variance);
  const radius = Math.min(frame.L, frame.W);
  const b = new MeshBuilder();
  switch (props.shape) {
    case 'pyramidal':
    case 'cone':
      // A cone follows the outline up to its apex: a true cone on a round outline, and no flat
      // ledge left uncovered on any other (a circle inside the box would leave one).
      pyramidRoof(b, outer, frame.origin, H, roof);
      return { mesh: b.build(), roofHeight: H };
    case 'dome':
      domeRoof(b, frame.origin, radius, H, roof);
      return { mesh: b.build(), roofHeight: H };
    case 'onion':
      onionRoof(b, frame.origin, radius, H, roof);
      return { mesh: b.build(), roofHeight: H };
    default: {
      const shape = props.shape as ProfileShape;
      const profile = profilePlanes(shape, H, frame.L, frame.W);
      return {
        mesh: buildProfileRoof(polygons, frame, profile, roof, toRGB(props.wallColor)),
        roofHeight: H,
      };
    }
  }
}
