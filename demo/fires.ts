// Sample fire perimeters for the demo: lobed, wind-stretched shapes in the Santa Monica Mountains.

type Ring = number[][];

/** A ragged perimeter of about `radiusM` around [lng, lat], stretched toward `towardDeg`. */
function perimeter(
  [lng, lat]: [number, number],
  radiusM: number,
  towardDeg: number,
  seed: number,
): Ring {
  const phi = ((90 - towardDeg) * Math.PI) / 180; // compass → maths angle
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ring: Ring = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const r =
      radiusM *
      (1 +
        0.38 * Math.cos(a - phi) +
        0.14 * Math.sin(3 * a + seed) +
        0.09 * Math.sin(5 * a + 2 * seed) +
        0.06 * Math.sin(7 * a + 3 * seed));
    ring.push([lng + (r * Math.cos(a)) / kx, lat + (r * Math.sin(a)) / 110_574]);
  }
  ring.push(ring[0]!);
  return ring;
}

const feature = (rings: Ring[], properties: Record<string, unknown>) => ({
  type: 'Feature' as const,
  properties,
  geometry: { type: 'Polygon', coordinates: rings },
});

export const FIRE_CENTER: [number, number] = [-118.62, 34.09];

/**
 * A main fire with an unburned island, a faster spot fire downwind (merging as they grow), and
 * a contained fire that only shows burned ground.
 */
export function sampleFires() {
  const [lng, lat] = FIRE_CENTER;
  return {
    type: 'FeatureCollection' as const,
    features: [
      feature(
        [
          perimeter([lng, lat], 900, 45, 1),
          perimeter([lng + 0.002, lat - 0.001], 180, 0, 4).reverse(),
        ],
        { name: 'Main fire' },
      ),
      feature([perimeter([lng + 0.026, lat + 0.014], 300, 45, 2)], {
        name: 'Spot fire',
        rate: 1.6,
      }),
      feature([perimeter([lng - 0.035, lat - 0.012], 600, 90, 3)], {
        name: 'Contained fire',
        active: false,
      }),
    ],
  };
}
