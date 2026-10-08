import { Matrix4 } from 'three';
import type { LngLat, Origin } from './types';

export const EARTH_RADIUS_M = 6371008.8;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

export function mercatorX(lng: number): number {
  return (180 + lng) / 360;
}

export function mercatorY(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

/** Same as MapLibre's meterInMercatorCoordinateUnits / mercatorZfromAltitude scale. */
export function mercatorUnitsPerMetre(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180));
}

export function originAt([lng, lat]: LngLat): Origin {
  return { x: mercatorX(lng), y: mercatorY(lat), scale: mercatorUnitsPerMetre(lat) };
}

/** Anchor position relative to the origin, in glTF axes (X east, Y up, Z south) and metres. */
export function localPosition(
  origin: Origin,
  [lng, lat]: LngLat,
  elevationM = 0,
): [number, number, number] {
  return [
    (mercatorX(lng) - origin.x) / origin.scale,
    elevationM,
    (mercatorY(lat) - origin.y) / origin.scale,
  ];
}

/**
 * Clip-space matrix for local glTF metres around `origin`: mainMatrix × M, where M maps
 * local (x, y, z) to mercator (ox + x·s, oy + z·s, y·s). Computed in float64 so small
 * local coordinates stay precise at high zoom.
 */
export function cameraMatrix(mainMatrix: ArrayLike<number>, origin: Origin): Matrix4 {
  const s = origin.scale;
  const local = new Matrix4().set(s, 0, 0, origin.x, 0, 0, s, origin.y, 0, s, 0, 0, 0, 0, 0, 1);
  return new Matrix4().fromArray(Array.from(mainMatrix)).multiply(local);
}

/** Inverse of localPosition's horizontal part: local glTF metres (X east, Z south) to lng/lat. */
export function lngLatAt(origin: Origin, x: number, z: number): LngLat {
  const mx = origin.x + x * origin.scale;
  const my = origin.y + z * origin.scale;
  return [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI];
}
