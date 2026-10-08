import { NOISE_PERIOD_M } from '../fog/slices';

/** Animation time wraps here (s); every wave makes a whole number of cycles in it. */
export const TIME_PERIOD_S = 2048;
/** River drift cycle (s): each of two phases drifts this long, then restarts. */
export const FLOW_CYCLE_S = 8;

export const WATER_VERTEX = /* glsl */ `
attribute float aShore;
attribute float aStyle;
attribute vec2 aFlow;
varying vec3 vWorld;
varying float vShore;
varying float vStyle;
varying vec2 vFlow;

// MapLibre's terrain mesh can sit metres above queryTerrainElevation: move each vertex toward
// the camera along its own line of sight (same pixel, nearer depth) so flat water wins the depth
// test against that error, while ridges in front (far more than 2% nearer) still hide it.
const float DEPTH_BIAS_M = 3.0;
const float DEPTH_BIAS_SHARE = 0.02;

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vShore = aShore;
  vStyle = aStyle;
  vFlow = aFlow;
  vec3 toEye = cameraPosition - w.xyz;
  float d = length(toEye);
  vec3 biased = w.xyz + normalize(cameraPosition - w.xyz) * min(DEPTH_BIAS_M + DEPTH_BIAS_SHARE * d, 0.5 * d);
  gl_Position = projectionMatrix * viewMatrix * vec4(biased, 1.0);
}
`;

/**
 * Water surface: directional sine waves plus value noise (all tiling with the shared 4096 m noise
 * frame, so the pattern stays anchored to the ground), normals from finite differences, Fresnel
 * toward the theme sky, a sun glint and foam on the shore ribbons. Rivers scroll along their flow.
 */
export const WATER_FRAGMENT = /* glsl */ `
uniform vec3 uDeep[4];
uniform vec3 uShallow[4];
uniform vec4 uWave[4];
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec2 uOrigin;
uniform float uNoiseScale;
uniform float uTime;
uniform float uWaves;
uniform float uRibbon;
varying vec3 vWorld;
varying float vShore;
varying float vStyle;
varying vec2 vFlow;

const float PERIOD = ${NOISE_PERIOD_M.toFixed(1)};
const float TIME_PERIOD = ${TIME_PERIOD_S.toFixed(1)};
const float TAU = 6.28318530718;
const float FLOW_CYCLE = ${FLOW_CYCLE_S.toFixed(1)};

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Value noise tiling every 'period' cells.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(mod(i, period));
  float b = hash(mod(i + vec2(1.0, 0.0), period));
  float c = hash(mod(i + vec2(0.0, 1.0), period));
  float d = hash(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Noise with cells of about 'size' metres that tiles with the noise frame.
float tiled(vec2 q, float size) {
  float cells = max(1.0, floor(PERIOD / size + 0.5));
  return vnoise(q * cells / PERIOD, cells);
}

// Surface height (about -1..1) at noise-frame metres q; w = (scale, amplitude, speed, shininess).
float surface(vec2 q, vec4 w) {
  float h = 0.0;
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float wavelength = w.x * (1.0 - 0.18 * fk);
    float a = fk * 1.9 + 0.4;
    // Whole cycles per PERIOD (space) and per TIME_PERIOD (time): no seam when either wraps.
    vec2 kv = floor(vec2(cos(a), sin(a)) * PERIOD / wavelength + 0.5);
    float hz = floor(w.z * sqrt(1.56 / wavelength) * TIME_PERIOD + 0.5) / TIME_PERIOD;
    h += sin(TAU * (dot(kv, q) / PERIOD - hz * uTime)) * (1.0 - 0.2 * fk);
  }
  h /= 2.8;
  h += (tiled(q, w.x * 0.6) + 0.5 * tiled(q, w.x * 0.3) - 0.75) * 1.2;
  return h;
}

// Surface slope (d/dx, d/dz) by finite differences.
vec2 slope(vec2 q, vec4 w) {
  float e = w.x * 0.05;
  float h0 = surface(q, w);
  return vec2(surface(q + vec2(e, 0.0), w) - h0, surface(q + vec2(0.0, e), w) - h0) / e;
}

void main() {
  int s = int(vStyle + 0.5);
  vec4 w = uWave[s];
  // Noise-frame metres.
  vec2 ground = vWorld.xz * uNoiseScale + uOrigin;
  vec2 q = mod(ground, PERIOD);
  vec2 grad;
  if (dot(vFlow, vFlow) > 1e-6) {
    // Rivers drift downstream at 2 m/s (scaled by the style speed) as a two-phase flow map: each
    // phase drifts for one cycle and restarts, half a cycle apart, cross-faded so neither restart
    // shows. Drift stays bounded, so flow that varies across a triangle never shears the waves.
    vec2 drift = vFlow * (2.0 * w.z * FLOW_CYCLE * uNoiseScale);
    float p1 = fract(uTime / FLOW_CYCLE);
    float p2 = fract(uTime / FLOW_CYCLE + 0.5);
    vec2 g1 = slope(mod(ground - drift * p1, PERIOD), w);
    vec2 g2 = slope(mod(ground - drift * p2, PERIOD), w);
    grad = mix(g2, g1, 1.0 - abs(1.0 - 2.0 * p1));
  } else {
    grad = slope(q, w);
  }
  // Far away, waves shrink below a pixel and alias into moiré: calm them with distance.
  float dist = length(cameraPosition - vWorld);
  float k = w.y * uWaves * w.x * 0.06 * (1.0 - smoothstep(30.0 * w.x, 150.0 * w.x, dist));
  vec3 n = normalize(vec3(-grad.x * k, 1.0, -grad.y * k));

  vec3 v = normalize(cameraPosition - vWorld);
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 base = mix(uDeep[s], uShallow[s], 0.25 + 0.75 * vShore);
  vec3 color = mix(base, uSky, fresnel);
  vec3 hlf = normalize(v + uSunDir);
  float glint = pow(max(dot(n, hlf), 0.0), w.w) * (w.w + 8.0) / 64.0;
  color += uSunColor * glint * step(0.0, uSunDir.y);
  // Foam where the water meets the shore, broken up by drifting noise.
  float foamNoise = tiled(q + vec2(uTime * 0.3, uTime * 0.17), 2.0);
  float foam = smoothstep(0.82, 1.0, vShore) * smoothstep(0.35, 0.7, foamNoise) * clamp(uWaves, 0.0, 1.0);
  color = mix(color, vec3(1.0), foam * 0.75);
  gl_FragColor = vec4(color, uRibbon > 0.5 ? vShore : 1.0);
  #include <colorspace_fragment>
}
`;
