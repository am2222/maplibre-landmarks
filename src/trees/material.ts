import { Color, MeshStandardMaterial, Vector2, Vector3 } from 'three';
import { THEMES, type Theme } from '../core/theme';
import { SEASON_COLORS } from './season';

export interface TreeUniforms {
  uTime: { value: number };
  uWindDir: { value: Vector2 };
  uWindStrength: { value: number };
  uFoliage: { value: Color };
  uFoliageJitter: { value: number };
  uTrunk: { value: Color };
  /** 0..1: trees grow out of the ground as the map zooms in past the layer's minZoom. */
  uGrow: { value: number };
  /** Seconds a newly shown tree takes to rise from the ground (0: appears at full size). */
  uRise: { value: number };
  /**
   * Far cutoff (pitched views): trees shrink into the ground over the last `uCutoffFade` metres
   * before `uCutoff` from the view centre `uCenter` (batch-local x, z).
   */
  uCutoff: { value: number };
  uCutoffFade: { value: number };
  uCenter: { value: Vector2 };
  /** 0 spring, 1 summer, 2 autumn, 3 winter (wrapping at 4). */
  uSeason: { value: number };
  /** 1: snow settles on upward faces in winter, 0: bare winter. */
  uSnow: { value: number };
  /** Theme foliage ÷ day foliage: scales the seasonal colours, which are set for the day theme. */
  uThemeRatio: { value: Vector3 };
  uSpring: { value: Vector3[] };
  uBlossom: { value: Vector3[] };
  uAutumn: { value: Vector3[] };
  uBare: { value: Vector3 };
  uSnowColor: { value: Vector3 };
}

/** Downwind unit vector in local XZ for a wind blowing FROM `directionDeg` (clockwise from north). */
export function windVector(directionDeg: number): [number, number] {
  const to = ((directionDeg + 180) * Math.PI) / 180;
  return [Math.sin(to), -Math.cos(to)];
}

/**
 * Weights of the four season keyframes at `s`. Each season holds for half its band around its
 * own value and blends into the next over the other half. Trees are offset by up to ±0.2 by
 * their tint, so at a whole season every tree shows that season exactly.
 */
const SEASON_WEIGHTS = /* glsl */ `
vec4 seasonWeights( float s ) {
  s = mod( s, 4.0 );
  float i = floor( s );
  float f = smoothstep( 0.25, 0.75, s - i );
  vec4 k = vec4( 0.0, 1.0, 2.0, 3.0 );
  return ( 1.0 - f ) * ( 1.0 - step( 0.5, abs( k - i ) ) )
    + f * ( 1.0 - step( 0.5, abs( k - mod( i + 1.0, 4.0 ) ) ) );
}
float treeSeason( float tint ) { return uSeason - ( tint - 0.5 ) * 0.4; }
`;

const VERTEX_DECL = /* glsl */ `
attribute float aPart;
attribute float aShade;
attribute float aHeight;
attribute float aTint;
attribute float aPhase;
attribute float aBorn;
attribute vec4 aClump;
attribute float aLeaf;
varying float vPart;
varying float vShade;
varying float vTint;
varying float vLeaf;
varying float vSnow;
uniform float uSeason;
uniform float uSnow;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uGrow;
uniform float uRise;
uniform float uCutoff;
uniform float uCutoffFade;
uniform vec2 uCenter;
${SEASON_WEIGHTS}
`;

/**
 * Deciduous leaf clumps (aLeaf >= 0) shrink into their centre (aClump.xyz) as the crown thins,
 * each at its own threshold (aClump.w), so crowns go bare unevenly. Snow settles on faces whose
 * normal points up (instances only turn about Y, so the model normal's y is the world one).
 */
const SEASON_VERTEX = /* glsl */ `
#include <begin_vertex>
vPart = aPart;
vShade = aShade;
vTint = aTint;
vLeaf = aLeaf;
vec4 sw = seasonWeights( treeSeason( aTint ) );
float crown = aLeaf < 0.0 ? 1.0 : dot( sw, vec4( 0.8, 1.0, 0.92, 0.0 ) );
float dropAt = 0.35 * aClump.w;
float clump = clamp( ( crown - dropAt ) / ( 1.0 - dropAt ), 0.0, 1.0 );
if ( aPart > 0.5 ) transformed = mix( aClump.xyz, transformed, clump );
vSnow = sw.w * uSnow * smoothstep( 0.2, 0.6, objectNormal.y ) * ( aPart > 0.5 ? 1.0 : 0.85 );
`;

