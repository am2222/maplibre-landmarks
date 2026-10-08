export interface LevelPiece {
  key: string;
  /** Serialised feature properties: pieces of one water body share them. */
  props: string;
  /** Keys of the pieces across this piece's tile cuts. */
  links: string[];
}

/**
 * Pieces of one water body cut into tiles: linked across a tile cut, with the same properties.
 * Bounds alone are not enough: unnamed lakes all share their properties.
 */
export function levelGroups(pieces: LevelPiece[]): Map<string, string> {
  const props = new Map(pieces.map((p) => [p.key, p.props]));
  const parent = new Map<string, string>(pieces.map((p) => [p.key, p.key]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const p of pieces)
    for (const other of p.links)
      if (props.get(other) === p.props) parent.set(find(p.key), find(other));
  return new Map(pieces.map((p) => [p.key, find(p.key)]));
}

/**
 * Upper quartile of the ground sampled inside the water (x, y pairs), or null without data: the
 * DEM is noisy over water, and flat water must clear the draped ground it covers.
 */
export function flatLevel(
  at: number[],
  sample: (x: number, y: number) => number | null,
): number | null {
  const values: number[] = [];
  for (let i = 0; i < at.length; i += 2) {
    const e = sample(at[i]!, at[i + 1]!);
    if (e !== null) values.push(e);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(0.75 * (values.length - 1))]!;
}
