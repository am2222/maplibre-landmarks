import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import {
  cameraMatrix,
  EARTH_RADIUS_M,
  localPosition,
  mercatorUnitsPerMetre,
  mercatorX,
  mercatorY,
  originAt,
} from '../../src/core/mercator';

const METRES_PER_DEG_EQUATOR = (2 * Math.PI * EARTH_RADIUS_M) / 360;

describe('mercator', () => {
  it('maps lng/lat to unit mercator', () => {
    expect(mercatorX(0)).toBeCloseTo(0.5, 12);
    expect(mercatorX(-180)).toBeCloseTo(0, 12);
    expect(mercatorY(0)).toBeCloseTo(0.5, 12);
    expect(mercatorY(60)).toBeLessThan(0.5); // north is smaller y
  });

  it('scales metres by latitude', () => {
    expect(mercatorUnitsPerMetre(60) / mercatorUnitsPerMetre(0)).toBeCloseTo(2, 6);
  });

  it('places an anchor 100 m east / north in local glTF axes', () => {
    const lat = 48.8584;
    const origin = originAt([2.2945, lat]);
    const dLng = 100 / (METRES_PER_DEG_EQUATOR * Math.cos((lat * Math.PI) / 180));
    const [ex, ey, ez] = localPosition(origin, [2.2945 + dLng, lat], 0);
    expect(ex).toBeCloseTo(100, 1);
    expect(ey).toBe(0);
    expect(Math.abs(ez)).toBeLessThan(1e-6);

    const dLat = 100 / METRES_PER_DEG_EQUATOR;
    const [, , nz] = localPosition(origin, [2.2945, lat + dLat], 0);
    expect(nz).toBeCloseTo(-100, 0); // glTF Z points south, so north is negative
    expect(localPosition(origin, [2.2945, lat], 35)[1]).toBe(35);
  });

  it('cameraMatrix maps local axes onto mercator axes around the origin', () => {
    const origin = { x: 0.25, y: 0.75, scale: 1e-6 };
    const m = cameraMatrix(new Matrix4().identity().toArray(), origin);
    const east = new Vector3(1, 0, 0).applyMatrix4(m);
    const up = new Vector3(0, 1, 0).applyMatrix4(m);
    const south = new Vector3(0, 0, 1).applyMatrix4(m);
    expect(east.toArray()).toEqual([0.25 + 1e-6, 0.75, 0]);
    expect(up.x).toBe(0.25);
    expect(up.y).toBe(0.75);
    expect(up.z).toBeCloseTo(1e-6, 15);
    expect(south.x).toBe(0.25);
    expect(south.y).toBeCloseTo(0.75 + 1e-6, 15);
    expect(south.z).toBe(0);
  });

  it('cameraMatrix pre-multiplies the MapLibre main matrix', () => {
    const main = new Matrix4().makeScale(2, 2, 2);
    const m = cameraMatrix(main.toArray(), { x: 0, y: 0, scale: 1 });
    expect(new Vector3(1, 0, 0).applyMatrix4(m).x).toBe(2);
  });
});
