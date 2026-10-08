import { vi } from 'vitest';

const C = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  ARRAY_BUFFER_BINDING: 0x8894,
  CURRENT_PROGRAM: 0x8b8d,
  VERTEX_ARRAY_BINDING: 0x85b5,
  COLOR_WRITEMASK: 0x0c23,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_TEST: 0x0b71,
  DEPTH_FUNC: 0x0b74,
  LESS: 0x0201,
  LEQUAL: 0x0203,
  FLOAT: 0x1406,
  POINTS: 0x0000,
  DYNAMIC_DRAW: 0x88e8,
  ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
};

/** Minimal WebGL2 stand-in: tracks the state the probe must restore and its queries. */
export function fakeGl() {
  let next = 1;
  const handle = () => ({ id: next++ });
  const mapleState = { program: handle(), vao: handle(), buffer: handle() };
  const state = {
    program: mapleState.program as unknown,
    vao: mapleState.vao as unknown,
    buffer: mapleState.buffer as unknown,
    colorMask: [true, true, true, true],
    depthMask: true,
    depthTest: false,
    depthFunc: C.LESS,
  };
  const queries = new Map<object, { available: boolean; result: number }>();
  const drawn: { first: number; query: object }[] = [];
  let active: object | null = null;
  let compileOk = true;
  let lost = false;
  const gl = {
    ...C,
    createShader: vi.fn(handle),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: () => compileOk,
    getShaderInfoLog: () => 'boom',
    deleteShader: vi.fn(),
    createProgram: vi.fn(handle),
    attachShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: vi.fn(),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    createBuffer: vi.fn(handle),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(handle),
    deleteVertexArray: vi.fn(),
    bindBuffer: (_t: number, b: unknown) => (state.buffer = b),
    bindVertexArray: (v: unknown) => (state.vao = v),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    bufferData: vi.fn(),
    useProgram: (p: unknown) => (state.program = p),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    colorMask: (...m: boolean[]) => (state.colorMask = m),
    depthMask: (m: boolean) => (state.depthMask = m),
    enable: (cap: number) => cap === C.DEPTH_TEST && (state.depthTest = true),
    disable: (cap: number) => cap === C.DEPTH_TEST && (state.depthTest = false),
    isEnabled: (cap: number) => cap === C.DEPTH_TEST && state.depthTest,
    depthFunc: (f: number) => (state.depthFunc = f),
    getParameter(p: number): unknown {
      switch (p) {
        case C.CURRENT_PROGRAM:
          return state.program;
        case C.VERTEX_ARRAY_BINDING:
          return state.vao;
        case C.ARRAY_BUFFER_BINDING:
          return state.buffer;
        case C.COLOR_WRITEMASK:
          return [...state.colorMask];
        case C.DEPTH_WRITEMASK:
          return state.depthMask;
        case C.DEPTH_FUNC:
          return state.depthFunc;
        default:
          return null;
      }
    },
    createQuery: vi.fn(() => {
      const q = handle();
      queries.set(q, { available: false, result: 0 });
      return q;
    }),
    deleteQuery: vi.fn(),
    beginQuery: (_t: number, q: object) => {
      active = q;
      queries.get(q)!.available = false;
    },
    endQuery: () => (active = null),
    drawArrays: (_mode: number, first: number) => drawn.push({ first, query: active! }),
    getQueryParameter: (q: object, p: number) => {
      const s = queries.get(q)!;
      return p === C.QUERY_RESULT_AVAILABLE ? s.available : s.result;
    },
    isContextLost: () => lost,
  };
  /** Answer every query drawn so far; `visible(first)` decides each probe's result. */
  const answer = (visible: (first: number) => boolean) => {
    for (const d of drawn)
      Object.assign(queries.get(d.query)!, { available: true, result: +visible(d.first) });
    drawn.length = 0;
  };
  const failCompile = () => (compileOk = false);
  const lose = () => (lost = true);
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    raw: gl,
    state,
    mapleState,
    drawn,
    answer,
    failCompile,
    lose,
  };
}
