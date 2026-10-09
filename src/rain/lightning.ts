/** One pulse of a lightning flash: when it starts (seconds into the strike) and how bright. */
export interface Pulse {
  at: number;
  amp: number;
}

/** Each pulse fades with this time constant (seconds). */
const PULSE_DECAY_S = 0.07;
/** A strike is over once its last pulse has faded (seconds after that pulse). */
const TAIL_S = 0.5;

/** 1–3 flickers within a quarter second, the first the brightest, as a real strike flickers. */
export function strikePulses(rand: () => number): Pulse[] {
  const count = 1 + Math.floor(rand() * 3);
  const pulses: Pulse[] = [{ at: 0, amp: 1 }];
  for (let i = 1; i < count; i++)
    pulses.push({ at: pulses[i - 1]!.at + 0.06 + rand() * 0.12, amp: 0.45 + rand() * 0.45 });
  return pulses;
}

/** Flash brightness 0–1 at `t` seconds into a strike. */
export function flashAt(pulses: Pulse[], t: number): number {
  let flash = 0;
  for (const p of pulses)
    if (t >= p.at) flash = Math.max(flash, p.amp * Math.exp(-(t - p.at) / PULSE_DECAY_S));
  return flash;
}

/** Seconds from the start of a strike until it has faded out. */
export function strikeLength(pulses: Pulse[]): number {
  return (pulses[pulses.length - 1]?.at ?? 0) + TAIL_S;
}

/** Seconds until the next strike: `meanS` on average, never closer than a fifth of it. */
export function nextStrikeIn(meanS: number, rand: () => number): number {
  const min = meanS * 0.2;
  // Exponential (a Poisson process) above the minimum gap.
  return min + -Math.log(1 - rand() * 0.999) * (meanS - min);
}

export type Point3 = [number, number, number];

/**
 * A jagged bolt from `top` down to `ground` (local metres, Y up) as line segments: a main
 * channel of about `steps` kinks plus up to two side branches that fork off it and stop in
 * mid-air.
 */
export function boltSegments(
  top: Point3,
  ground: Point3,
  rand: () => number,
  steps = 28,
): [Point3, Point3][] {
  const height = top[1] - ground[1];
  const jag = height * 0.035;
  const main: Point3[] = [];
  // A wandering walk sideways (pinned at both ends), with uneven step heights, so the channel
  // kinks like a real one instead of zig-zagging evenly.
  let wx = 0;
  let wz = 0;
  let k = 0;
  for (let i = 0; i <= steps; i++) {
    const pin = Math.sin(Math.PI * k);
    main.push([
      top[0] + (ground[0] - top[0]) * k + wx * pin,
      top[1] - height * k,
      top[2] + (ground[2] - top[2]) * k + wz * pin,
    ]);
    if (k >= 1) break;
    wx = wx * 0.8 + (rand() - 0.5) * 2 * jag;
    wz = wz * 0.8 + (rand() - 0.5) * 2 * jag;
    k = i + 1 >= steps ? 1 : Math.min(1, k + (0.4 + rand() * 1.2) / steps);
  }
  const segments: [Point3, Point3][] = [];
  for (let i = 0; i < main.length - 1; i++) segments.push([main[i]!, main[i + 1]!]);
  const branches = Math.floor(rand() * 3);
  for (let b = 0; b < branches; b++) {
    let p = main[2 + Math.floor(rand() * (main.length / 2))]!;
    const angle = rand() * Math.PI * 2;
    const reach = height * (0.06 + rand() * 0.06);
    for (let s = 0; s < 4; s++) {
      const next: Point3 = [
        p[0] + Math.cos(angle) * reach * (0.6 + rand() * 0.8),
        p[1] - height * (0.04 + rand() * 0.04),
        p[2] + Math.sin(angle) * reach * (0.6 + rand() * 0.8),
      ];
      segments.push([p, next]);
      p = next;
    }
  }
  return segments;
}
