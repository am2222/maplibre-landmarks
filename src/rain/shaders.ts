/**
 * Rain streaks: one camera-facing quad per drop. Drops are anchored to the ground (no drift as
 * the map pans) and wrapped into a box around the view, sized from the camera's distance so the
 * rain reads the same at every zoom. `uFall` is the fall and wind offset so far, wrapped on the
 * CPU, so the GPU never sees large times.
 */
export const RAIN_VERTEX = /* glsl */ `
attribute vec3 aSeed;
attribute vec2 aCorner;
uniform vec3 uBoxMin;
uniform float uBoxSize;
uniform vec3 uFall;
uniform vec3 uDir;
uniform float uLength;
uniform float uWidth;
uniform vec3 uCentre;
uniform float uGround;
varying float vAlpha;
varying float vAlong;

void main() {
  vec3 top = uBoxMin + mod( aSeed * uBoxSize - uFall - uBoxMin, uBoxSize );
  // Sized by distance from the camera, so streaks keep the same thickness and length on screen
  // near and far; some longer, some shorter, so the rain doesn't look like a grid.
  float dist = length( cameraPosition - top );
  float len = uLength * dist * ( 0.6 + 0.8 * fract( aSeed.x * 37.1 + aSeed.z * 11.3 ) );
  vec3 p = top + uDir * len * aCorner.y;
  vec3 toCam = normalize( cameraPosition - p );
  vec3 side = normalize( cross( uDir, toCam ) );
  p += side * uWidth * dist * aCorner.x;
  vAlong = aCorner.y;
  // Thin out toward the box edges and right in front of the lens; nothing below the ground.
  float edge = 1.0 - smoothstep( 0.3, 0.5, length( ( top - uCentre ) / uBoxSize ) );
  float near = smoothstep( uBoxSize * 0.03, uBoxSize * 0.1, length( top - cameraPosition ) );
  vAlpha = edge * near * step( uGround, p.y );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

export const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vAlong;

void main() {
  // Brightest at the leading (lower) end of each streak.
  float a = uOpacity * vAlpha * ( 0.25 + 0.75 * vAlong );
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

/**
 * Full-screen overcast and lightning: blended as src + dst × src.a, so `uDarken` dims everything
 * drawn under the rain (map and 3D) and the flash adds light on top.
 */
export const OVERLAY_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export const OVERLAY_FRAGMENT = /* glsl */ `
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uDarken;

void main() {
  gl_FragColor = vec4( uFlashColor * uFlash, 1.0 - uDarken );
}
`;

/** The bolt: thin ribbons, glowing white at their core. */
export const BOLT_VERTEX = /* glsl */ `
attribute float aSide;
varying float vSide;

void main() {
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

export const BOLT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFlash;
varying float vSide;

void main() {
  float core = 1.0 - abs( vSide );
  gl_FragColor = vec4( mix( uColor, vec3( 1.0 ), core * core ), uFlash * ( 0.35 + 0.65 * core ) );
}
`;
