import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { OcclusionProbe } from '../../src/labels/probe';
import { fakeGl } from './fakeGl';

const MAIN = new Matrix4().makeScale(2, 2, 2).toArray();
const A = { key: 'a', lngLat: [2.29, 48.85] as [number, number], elevation: 2.5 };
const B = { key: 'b', lngLat: [2.3, 48.86] as [number, number], elevation: 2.5 };

describe('OcclusionProbe', () => {
  it('draws one query per target and restores every piece of GL state', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    expect(f.drawn.map((d) => d.first)).toEqual([0, 1]);
    expect(f.state).toMatchObject({
      program: f.mapleState.program,
      vao: f.mapleState.vao,
      buffer: f.mapleState.buffer,
      colorMask: [true, true, true, true],
      depthMask: true,
      depthTest: false,
      depthFunc: f.raw.LESS,
    });
    expect(probe.pending).toBe(true);
  });

  it('reads results only once available, then re-probes', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    expect(probe.poll().size).toBe(0); // nothing available yet
    probe.draw(MAIN, 4); // queries still in flight: nothing new drawn
    expect(f.drawn).toHaveLength(2);
    f.answer((first) => first === 0);
    expect(probe.poll()).toEqual(
      new Map([
        ['a', true],
        ['b', false],
      ]),
    );
    expect(probe.pending).toBe(false);
    probe.draw(MAIN, 4); // answered → probed again (keeps up while panning)
    expect(f.drawn).toHaveLength(2);
    expect(f.raw.createQuery).toHaveBeenCalledTimes(2); // queries reused from the pool
  });

  it('discards answers for moved or dropped targets', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    probe.setTargets([{ ...A, elevation: 40 }]); // A moved, B dropped
    f.answer(() => true);
    expect(probe.poll().size).toBe(0);
    expect(probe.needsDraw).toBe(true);
    probe.draw(MAIN, 4);
    f.answer(() => false);
    expect(probe.poll()).toEqual(new Map([['a', false]]));
  });

  it('folds the origin into the matrix in float64 and uploads relative positions', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(new Matrix4().identity().toArray(), 4);
    const matrix = f.raw.uniformMatrix4fv.mock.calls[0]![2] as Float32Array;
    const positions = f.raw.bufferData.mock.calls[0]![1] as Float32Array;
    expect(positions[0]).toBe(0); // first target is the origin
    expect(positions[1]).toBe(0);
    expect(matrix[12]).toBeCloseTo((A.lngLat[0] + 180) / 360, 6);
  });

  it('reads nothing from a lost context (its queries report available with null results)', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A]);
    probe.draw(MAIN, 4);
    f.answer(() => false);
    f.lose();
    expect(probe.poll().size).toBe(0);
  });

  it('throws on shader failure and deletes its objects on dispose', () => {
    const bad = fakeGl();
    bad.failCompile();
    expect(() => new OcclusionProbe(bad.gl)).toThrow(/label probe/);
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A]);
    probe.draw(MAIN, 4);
    probe.dispose();
    expect(f.raw.deleteQuery).toHaveBeenCalledTimes(1);
    expect(f.raw.deleteBuffer).toHaveBeenCalled();
    expect(f.raw.deleteVertexArray).toHaveBeenCalled();
    expect(f.raw.deleteProgram).toHaveBeenCalled();
  });
});
