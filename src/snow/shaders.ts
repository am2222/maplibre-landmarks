/**
 * Snowflakes: soft round camera-facing quads, wrapped into a box around the view like the rain
 * (see RAIN_VERTEX), falling slowly and swaying. Sizes and sway grow with distance from the
 * camera, so flakes keep their size on screen. `uTime` wraps on the CPU.
 */
export const SNOW_VERTEX = /* glsl */ `
attribute vec3 aSeed;
attribute vec2 aCorner;
uniform vec3 uBoxMin;
uniform float uBoxSize;
uniform vec3 uFall;
uniform float uTime;
uniform float uSize;
uniform float uSway;
uniform vec3 uCentre;
uniform float uGround;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vec3 base = uBoxMin + mod( aSeed * uBoxSize - uFall - uBoxMin, uBoxSize );
  float dist = length( cameraPosition - base );
  float phase = fract( aSeed.x * 53.7 + aSeed.y * 17.3 ) * 6.2832;
  vec3 c = base + vec3( sin( uTime * 1.3 + phase ), 0.0, cos( uTime * 1.1 + phase * 1.3 ) )
    * uSway * dist;
  vec3 toCam = normalize( cameraPosition - c );
  vec3 right = cross( vec3( 0.0, 1.0, 0.0 ), toCam );
  right = length( right ) < 1e-3 ? vec3( 1.0, 0.0, 0.0 ) : normalize( right );
  vec3 up = cross( toCam, right );
  // Bigger and smaller flakes.
  float size = uSize * dist * ( 0.5 + fract( aSeed.z * 91.1 + aSeed.x * 7.7 ) );
  vUv = vec2( aCorner.x, aCorner.y * 2.0 - 1.0 );
  vec3 p = c + ( right * vUv.x + up * vUv.y ) * size;
  float edge = 1.0 - smoothstep( 0.3, 0.5, length( ( base - uCentre ) / uBoxSize ) );
  float near = smoothstep( uBoxSize * 0.03, uBoxSize * 0.1, dist );
  vAlpha = edge * near * step( uGround, c.y );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

export const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;

void main() {
  float a = uOpacity * vAlpha * ( 1.0 - smoothstep( 0.35, 1.0, length( vUv ) ) );
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;