const PROJECT_WITH_WIND = /* glsl */ `
// Scaled about the tree's base (local origin) before placement: trees rise from the ground,
// with the zoom (uGrow) and, eased out, over uRise seconds after they first show.
float risen = uRise > 0.0 ? clamp( ( uTime - aBorn ) / uRise, 0.0, 1.0 ) : 1.0;
risen = 1.0 - pow( 1.0 - risen, 3.0 );
#ifdef USE_INSTANCING
  vec3 treeOrigin = instanceMatrix[3].xyz;
#else
  vec3 treeOrigin = vec3( 0.0 );
#endif
// Near the far cutoff trees sink, each at its own distance (no hard line), like Mapbox's cutoff.
float far = length( treeOrigin.xz - uCenter ) + ( aTint - 0.5 ) * uCutoffFade * 0.5;
float kept = 1.0 - smoothstep( uCutoff - uCutoffFade, uCutoff, far );
vec4 mvPosition = vec4( transformed * ( uGrow * risen * kept ), 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
float treeY = max( mvPosition.y - treeOrigin.y, 0.0 );
float phase = aPhase; // absolute-position phase from the CPU: stable across pans
float sway = ( sin( uTime * 1.1 + phase ) * 0.6 + sin( uTime * 2.3 + phase * 1.7 ) * 0.4 ) * uWindStrength;
mvPosition.xz += uWindDir * ( sway * 0.05 * aHeight * treeY + 0.15 * uWindStrength * aHeight );
mvPosition.xz += aPart * 0.05 * uWindStrength * vec2(
  sin( uTime * 6.0 + phase * 3.0 + position.y ),
  cos( uTime * 5.0 + phase * 2.0 + position.y ) );
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_DECL = /* glsl */ `
varying float vPart;
varying float vShade;
varying float vTint;
varying float vLeaf;
varying float vSnow;
uniform vec3 uFoliage;
uniform vec3 uTrunk;
uniform float uFoliageJitter;
uniform float uSeason;
uniform vec3 uThemeRatio;
uniform vec3 uSpring[2];
uniform vec3 uBlossom[2];
uniform vec3 uAutumn[5];
uniform vec3 uBare;
uniform vec3 uSnowColor;
${SEASON_WEIGHTS}
vec3 autumnColor( float h ) {
  float x = h * 4.0;
  vec3 c = mix( uAutumn[0], uAutumn[1], clamp( x, 0.0, 1.0 ) );
  c = mix( c, uAutumn[2], clamp( x - 1.0, 0.0, 1.0 ) );
  c = mix( c, uAutumn[3], clamp( x - 2.0, 0.0, 1.0 ) );
  return mix( c, uAutumn[4], clamp( x - 3.0, 0.0, 1.0 ) );
}
`;

/**
 * Summer is the theme's foliage colour. Evergreens (vLeaf < 0) only lighten in spring and darken
 * in winter; deciduous trees get fresh green or blossom (a vLeaf share of them), an autumn colour
 * picked by tint, then withered brown as the last leaves fall.
 */
const PALETTE_COLOR = /* glsl */ `
#include <color_fragment>
vec4 sw = seasonWeights( treeSeason( vTint ) );
vec3 leaves;
if ( vLeaf < 0.0 ) {
  leaves = uFoliage * dot( sw, vec4( 1.1, 1.0, 0.92, 0.85 ) );
} else {
  float bloom = fract( vTint * 13.7 ) < vLeaf ? 1.0 : 0.0;
  vec3 spring = mix(
    mix( uSpring[0], uSpring[1], vTint ),
    mix( uBlossom[0], uBlossom[1], step( 0.5, fract( vTint * 29.3 ) ) ),
    bloom );
  leaves = sw.y * uFoliage
    + ( sw.x * spring + sw.z * autumnColor( fract( vTint * 7.31 ) ) + sw.w * uBare ) * uThemeRatio;
}
vec3 foliageCol = leaves * ( 1.0 + ( vTint - 0.5 ) * uFoliageJitter );
foliageCol.r += ( vTint - 0.5 ) * uFoliageJitter * 0.08;
diffuseColor.rgb = mix( mix( uTrunk, foliageCol, vPart ) * vShade, uSnowColor, vSnow );
`;

const linear = (hex: number) => {
  const c = new Color(hex);
  return new Vector3(c.r, c.g, c.b);
};

export function createTreeMaterial() {
  const uniforms: TreeUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new Vector2(1, 0) },
    uWindStrength: { value: 1 },
    uFoliage: { value: new Color() },
    uFoliageJitter: { value: 0.3 },
    uTrunk: { value: new Color() },
    uGrow: { value: 1 },
    uRise: { value: 0 },
    uCutoff: { value: 1e9 },
    uCutoffFade: { value: 1 },
    uCenter: { value: new Vector2() },
    uSeason: { value: 1 },
    uSnow: { value: 1 },
    uThemeRatio: { value: new Vector3(1, 1, 1) },
    uSpring: { value: SEASON_COLORS.spring.map(linear) },
    uBlossom: { value: SEASON_COLORS.blossom.map(linear) },
    uAutumn: { value: SEASON_COLORS.autumn.map(linear) },
    uBare: { value: linear(SEASON_COLORS.bare) },
    uSnowColor: { value: linear(SEASON_COLORS.snow) },
  };
  const material = new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0 });
  material.userData.treeUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', SEASON_VERTEX)
      .replace('#include <project_vertex>', PROJECT_WITH_WIND);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', PALETTE_COLOR);
  };
  material.customProgramCacheKey = () => 'trees-v4';

  const setTheme = (theme: Theme) => {
    const p = THEMES[theme].palette;
    uniforms.uFoliage.value.setHex(p.foliage);
    uniforms.uTrunk.value.setHex(p.trunk);
    uniforms.uFoliageJitter.value = p.foliageJitter;
    const f = uniforms.uFoliage.value;
    const day = new Color(THEMES.day.palette.foliage);
    uniforms.uThemeRatio.value.set(f.r / day.r, f.g / day.g, f.b / day.b);
  };
  const setWind = (strength: number, directionDeg: number) => {
    uniforms.uWindStrength.value = Math.max(0, strength);
    uniforms.uWindDir.value.set(...windVector(directionDeg));
  };
  setTheme('day');
  return { material, uniforms, setTheme, setWind };
}
