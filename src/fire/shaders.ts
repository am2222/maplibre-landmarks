import { NOISE_PERIOD_M } from '../fog/slices';

/** Animation time wraps here (s). */
export const TIME_PERIOD_S = 1000;

/**
 * Shared by every fire shader. Lengths in "units" scale with the front depth (a unit is a
 * seventh of it), so one setting sizes the whole look; noise runs in the shared noise frame
 * (tiling every NOISE_PERIOD_M) so the pattern stays on the ground as the view moves.
 */
const COMMON = /* glsl */ `
uniform vec2 uOrigin;
uniform float uNoiseScale;
uniform float uUnit;
uniform float uTime;
uniform vec2 uDrift;
uniform float uGrowth;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uSlope;
uniform float uBand;
uniform sampler2D uField;
uniform vec3 uFieldRect;
uniform vec2 uFieldSize;
uniform sampler2D uHeight;
uniform vec3 uHeightRect;
uniform vec2 uHeightSize;

const float PERIOD = ${NOISE_PERIOD_M.toFixed(1)};

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

float fbm(vec2 q, float size) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * tiled(q + vec2(13.7, 71.3) * float(i) * size, size);
    size *= 0.5;
    a *= 0.5;
  }
  return v;
}

// Noise-frame metres of a local position.
vec2 noiseAt(vec2 local) {
  return mod(local * uNoiseScale + uOrigin, PERIOD);
}

// How far the front is pushed out or pulled in by its broken edge, in units.
float ragged(vec2 q) {
  return (fbm(q, uUnit / 0.035) - 0.5) * 9.0 + (fbm(q + 7.3 * uUnit, uUnit / 0.14) - 0.5) * 3.0;
}

vec3 fireRamp(float x) {
  vec3 c = mix(vec3(0.35, 0.02, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.4, x));
  c = mix(c, vec3(1.0, 0.62, 0.12), smoothstep(0.35, 0.7, x));
  return mix(c, vec3(1.0, 0.93, 0.72), smoothstep(0.72, 1.0, x));
}

// ACES filmic fit: bright fire rolls off instead of clipping (there is no bloom pass).
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Grid texture (nearest-filtered floats) at texel coordinates f, bilinear, clamped to the edge.
vec4 texel(sampler2D t, vec2 size, vec2 i) {
  return texture2D(t, (clamp(i, vec2(0.0), size - 1.0) + 0.5) / size);
}
vec4 bilerp(sampler2D t, vec2 size, vec2 f) {
  vec2 i = floor(f);
  vec2 w = f - i;
  return mix(
    mix(texel(t, size, i), texel(t, size, i + vec2(1.0, 0.0)), w.x),
    mix(texel(t, size, i + vec2(0.0, 1.0)), texel(t, size, i + vec2(1.0, 1.0)), w.x),
    w.y
  );
}

// Distance to the burned area (m, negative inside), the nearest fire's spread, its active flag.
vec3 field(vec2 local) {
  return bilerp(uField, uFieldSize, (local - uFieldRect.xy) / uFieldRect.z - 0.5).rgb;
}

float heightAt(vec2 local) {
  return bilerp(uHeight, uHeightSize, (local - uHeightRect.xy) / uHeightRect.z).r;
}

// Rise per metre east and south.
vec2 gradeAt(vec2 local) {
  float e = uHeightRect.z;
  return vec2(
    heightAt(local + vec2(e, 0.0)) - heightAt(local - vec2(e, 0.0)),
    heightAt(local + vec2(0.0, e)) - heightAt(local - vec2(0.0, e))
  ) / (2.0 * e);
}

// Spread factor of a front facing n: faster with the wind and uphill, slower backing down.
float spread(vec2 n, vec2 local) {
  float uphill = clamp(dot(n, gradeAt(local)) * 3.0, -0.5, 2.0);
  return max(0.15, 1.0 + uWind * dot(n, uWindDir) + uSlope * uphill);
}
`;

/** Vertex shaders only. */
const BIAS = /* glsl */ `
// MapLibre's terrain mesh can sit metres off queryTerrainElevation: like the water, move each
// vertex toward the camera along its line of sight so the ground wins the depth test.
vec4 biasedClip(vec3 world) {
  float d = length(cameraPosition - world);
  vec3 biased = world + normalize(cameraPosition - world) * min(3.0 + 0.02 * d, 0.5 * d);
  return projectionMatrix * viewMatrix * vec4(biased, 1.0);
}
`;

