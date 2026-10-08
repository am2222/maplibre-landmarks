import { mercatorUnitsPerMetre, mercatorX, mercatorY } from '../core/mercator';
import type { LngLat } from '../core/types';

export interface ProbeTarget {
  key: string;
  lngLat: LngLat;
  /** Metres above sea level. */
  elevation: number;
}

const VERTEX = `#version 300 es
in vec3 a_pos;
uniform mat4 u_matrix;
uniform float u_size;
void main() { gl_Position = u_matrix * vec4(a_pos, 1.0); gl_PointSize = u_size; }`;

const FRAGMENT = `#version 300 es
precision lowp float;
out vec4 color;
void main() { color = vec4(0.0); }`;

interface Slot {
  key: string;
  x: number;
  y: number;
  z: number;
  /** Bumped whenever the probe position changes; answers for older revisions are stale. */
  revision: number;
  answered?: number;
  query?: InFlight;
}

interface InFlight {
  handle: WebGLQuery;
  slot: Slot;
  revision: number;
}

/** `main × translate(origin)`, computed in float64 so small relative positions stay exact. */
function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[i]!;
  for (let r = 0; r < 4; r++) out[12 + r] = m[r]! * ox + m[4 + r]! * oy + m[12 + r]!;
  return out;
}

/**
 * Draws one invisible point per label inside an occlusion query, against the depth buffer the
 * 3D layers left behind. Call `draw` only from a MapLibre render callback; `poll` any time.
 */
export class OcclusionProbe {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly uMatrix: WebGLUniformLocation | null;
  private readonly uSize: WebGLUniformLocation | null;
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();
  private origin: [number, number] = [0, 0];
  private uploaded = true;
  private readonly inFlight = new Set<InFlight>();
  private pool: WebGLQuery[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`label probe shader: ${log}`);
      }
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`label probe program: ${log}`);
    }
    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix');
    this.uSize = gl.getUniformLocation(program, 'u_size');
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  }

  get pending(): boolean {
    return this.inFlight.size > 0;
  }

  /** Some target has no current answer and no query in flight: draw again. */
  get needsDraw(): boolean {
    return this.slots.some((s) => !s.query && s.answered !== s.revision);
  }

  /** Replace the probed set. Positions upload on the next `draw`. */
  setTargets(targets: ProbeTarget[]): void {
    const next = new Map<string, Slot>();
    this.slots = targets.map((t) => {
      const [lng, lat] = t.lngLat;
      const x = mercatorX(lng);
      const y = mercatorY(lat);
      const z = t.elevation * mercatorUnitsPerMetre(lat);
      let slot = this.byKey.get(t.key);
      if (!slot) slot = { key: t.key, x, y, z, revision: 0 };
      else if (slot.x !== x || slot.y !== y || slot.z !== z) {
        Object.assign(slot, { x, y, z });
        slot.revision++;
      }
      next.set(t.key, slot);
      return slot;
    });
    this.byKey = next;
    this.origin = this.slots.length ? [this.slots[0]!.x, this.slots[0]!.y] : [0, 0];
    this.uploaded = false;
  }

  draw(mainMatrix: ArrayLike<number>, pointSizePx: number): void {
    if (!this.slots.length) return;
    const gl = this.gl;
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
      colors: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    };
    try {
      if (!this.uploaded) {
        const [ox, oy] = this.origin;
        const data = new Float32Array(this.slots.length * 3);
        this.slots.forEach((s, i) => data.set([s.x - ox, s.y - oy, s.z], i * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.uploaded = true;
      }
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix4fv(this.uMatrix, false, translated(mainMatrix, ...this.origin));
      gl.uniform1f(this.uSize, pointSizePx);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      this.slots.forEach((slot, i) => {
        if (slot.query) return;
        const handle = this.pool.pop() ?? gl.createQuery()!;
        const query: InFlight = { handle, slot, revision: slot.revision };
        slot.query = query;
        this.inFlight.add(query);
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, handle);
        gl.drawArrays(gl.POINTS, i, 1);
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      });
    } finally {
      gl.colorMask(saved.colors[0]!, saved.colors[1]!, saved.colors[2]!, saved.colors[3]!);
      gl.depthMask(saved.depthMask);
      gl.depthFunc(saved.depthFunc);
      if (saved.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(saved.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, saved.buffer);
      gl.useProgram(saved.program);
    }
  }

  /** Finished answers since the last poll: label key → visible. Stale answers are dropped. */
  poll(): Map<string, boolean> {
    const gl = this.gl;
    const out = new Map<string, boolean>();
    // A lost context reports every query available with a null (= "hidden") result.
    if (gl.isContextLost()) return out;
    for (const q of [...this.inFlight]) {
      if (!gl.getQueryParameter(q.handle, gl.QUERY_RESULT_AVAILABLE)) continue;
      const passed = !!gl.getQueryParameter(q.handle, gl.QUERY_RESULT);
      this.inFlight.delete(q);
      this.pool.push(q.handle);
      q.slot.query = undefined;
      if (this.byKey.get(q.slot.key) !== q.slot || q.revision !== q.slot.revision) continue;
      q.slot.answered = q.revision;
      out.set(q.slot.key, passed);
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const q of this.inFlight) gl.deleteQuery(q.handle);
    for (const handle of this.pool) gl.deleteQuery(handle);
    this.inFlight.clear();
    this.pool = [];
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
