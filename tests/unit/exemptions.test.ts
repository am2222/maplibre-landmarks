import { describe, expect, it, vi } from 'vitest';
import {
  exemptionsFor,
  notifyExemptionsChanged,
  offExemptionsChanged,
  onExemptionsChanged,
  setExemptionSource,
} from '../../src/labels/exemptions';

const A = [
  [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
];
const B = [
  [
    [
      [5, 5],
      [6, 5],
      [6, 6],
      [5, 5],
    ],
  ],
];

describe('exemption registry', () => {
  it('notifies every listener on the map', () => {
    const map = {};
    const a = vi.fn();
    const b = vi.fn();
    onExemptionsChanged(map, a);
    onExemptionsChanged(map, b);
    notifyExemptionsChanged(map);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offExemptionsChanged(map, a);
    offExemptionsChanged(map, b);
  });

  it('pulls every owner’s footprints per map and notifies the listener', () => {
    const map = {};
    const other = {};
    const listener = vi.fn();
    onExemptionsChanged(map, listener);
    setExemptionSource(map, 'landmarks', () => A);
    setExemptionSource(map, 'other', () => B);
    expect(exemptionsFor(map)).toEqual([...A, ...B]);
    expect(exemptionsFor(other)).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    notifyExemptionsChanged(map);
    expect(listener).toHaveBeenCalledTimes(3);
    setExemptionSource(map, 'landmarks', null);
    expect(exemptionsFor(map)).toEqual(B);
    offExemptionsChanged(map, listener);
    notifyExemptionsChanged(map);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