export const GROUND_VERTEX = /* glsl */ `
${COMMON}
${BIAS}
varying vec2 vLocal;

void main() {
  vLocal = position.xz;
  gl_Position = biasedClip((modelMatrix * vec4(position, 1.0)).xyz);
}
`;

/**
 * The ground under and around the fires: black, ash-flecked burned ground; a turbulent,
 * wind-blown flaming front (deeper at the head); smouldering embers behind it; scorch and
 * firelight on the unburned ground ahead. Premultiplied alpha: char covers the map, light adds.
 */
export const GROUND_FRAGMENT = /* glsl */ `
${COMMON}
uniform float uGlow;
uniform float uChar;
uniform float uIntensity;
varying vec2 vLocal;

void main() {
  vec3 f = field(vLocal);
  float d = f.r / uUnit;
  float grow = uGrowth * f.g;
  // Beyond the farthest the front can reach plus its light: nothing to draw.
  if (d - grow * (1.0 + uWind + 2.0 * uSlope) - 12.0 > uGlow * 4.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float e = uFieldRect.z;
  vec2 n = normalize(vec2(
    field(vLocal + vec2(e, 0.0)).r - field(vLocal - vec2(e, 0.0)).r,
    field(vLocal + vec2(0.0, e)).r - field(vLocal - vec2(0.0, e)).r
  ) + 1e-5);
  vec2 q = noiseAt(vLocal);
  float burning = f.b;

  float align = dot(n, uWindDir);
  float dn = d - grow * spread(n, vLocal) + ragged(q);   // grown, ragged distance (neg = burned)
  float head = clamp(align * uWind, 0.0, 1.5) * burning;
  float band = uBand * (1.0 + 0.8 * head);               // deeper flaming zone at the head
  float t = -dn;                                         // depth behind the front

  // Burned black: char with ash patches; scorched ground just ahead of the front.
  float burnMix = smoothstep(-0.6, 0.8, t);
  float ash = smoothstep(0.5, 0.75, fbm(q + 5.0 * uUnit, uUnit / 0.07));
  vec3 burnt = mix(vec3(0.025, 0.022, 0.02), vec3(0.11, 0.105, 0.1), ash * 0.8);
  float outside = max(dn, 0.0);
  float scorch = exp(-outside / 3.0) * (1.0 - burnMix) * 0.45;
  float alpha = (burnMix + scorch) * uChar;
  vec3 color = burnt * burnMix * uChar;

  // Firelight on the ground ahead.
  float light = exp(-outside / uGlow) * (1.0 - burnMix) * burning;
  float flick = 0.8 + 0.2 * vnoise(vec2(uTime * 3.0, q.x / (50.0 * uUnit)), 4096.0);
  // Mostly squared: the sRGB output lifts faint light a lot, so the tail must fall off fast.
  vec3 glow = (vec3(0.1, 0.035, 0.01) * light + vec3(0.45, 0.13, 0.02) * light * light) * flick;

  // Flaming front: turbulent, wind-advected.
  float S = uUnit / 0.09;
  vec2 w = mod(q - uDrift, PERIOD);
  vec2 warp = vec2(fbm(w + uTime * 0.4 * S, S / 1.3), fbm(w - uTime * 0.5 * S, S / 1.1));
  float turb = fbm(w + warp * 1.4 * S, S);
  float inBand = smoothstep(-0.8, 0.6, t) * (1.0 - smoothstep(band * 0.55, band, t)) * burning;
  float h = clamp(1.0 - t / band, 0.0, 1.0);
  float heat = inBand * clamp(h * 0.75 + turb * 0.9 - 0.25, 0.0, 1.2);
  vec3 fire = fireRamp(clamp(heat, 0.0, 1.0)) * heat * (2.2 + 1.8 * head);

  // Smouldering embers behind the front, decaying with depth.
  float deep = max(t - band * 0.55, 0.0);
  float emberMask = exp(-deep / (uBand * 3.0)) * smoothstep(band * 0.4, band * 0.8, t) * burning;
  float spots = smoothstep(0.68, 0.9, tiled(q + 17.0 * uUnit, uUnit / 0.55))
    * (0.5 + 0.5 * tiled(q + uTime * 1.5 * uUnit / 0.3, uUnit / 0.3));
  vec3 embers = vec3(1.0, 0.22, 0.03)
    * (spots * 1.6 + 0.12 * fbm(q + uTime * 0.2 * uUnit / 0.2, uUnit / 0.2)) * emberMask;
  glow += vec3(0.5, 0.12, 0.02) * exp(-deep / (uBand * 1.2)) * burnMix * 0.35 * burning;

  vec3 emit = aces((glow + fire + embers) * uIntensity);
  gl_FragColor = vec4(min(color + emit, vec3(1.0)), alpha);
  #include <colorspace_fragment>
}
`;

