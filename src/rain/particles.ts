import { BufferAttribute, BufferGeometry } from 'three';

/**
 * Particle quads for rain and snow: a random seed per particle (in [0, 1)³) and its quad's
 * corners (x: -1 | 1 across, y: 0 | 1 along), 4 vertices and 6 indices per particle.
 */
export function buildParticles(count: number, random: () => number): BufferGeometry {
  const seed = new Float32Array(count * 12);
  const corner = new Float32Array(count * 8);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const s = [random(), random(), random()];
    for (let k = 0; k < 4; k++) seed.set(s, (i * 4 + k) * 3);
    corner.set([-1, 0, 1, 0, -1, 1, 1, 1], i * 8);
    const v = i * 4;
    index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
  }
  const g = new BufferGeometry();
  // Positions are computed in the shader; three still wants a position attribute.
  g.setAttribute('position', new BufferAttribute(new Float32Array(count * 12), 3));
  g.setAttribute('aSeed', new BufferAttribute(seed, 3));
  g.setAttribute('aCorner', new BufferAttribute(corner, 2));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}
