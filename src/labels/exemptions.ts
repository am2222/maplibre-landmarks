/**
 * Per-map footprints whose labels must never be occluded (a landmark's own label). Owners
 * register a provider; the occlusion layer pulls on every scan, so add order does not matter.
 */
type Provider = () => number[][][][];

const providers = new WeakMap<object, Map<string, Provider>>();
const listeners = new WeakMap<object, Set<() => void>>();

export function setExemptionSource(map: object, owner: string, provider: Provider | null): void {
  let byOwner = providers.get(map);
  if (provider) {
    if (!byOwner) providers.set(map, (byOwner = new Map()));
    byOwner.set(owner, provider);
  } else {
    byOwner?.delete(owner);
  }
  notifyExemptionsChanged(map);
}

export function exemptionsFor(map: object): number[][][][] {
  return [...(providers.get(map)?.values() ?? [])].flatMap((provide) => provide());
}

export function notifyExemptionsChanged(map: object): void {
  for (const listener of [...(listeners.get(map) ?? [])]) listener();
}

/** Occlusion layers subscribe here to re-scan when exemptions change. */
export function onExemptionsChanged(map: object, listener: () => void): void {
  let set = listeners.get(map);
  if (!set) listeners.set(map, (set = new Set()));
  set.add(listener);
}

export function offExemptionsChanged(map: object, listener: () => void): void {
  listeners.get(map)?.delete(listener);
}
