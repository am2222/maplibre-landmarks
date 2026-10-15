export type Vec3 = [number, number, number];
export type RGB = [number, number, number];

export interface RoofMesh {
  positions: number[];
  normals: number[];
  colors: number[];
}

/** Highest point of `mesh` straight above (x, z), or null when no triangle covers it. */
export function heightAt({ positions: p }: RoofMesh, x: number, z: number): number | null {
  let top: number | null = null;
  for (let i = 0; i + 8 < p.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = p.slice(i, i + 9) as number[];
    // Barycentric weights of (x, z) in the triangle's plan.
    const d = (bz! - cz!) * (ax! - cx!) + (cx! - bx!) * (az! - cz!);
    if (Math.abs(d) < 1e-12) continue; // vertical face
    const u = ((bz! - cz!) * (x - cx!) + (cx! - bx!) * (z - cz!)) / d;
    const v = ((cz! - az!) * (x - cx!) + (ax! - cx!) * (z - cz!)) / d;
    if (u < -1e-9 || v < -1e-9 || 1 - u - v < -1e-9) continue;
    const y = u * ay! + v * by! + (1 - u - v) * cy!;
    if (top === null || y > top) top = y;
  }
  return top;
}

/** Collects flat-shaded triangles (one normal per face). */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  /** `faceUp` flips the winding of a triangle whose normal points down (roof surfaces). */
  triangle(a: Vec3, b: Vec3, c: Vec3, color: RGB, faceUp = false): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len;
    ny /= len;
    nz /= len;
    if (faceUp && ny < 0) {
      [b, c] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      this.normals.push(nx, ny, nz);
      this.colors.push(...color);
    }
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: RGB): void {
    this.triangle(a, b, c, color);
    this.triangle(a, c, d, color);
  }

  build(): RoofMesh {
    return { positions: this.positions, normals: this.normals, colors: this.colors };
  }
}