/**
 * Billboard particles rising from the front (vertex shaders): each instance is a quad
 * (corners in `position`) at a front point, animated entirely from uTime and its seed.
 */
const PARTICLE = /* glsl */ `
attribute vec2 aBase;
attribute vec2 aN;
attribute vec2 aFire;
attribute float aSeed;
uniform float uLift;
varying vec2 vUv;
varying float vAge;
varying float vSeed;

// Where the ground's ragged front is now for perimeter point p facing n (two fixed-point steps).
vec2 frontPoint(vec2 p, vec2 n, float rate) {
  float g = uGrowth * rate * spread(n, p);
  vec2 e = p + n * g * uUnit;
  e = p + n * (g - ragged(noiseAt(e))) * uUnit;
  return p + n * (g - ragged(noiseAt(e))) * uUnit;
}

// Camera-facing quad of 'size' metres at local position 'local'.
vec4 billboard(vec3 local, float size) {
  vec4 world = modelMatrix * vec4(local, 1.0);
  vec3 toEye = cameraPosition - world.xyz;
  float d = length(toEye);
  world.xyz += toEye / d * min(3.0 + 0.02 * d, 0.5 * d);
  vec4 view = viewMatrix * world;
  view.xy += position.xy * size;
  return projectionMatrix * view;
}
`;

