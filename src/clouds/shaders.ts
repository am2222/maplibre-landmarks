/** The cloud deck's bottom and top: squares of `uRadius` around the camera at uBase and uTop. */
export const DECK_VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute float aFace;
uniform float uRadius;
uniform float uBase;
uniform float uTop;
uniform vec3 uCamPos;
varying vec3 vWorld;
varying float vFace;

void main() {
  vFace = aFace;
  vec3 w = vec3(uCamPos.x + aCorner.x * uRadius, aFace > 0.5 ? uTop : uBase, uCamPos.z + aCorner.y * uRadius);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  // The deck reaches far past MapLibre's far plane: keep it just inside, so it isn't clipped.
  // Only depth changes; the fragment shader rebuilds the ray from vWorld.
  if (gl_Position.w > 0.0) gl_Position.z = min(gl_Position.z, gl_Position.w * 0.99999);
}
`;

/** A ground square of `uRadius` around the camera, for the cloud shadows. */
export const SHADOW_VERTEX = /* glsl */ `
attribute vec2 aCorner;
uniform float uRadius;
uniform float uGround;
uniform vec3 uCamPos;
varying vec3 vWorld;

void main() {
  vec3 w = vec3(uCamPos.x + aCorner.x * uRadius, uGround, uCamPos.z + aCorner.y * uRadius);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

/**
 * Cloud density: world-anchored value noise (tiling every uPeriod cells, like the fog's) shaped
 * by coverage and a vertical profile (flat-ish bottoms, rounded tops), eroded by finer noise.
 */
const CLOUD_COMMON = /* glsl */ `
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform float uBase;
uniform float uTop;
uniform vec2 uOrigin;
uniform vec2 uScroll;
uniform float uNoiseScale;
uniform float uCell;
uniform float uPeriod;
uniform float uCoverage;
uniform float uDensity;
uniform float uTime;
uniform float uRadius;
uniform vec3 uSunDir;
uniform float uDeckFade;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

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

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** 0–1 density at p; 'detail' adds the eroding octave (skipped for cheap light samples). */
float cloudDensity(vec3 p, bool detail) {
  float h = (p.y - uBase) / (uTop - uBase);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec2 xz = mod(p.xz * uNoiseScale + uOrigin - uScroll, uPeriod * uCell);
  vec3 q = vec3(xz.x / uCell, h * 1.5 + uTime * 0.004, xz.y / uCell);
  float n = 0.55 * vnoise(q, uPeriod) + 0.3 * vnoise(q * 2.0, uPeriod * 2.0)
    + 0.15 * vnoise(q * 4.0, uPeriod * 4.0);
  // Thin at the bottom edge, puffy and rounded toward the top.
  float profile = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.4, 1.0, h));
  float shape = n - (1.0 - uCoverage) - (1.0 - profile) * 0.35;
  if (detail && shape > -0.05) shape -= 0.12 * vnoise(q * 9.0, uPeriod * 9.0);
  return clamp(shape * 4.0, 0.0, 1.0);
}

/** Entry and exit distances of the ray through the deck (exit < entry: missed). */
vec2 slab(vec3 ray) {
  if (abs(ray.y) < 1e-5) {
    bool inside = uCamPos.y > uBase && uCamPos.y < uTop;
    return inside ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  }
  float a = (uBase - uCamPos.y) / ray.y;
  float b = (uTop - uCamPos.y) / ray.y;
  return vec2(max(min(a, b), 0.0), max(a, b));
}

// Depth of p, kept just in front of the far plane like the geometry (clouds beyond it still draw
// over the empty sky).
void writeDepth(vec3 p) {
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  float z = clamp(clip.z / max(clip.w, 1e-6), -1.0, 0.99999);
  gl_FragDepth = 0.5 * (gl_DepthRange.diff * z + gl_DepthRange.near + gl_DepthRange.far);
}
`;

/**
 * The deck: only the face where the ray enters the deck (or, from inside it, leaves) draws. It
 * marches through the clouds front to back, lit by one sample toward the sun, and writes depth at
 * the entry so mountains and towers in front still hide them. Premultiplied output.
 */
export const DECK_FRAGMENT = /* glsl */ `
${CLOUD_COMMON}
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uShadowColor;
uniform float uSteps;
varying vec3 vWorld;
varying float vFace;

void main() {
  vec3 ray = normalize(vWorld - uCamPos);
  vec2 t = slab(ray);
  if (t.y <= t.x) discard;
  // This face is the one the pixel sees first: the entry, or the exit from inside the deck.
  float face = length(vWorld - uCamPos);
  float want = t.x > 0.0 ? t.x : t.y;
  if (abs(face - want) > 1.0 + 1e-3 * face) discard;
  vec3 start = uCamPos + ray * t.x;
  // From inside the deck the march starts at the camera, where depth is undefined: test a metre on.
  writeDepth(uCamPos + ray * max(t.x, 1.0));
  // March at most a few deck thicknesses (near-level rays), dithered per pixel.
  float thick = uTop - uBase;
  float len = min(t.y - t.x, 4.0 * thick);
  float steps = uSteps;
  float dt = len / steps;
  float jitter = ign(gl_FragCoord.xy);
  vec3 sun = normalize(uSunDir);
  // Forward scattering: brighter looking toward the sun.
  float phase = 0.75 + 0.6 * pow(max(dot(ray, sun), 0.0), 4.0);
  float trans = 1.0;
  vec3 color = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (float(i) >= steps || trans < 0.03) break;
    vec3 p = start + ray * dt * (float(i) + jitter);
    float d = cloudDensity(p, true);
    if (d <= 0.0) continue;
    // Light reaching p: one sample a third of the deck toward the sun.
    float toSun = cloudDensity(p + sun * (thick * 0.33 / max(sun.y, 0.2)), false);
    float light = exp(-toSun * 2.5 * uDensity);
    float h = (p.y - uBase) / thick;
    vec3 lit = mix(uShadowColor, uSkyColor, h) * 0.7 + uSunColor * light * phase * 0.55;
    float sigma = d * uDensity * 0.02;
    float a = 1.0 - exp(-sigma * dt);
    color += trans * a * lit;
    trans *= 1.0 - a;
  }
  float alpha = 1.0 - trans;
  // Fade out toward the edge of the deck, where the horizon haze takes over.
  // Toward the edge of the deck the horizon haze takes over; without fly-through the deck also
  // fades out as the camera climbs toward it, leaving only the shadows.
  float fade = (1.0 - smoothstep(0.55 * uRadius, uRadius, length(start.xz - uCamPos.xz))) * uDeckFade;
  alpha *= fade;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color * fade, alpha);
  #include <colorspace_fragment>
}
`;

/**
 * Cloud shadows: how much of the deck lies between each ground point and the sun, from a few
 * samples through it. Drawn without depth test over everything below the layer, so 3D buildings
 * darken with the ground around them.
 */
export const SHADOW_FRAGMENT = /* glsl */ `
${CLOUD_COMMON}
uniform float uShadow;
uniform float uGround;
varying vec3 vWorld;

void main() {
  vec3 sun = normalize(uSunDir);
  if (sun.y < 0.05) discard;
  float thick = uTop - uBase;
  float dt = thick / sun.y / 4.0;
  vec3 p = vWorld + sun * ((uBase - uGround) / sun.y);
  float sum = 0.0;
  for (int i = 0; i < 4; i++) sum += cloudDensity(p + sun * dt * (float(i) + 0.5), false);
  float shade = 1.0 - exp(-sum * uDensity * 2.5);
  float fade = 1.0 - smoothstep(0.55 * uRadius, uRadius, length(vWorld.xz - uCamPos.xz));
  float a = uShadow * shade * fade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;
