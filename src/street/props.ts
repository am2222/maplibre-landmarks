import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Overture `infrastructure` classes drawn as street furniture. */
export const PROP_KINDS = [
  'bench',
  'waste_basket',
  'recycling',
  'bollard',
  'fire_hydrant',
  'post_box',
  'bicycle_parking',
  'drinking_water',
  'vending_machine',
  'information',
  'street_cabinet',
  'charging_station',
  'fountain',
  'artwork',
  'communication_tower',
  'storage_tank',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** Muted colours that sit with the basemap (sRGB hex). */
export const PROP_COLOURS: Record<PropKind, number> = {
  bench: 0x6b5a46,
  waste_basket: 0x3f5a4a,
  recycling: 0x4b6f8a,
  bollard: 0x4a4d52,
  fire_hydrant: 0xa8433a,
  post_box: 0xc9a227,
  bicycle_parking: 0x7a7f86,
  drinking_water: 0x355e6b,
  vending_machine: 0x8a3f3f,
  information: 0x50606e,
  street_cabinet: 0x8c8f87,
  charging_station: 0x3d7a5a,
  fountain: 0x2f4a3a,
  artwork: 0x9a9184,
  communication_tower: 0x8d9096,
  storage_tank: 0xb9bcb8,
};

/** A box `w` × `h` × `d` metres standing on y = `y0`, centred at (x, z). */
const box = (w: number, h: number, d: number, x = 0, y0 = 0, z = 0) =>
  new BoxGeometry(w, h, d).translate(x, y0 + h / 2, z).toNonIndexed();
/** An upright cylinder of radius `r` and height `h` standing on y = `y0`. */
const post = (r: number, h: number, x = 0, y0 = 0, z = 0, sides = 8) =>
  new CylinderGeometry(r, r, h, sides).translate(x, y0 + h / 2, z).toNonIndexed();

function parts(kind: PropKind): BufferGeometry[] {
  switch (kind) {
    case 'bench':
      return [
        box(1.8, 0.06, 0.45, 0, 0.42, 0), // seat
        box(1.8, 0.4, 0.05, 0, 0.5, 0.22), // backrest, at the back (+Z)
        box(0.06, 0.42, 0.4, -0.8),
        box(0.06, 0.42, 0.4, 0.8),
      ];
    case 'waste_basket':
      return [post(0.04, 0.5), post(0.22, 0.55, 0, 0.35)];
    case 'recycling':
      return [box(1.6, 1.3, 1.1)];
    case 'bollard':
      return [post(0.09, 0.9)];
    case 'fire_hydrant':
      return [post(0.13, 0.6), post(0.09, 0.12, 0, 0.6), post(0.05, 0.12, 0.13, 0.35, 0, 6)];
    case 'post_box':
      return [box(0.45, 1.25, 0.35)];
    case 'bicycle_parking':
      // Three hoops: two legs and a top bar each, 0.8 m apart along x.
      return [-0.8, 0, 0.8].flatMap((x) => [
        box(0.05, 0.8, 0.05, x, 0, -0.3),
        box(0.05, 0.8, 0.05, x, 0, 0.3),
        box(0.05, 0.05, 0.65, x, 0.78, 0),
      ]);
    case 'drinking_water':
      return [post(0.16, 1.0), post(0.04, 0.15, 0, 1.0, -0.1, 6)];
    case 'vending_machine':
      return [box(0.9, 1.8, 0.8)];
    case 'information':
      return [
        box(0.08, 1.3, 0.08, -0.45),
        box(0.08, 1.3, 0.08, 0.45),
        box(1.1, 0.75, 0.05, 0, 0.9),
      ];
    case 'street_cabinet':
      return [box(0.8, 1.2, 0.4)];
    case 'charging_station':
      return [box(0.45, 1.6, 0.3)];
    case 'fountain':
      // Wallace-style: a base, a slender column and a small domed canopy (about 2.6 m).
      return [
        post(0.35, 0.4, 0, 0, 0, 12),
        post(0.12, 1.5, 0, 0.4, 0, 10),
        new CylinderGeometry(0.1, 0.42, 0.45, 12).translate(0, 2.12, 0).toNonIndexed(),
      ];
    case 'artwork':
      // A figure on a stone plinth.
      return [
        box(1.0, 1.2, 1.0),
        new CylinderGeometry(0.18, 0.26, 1.4, 8).translate(0, 1.9, 0).toNonIndexed(),
        post(0.13, 0.28, 0, 2.6, 0, 8),
      ];
    case 'communication_tower':
      // Unit height (scaled to the tagged height): a tapering square mast and a top antenna.
      return [
        new CylinderGeometry(0.012, 0.045, 0.92, 4, 1, false, Math.PI / 4)
          .translate(0, 0.46, 0)
          .toNonIndexed(),
        post(0.004, 0.08, 0, 0.92, 0, 4),
      ];
    case 'storage_tank':
      // Unit radius and height (scaled to the tank): a cylinder with a shallow cone roof.
      return [
        post(1, 1, 0, 0, 0, 20),
        new CylinderGeometry(0.05, 1, 0.15, 20).translate(0, 1.075, 0).toNonIndexed(),
      ];
  }
}

/** A prop of `kind` in metres, standing on y = 0, its front facing −Z (north before turning). */
export function propGeometry(kind: PropKind): BufferGeometry {
  const pieces = parts(kind).map((g) => {
    g.deleteAttribute('uv');
    return g;
  });
  const merged = mergeGeometries(pieces);
  if (!merged) throw new Error(`street prop geometry: ${kind}`);
  merged.computeVertexNormals();
  return merged;
}

const num = (v: unknown): number | undefined => {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Artwork types drawn: free-standing figures (not murals, architecture or installations). */
const FIGURES = new Set(['sculpture', 'statue', 'bust']);

/**
 * Scale of a prop from its OSM tags (`[x, y, z]`), or null when it is not drawn: masts are built
 * at unit height and tanks at unit radius and height; artworks other than figures and
 * underground tanks are skipped.
 */
export function propScale(
  kind: PropKind,
  tags: Record<string, unknown>,
): [number, number, number] | null {
  switch (kind) {
    case 'artwork':
      return FIGURES.has(String(tags.artwork_type ?? '').toLowerCase()) ? [1, 1, 1] : null;
    case 'communication_tower': {
      const h = num(tags.height) ?? 30;
      return [h, h, h];
    }
    case 'storage_tank': {
      if (String(tags.location ?? '') === 'underground') return null;
      const r = (num(tags.diameter) ?? 10) / 2;
      return [r, num(tags.height) ?? 8, r];
    }
    default:
      return [1, 1, 1];
  }
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** The OSM `direction` tag as degrees clockwise from north, when it is a number or compass point. */
export function directionDeg(tags: Record<string, unknown>): number | undefined {
  const raw = String(tags.direction ?? '').trim();
  if (!raw) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return ((Number(raw) % 360) + 360) % 360;
  const i = COMPASS.indexOf(raw.toUpperCase());
  return i >= 0 ? i * 22.5 : undefined;
}

/** A stable turn for an untagged prop, from its position (degrees, 0–360). */
export function hashedTurnDeg([lng, lat]: [number, number]): number {
  const h = Math.abs(Math.sin(lng * 12_989.8 + lat * 78_233.1)) * 43_758.5;
  return (h % 1) * 360;
}