/** Shared by the particle fragment shaders: cheap non-tiling noise over the sprite. */
const SPRITE = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vAge;
varying float vSeed;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
vec3 fireRamp(float x) {
  vec3 c = mix(vec3(0.35, 0.02, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.4, x));
  c = mix(c, vec3(1.0, 0.62, 0.12), smoothstep(0.35, 0.7, x));
  return mix(c, vec3(1.0, 0.93, 0.72), smoothstep(0.72, 1.0, x));
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
`;

/** Flame tongues: short-lived puffs in the flaming band, rising, leaning downwind, shrinking. */
export const FLAME_VERTEX = /* glsl */ `
${COMMON}
${PARTICLE}
uniform float uFlameH;
varying float vHead;

void main() {
  float head = clamp(dot(aN, uWindDir) * uWind, 0.0, 1.5);
  float life = 0.6 + 0.7 * aSeed;
  float age = fract(uTime / life + aSeed * 7.13);
  // Somewhere in the flaming band, just behind the front.
  vec2 e = frontPoint(aBase, aN, aFire.x) - aN * uBand * uUnit * (0.1 + 0.45 * fract(aSeed * 13.7));
  float H = uFlameH * uUnit * (0.55 + 0.7 * head) * (0.6 + 0.8 * fract(aSeed * 5.3));
  vec3 local = vec3(e.x, heightAt(e) + uLift + age * H, e.y);
  local.xz += uWindDir * uWind * age * H * 0.5;
  float size = uUnit * (1.4 + 1.1 * head) * (1.0 - 0.55 * age) * (0.7 + 0.6 * fract(aSeed * 3.1));
  gl_Position = billboard(local, size * aFire.y);
  vUv = position.xy * 0.5 + 0.5;
  vAge = age;
  vSeed = aSeed;
  vHead = head;
}
`;

export const FLAME_FRAGMENT = /* glsl */ `
${SPRITE}
varying float vHead;

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float n = fbm(c * 2.2 + vec2(vSeed * 31.0, vSeed * 17.0 - uTime * 2.5));
  // Ragged and narrower toward the top.
  float r = length(vec2(c.x * (1.0 + 0.5 * max(c.y, 0.0)), c.y));
  float a = smoothstep(1.0, 0.1, r + (n - 0.5) * 1.1);
  float heat = a * (1.0 - vAge) * (0.7 + 0.3 * vHead);
  // Orange tongues with yellow cores: kept below white so neighbours stay distinct.
  vec3 color = fireRamp(clamp(heat * 0.95, 0.0, 1.0)) * heat * 0.85 * uIntensity;
  gl_FragColor = vec4(aces(color), 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Smoke: soft puffs that rise off the front as a column, level off at the smoke height and
 * trail downwind as a plume that widens and thins out. Premultiplied alpha; lit by the
 * theme's sun, glowing orange where they leave the fire.
 */
export const SMOKE_VERTEX = /* glsl */ `
${COMMON}
${PARTICLE}
uniform float uSmokeH;
uniform float uPlume;
varying float vAlpha;

void main() {
  float life = 30.0 + 20.0 * aSeed;
  float age = fract(uTime / life + aSeed * 3.71);
  vec2 e = frontPoint(aBase, aN, aFire.x) - aN * uBand * uUnit * 0.5 * fract(aSeed * 11.0);
  // Column: climbs quickly, then levels off (with some spread in height along the plume).
  float rise = uSmokeH * (1.0 - exp(-age * 7.0)) * (1.0 + (fract(aSeed * 5.9) - 0.5) * 0.5 * age);
  // Plume: barely moves sideways while climbing, then trails downwind and fans out.
  float along = uPlume * pow(age, 1.3);
  float across = (fract(aSeed * 17.3) - 0.5) * age * (uPlume * 0.22 + uSmokeH * 0.3);
  vec2 side = vec2(-uWindDir.y, uWindDir.x);
  vec3 local = vec3(e.x, heightAt(e) + uLift + rise, e.y);
  local.xz += uWindDir * along + side * across;
  local.xz += vec2(sin(uTime * 0.21 + aSeed * 40.0), cos(uTime * 0.17 + aSeed * 23.0)) * age * uUnit * 6.0;
  // Grows to a share of the plume's width so a fixed count still reads as one plume far out.
  float size = mix(uUnit * 2.5, max(uUnit * 16.0, uPlume * 0.08 + uSmokeH * 0.12), age)
    * (0.7 + 0.6 * fract(aSeed * 9.7));
  gl_Position = billboard(local, size * aFire.y);
  vUv = position.xy * 0.5 + 0.5;
  vAge = age;
  vSeed = aSeed;
  // Fades in fast, thins out gradually along the plume.
  // Fades in fast; thins as it spreads (a puff 4× wider holds its smoke over 16× the area).
  float spreadOut = uUnit * 2.5 / size;
  vAlpha = smoothstep(0.0, 0.04, age) * (1.0 - smoothstep(0.4, 1.0, age))
    * clamp(sqrt(spreadOut) * 1.6, 0.12, 1.0) * aFire.y;
}
`;

export const SMOKE_FRAGMENT = /* glsl */ `
${SPRITE}
uniform float uSmoke;
uniform vec3 uSmokeLight;
varying float vAlpha;

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float n = fbm(c * 1.7 + vec2(vSeed * 23.0, vSeed * 7.0 + uTime * 0.06));
  // A billow: ragged edge, thick core.
  float a = smoothstep(0.95, 0.0, length(c) + (n - 0.5) * 1.3);
  float density = a * vAlpha * uSmoke * 0.45;
  if (density < 0.002) discard;
  // Sunlit top, dark underside, billows picked out by the noise.
  float shade = clamp(0.5 + 0.45 * c.y + (n - 0.5) * 1.2, 0.0, 1.0);
  shade *= shade;
  vec3 color = mix(vec3(0.018, 0.016, 0.013), vec3(0.24, 0.22, 0.19), shade) * uSmokeLight;
  // Grey-brown, darkest and thickest where it leaves the fire.
  color *= mix(0.5, 1.0, smoothstep(0.0, 0.5, vAge));
  // Underlit by the flames while young.
  color += vec3(1.0, 0.32, 0.06) * pow(1.0 - vAge, 8.0) * clamp(0.3 - c.y, 0.0, 1.0) * 0.9 * uIntensity;
  // Convert before premultiplying: sRGB lifts faint values, so converting the premultiplied
  // colour would brighten every thin layer and stack them up to white.
  gl_FragColor = vec4(linearToOutputTexel(vec4(color, 1.0)).rgb * density, density);
}
`;

/** Embers: round, additive points a few pixels across, sized by distance. */
export const EMBER_VERTEX = /* glsl */ `
attribute vec3 color;
uniform float uSize;
uniform float uPixels;
varying vec3 vColor;

void main() {
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(uSize * projectionMatrix[1][1] * uPixels / max(gl_Position.w, 1e-3), 1.5, 8.0);
}
`;

export const EMBER_FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  gl_FragColor = vec4(vColor * a * a, 1.0);
  #include <colorspace_fragment>
}
`;
