import { MAX_RINGS } from './slices';

/** A horizontal fog layer: a square of `uRadius` around the map centre at its band's altitude. */
export const FOG_VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute float aSlice;
uniform float uAlt[64];
uniform float uRadius;
varying vec3 vWorld;

void main() {
  int i = int(aSlice + 0.5);
  vec3 w = vec3(aCorner.x * uRadius, uAlt[i], aCorner.y * uRadius);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

/** Uniforms, noise and the fog itself, shared by the layers and the rings. */
const FOG_COMMON = /* glsl */ `
// three declares viewMatrix for fragment shaders but not projectionMatrix (needed for depth).
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec2 uOrigin;
uniform vec2 uScroll;
uniform float uNoiseScale;
uniform float uTop;
uniform float uSoft;
uniform float uClip;
uniform float uDensity;
uniform float uCoverage;
uniform float uRadius;
uniform float uTime;
uniform float uCell;
uniform float uPeriod;
uniform float uStep;
uniform float uFloor;
uniform float uCeil;
uniform float uRingRatio;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// Value noise that tiles every 'period' cells horizontally.
float vnoise(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 per = vec3(period, 1.0e5, period);
  float a = hash(mod(i, per));
  float b = hash(mod(i + vec3(1.0, 0.0, 0.0), per));
  float c = hash(mod(i + vec3(0.0, 1.0, 0.0), per));
  float d = hash(mod(i + vec3(1.0, 1.0, 0.0), per));
  float e = hash(mod(i + vec3(0.0, 0.0, 1.0), per));
  float g = hash(mod(i + vec3(1.0, 0.0, 1.0), per));
  float h = hash(mod(i + vec3(0.0, 1.0, 1.0), per));
  float k = hash(mod(i + vec3(1.0, 1.0, 1.0), per));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Cells of uCell metres; periods uPeriod, 2·uPeriod, 4·uPeriod cells all equal 4096 m.
float fbm(vec3 p) {
  return (0.5 * vnoise(p, uPeriod) + 0.25 * vnoise(p * 2.0, uPeriod * 2.0)
    + 0.125 * vnoise(p * 4.0, uPeriod * 4.0)) / 0.875;
}

// Interleaved gradient noise (Jimenez 2014): a stable per-pixel value in [0, 1).
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Share of a ray's fog drawn by the rings: level rays run along the layers and cross almost none.
float ringShare(vec3 ray) {
  return 1.0 - smoothstep(0.04, 0.12, abs(ray.y));
}

void writeDepth(vec3 p) {
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = 0.5 * (gl_DepthRange.diff * (clip.z / clip.w) + gl_DepthRange.near + gl_DepthRange.far);
}

// Fog at point p on the ray, for a path of 'len' metres through it (alpha 0: none).
vec4 fogAt(vec3 p, vec3 ray, float len) {
  float alt = p.y;
  vec2 xz = mod(p.xz * uNoiseScale + uOrigin - uScroll, 4096.0);
  float n = fbm(vec3(xz.x / uCell, alt / 60.0 + uTime * 0.02, xz.y / uCell));
  // Far away, many noise cells fall into one pixel: settle toward the mean instead of shimmering.
  n = mix(n, 0.5, smoothstep(30.0 * uCell, 120.0 * uCell, length(p - uCamPos)));
  // The fog surface billows: it rises and falls with the noise.
  float top = uTop + (n - 0.5) * 2.0 * uSoft;
  float t = (top - alt) / uSoft;
  float fill = clamp(t, 0.0, 1.0);
  float banks = smoothstep(1.0 - uCoverage - 0.2, 1.0 - uCoverage + 0.2, n);
  float fade = 1.0 - smoothstep(0.75 * uRadius, uRadius, length(p.xz));
  float alpha = 1.0 - exp(-uDensity * 0.004 * banks * fade * fill * len);
  // Lit fog: brighter near its top (sky light), dimmer deep inside; forward sun scattering.
  float inside = clamp(t, 0.0, 3.0) / 3.0;
  vec3 base = uFogColor * mix(1.08, 0.82, inside);
  float glow = 0.35 * pow(max(dot(ray, uSunDir), 0.0), 6.0);
  return vec4(mix(base, uSunColor, glow), alpha);
}
`;

/**
 * One fog layer: the band of air it stands for, under the fog's billowing top, thresholded into
 * banks by world-anchored noise and lit brighter near the top. Each pixel tests depth at its own
 * dithered altitude inside the band, so terrain cutting through the stack makes fine grain rather
 * than contour bands. Near-level rays are left to the rings.
 */
export const FOG_FRAGMENT = /* glsl */ `
${FOG_COMMON}
varying vec3 vWorld;

void main() {
  vec3 ray = normalize(vWorld - uCamPos);
  float share = 1.0 - ringShare(ray);
  if (share <= 0.0) discard;
  // Dither the layer's altitude inside its band per pixel, and test depth at that point.
  float alt = vWorld.y + (ign(gl_FragCoord.xy) - 0.5) * uStep;
  float s = (alt - uCamPos.y) / ray.y;
  if (s <= 0.0) discard;
  vec3 p = uCamPos + ray * s;
  writeDepth(p);
  // Flat maps: no air below the ground plane (with terrain, uClip is far below).
  if (alt < uClip) discard;
  // Path through this layer's band of air.
  vec4 fog = fogAt(p, ray, share * uStep / abs(ray.y));
  if (fog.a < 0.002) discard;
  gl_FragColor = fog;
  #include <colorspace_fragment>
}
`;

/** An upright ring of radius uRingR[i] around the camera, from the fog floor to its ceiling. */
export const RING_VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute float aSlice;
uniform float uRingR[${MAX_RINGS}];
uniform vec3 uCamPos;
uniform float uFloor;
uniform float uCeil;
varying vec3 vWorld;
varying float vR;

void main() {
  int i = int(aSlice + 0.5);
  float a = aCorner.x * 6.28318530718;
  vR = uRingR[i];
  vec3 w = vec3(uCamPos.x + cos(a) * vR, mix(uFloor, uCeil, aCorner.y), uCamPos.z + sin(a) * vR);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

/**
 * One ring: the shell of air between it and its neighbours, for rays near level. Each pixel tests
 * depth at its own dithered distance inside the shell, as the layers do with altitude.
 */
export const RING_FRAGMENT = /* glsl */ `
${FOG_COMMON}
varying vec3 vWorld;
varying float vR;

void main() {
  vec3 ray = normalize(vWorld - uCamPos);
  float share = ringShare(ray);
  float level = length(ray.xz);
  if (share <= 0.0 || level < 1e-4) discard;
  float r = vR * pow(uRingRatio, ign(gl_FragCoord.xy) - 0.5);
  vec3 p = uCamPos + ray * (r / level);
  if (p.y < max(uFloor, uClip) || p.y > uCeil) discard;
  writeDepth(p);
  // Path through this ring's shell of air (rings are uRingRatio apart).
  float shell = r * (sqrt(uRingRatio) - 1.0 / sqrt(uRingRatio));
  vec4 fog = fogAt(p, ray, share * shell / level);
  if (fog.a < 0.002) discard;
  gl_FragColor = fog;
  #include <colorspace_fragment>
}
`;
