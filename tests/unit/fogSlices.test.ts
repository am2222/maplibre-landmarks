import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { localPosition, originAt } from '../../src/core/mercator';
import { fogColor, FOG_COLORS } from '../../src/fog/colors';
import {
  buildRingGeometry,
  buildSliceGeometry,
  cameraBasis,
  indexFor,
  layerAltitudes,
  layerOrder,
  noiseOrigin,
  NOISE_PERIOD_M,
  ringRadii,
} from '../../src/fog/slices';

describe('fog slices', () => {
  it('stacks layers in equal altitude bands from the floor to the ceiling', () => {
    const { altitudes, step } = layerAltitudes(1000, 1400, 8);
    expect(step).toBe(50);
    expect(altitudes).toEqual([1025, 1075, 1125, 1175, 1225, 1275, 1325, 1375]);
  });

  it('draws the layer farthest from the camera altitude first (back to front)', () => {
    const alts = [10, 20, 30, 40];
    expect(layerOrder(alts, 500)).toEqual([0, 1, 2, 3]); // above: bottom first
    expect(layerOrder(alts, -5)).toEqual([3, 2, 1, 0]); // below: top first
    expect(layerOrder(alts, 26)).toEqual([0, 3, 1, 2]); // inside: outermost first
    expect(indexFor([1, 0])).toEqual([4, 5, 6, 4, 6, 7, 0, 1, 2, 0, 2, 3]);
  });

  it('builds one quad per slice, drawn far first', () => {
    const g = buildSliceGeometry(3);
    expect(g.getAttribute('aCorner').count).toBe(12);
    expect(g.getAttribute('aSlice').count).toBe(12);
    const index = Array.from(g.getIndex()!.array);
    expect(index).toHaveLength(18);
    const slice = g.getAttribute('aSlice');
    expect(slice.getX(index[0]!)).toBe(2);
    expect(slice.getX(index.at(-1)!)).toBe(0);
  });

  it('spaces rings geometrically from the inner to the outer radius', () => {
    const { radii, ratio } = ringRadii(10, 1000, 3);
    expect(ratio).toBeCloseTo(10, 9);
    expect(radii[0]).toBeCloseTo(10, 9);
    expect(radii[1]).toBeCloseTo(100, 9);
    expect(radii[2]).toBeCloseTo(1000, 9);
  });

  it('builds one closed wall per ring, drawn far first', () => {
    const g = buildRingGeometry(3, 8);
    // (segments + 1) columns of bottom/top vertices per ring.
    expect(g.getAttribute('aCorner').count).toBe(3 * 9 * 2);
    const index = Array.from(g.getIndex()!.array);
    expect(index).toHaveLength(3 * 8 * 6);
    const ring = g.getAttribute('aSlice');
    expect(ring.getX(index[0]!)).toBe(2);
    expect(ring.getX(index.at(-1)!)).toBe(0);
    const corner = g.getAttribute('aCorner');
    const turns = Array.from({ length: 18 }, (_, i) => corner.getX(i));
    expect(Math.min(...turns)).toBe(0);
    expect(Math.max(...turns)).toBe(1);
  });

  it('reads a unit camera basis and field of view from scaled matrices', () => {
    const cam = new PerspectiveCamera(60, 2, 1, 1000);
    cam.position.set(10, 20, 30);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const scaled = cam.matrixWorld.clone().multiply(new Matrix4().makeScale(3, 3, 3));
    const b = cameraBasis(scaled, cam.projectionMatrix);
    expect(b.position.toArray()).toEqual([10, 20, 30]);
    expect(b.forward.length()).toBeCloseTo(1, 9);
    expect(b.forward.dot(new Vector3(-10, -20, -30).normalize())).toBeCloseTo(1, 9);
    expect(b.right.dot(b.forward)).toBeCloseTo(0, 9);
    expect(b.tanY).toBeCloseTo(Math.tan(Math.PI / 6), 9);
    expect(b.tanX).toBeCloseTo(2 * Math.tan(Math.PI / 6), 9);
  });

  it('wraps the noise origin to the noise period in metres', () => {
    const scale = 1 / (2 * Math.PI * 6371008.8); // equator: noise metres = ground metres
    const [x, z] = noiseOrigin({
      x: (5 * NOISE_PERIOD_M + 100) * scale,
      y: (3 * NOISE_PERIOD_M + 7) * scale,
      scale,
    });
    expect(x).toBeCloseTo(100, 3);
    expect(z).toBeCloseTo(7, 3);
  });

  it('uses the theme colour unless overridden', () => {
    expect(fogColor('night')).toBe(FOG_COLORS.night);
    expect(fogColor('day', 'red')).toBe('#ff0000');
    expect(fogColor('day', 'not a colour')).toBe(FOG_COLORS.day);
  });

  it('anchors noise to the world: a fixed point keeps its noise coordinate when the centre moves north', () => {
    const point: [number, number] = [2.35, 48.86];
    const coord = (centre: [number, number]) => {
      const origin = originAt(centre);
      const [ox, oz, k] = noiseOrigin(origin);
      const [x, , z] = localPosition(origin, point);
      const wrap = (v: number) => ((v % 4096) + 4096) % 4096;
      return [wrap(x * k + ox), wrap(z * k + oz)];
    };
    const a = coord([2.3, 48.8]);
    const b = coord([2.3, 48.85]); // ~5.5 km north
    expect(b[0]).toBeCloseTo(a[0]!, 3);
    expect(b[1]).toBeCloseTo(a[1]!, 3);
  });

  it('reports the off-centre projection shift (map padding) in view tangents', () => {
    const p = new PerspectiveCamera(60, 2, 1, 1000).projectionMatrix.clone();
    p.elements[8] = 0.4;
    p.elements[9] = -0.3;
    const b = cameraBasis(new Matrix4(), p);
    expect(b.offX).toBeCloseTo(0.4 * b.tanX, 9);
    expect(b.offY).toBeCloseTo(-0.3 * b.tanY, 9);
  });
});
