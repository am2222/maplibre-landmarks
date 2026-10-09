import { Color, MeshStandardMaterial, Vector2 } from 'three';
import { THEMES, type Theme } from '../core/theme';

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
}

/** Downwind unit vector in local XZ for a wind blowing FROM `directionDeg` (clockwise from north). */
export function windVector(directionDeg: number): [number, number] {
  const to = ((directionDeg + 180) * Math.PI) / 180;
  return [Math.sin(to), -Math.cos(to)];
}

const VERTEX_DECL = /* glsl */ `
attribute float aPart;
attribute float aShade;
attribute float aHeight;
attribute float aTint;
attribute float aPhase;
attribute float aBorn;
varying float vPart;
varying float vShade;
varying float vTint;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uGrow;
uniform float uRise;
`;

const PROJECT_WITH_WIND = /* glsl */ `
// Scaled about the tree's base (local origin) before placement: trees rise from the ground,
// with the zoom (uGrow) and, eased out, over uRise seconds after they first show.
float risen = uRise > 0.0 ? clamp( ( uTime - aBorn ) / uRise, 0.0, 1.0 ) : 1.0;
risen = 1.0 - pow( 1.0 - risen, 3.0 );
vec4 mvPosition = vec4( transformed * ( uGrow * risen ), 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 treeOrigin = instanceMatrix[3].xyz;
#else
  vec3 treeOrigin = vec3( 0.0 );
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
uniform vec3 uFoliage;
uniform vec3 uTrunk;
uniform float uFoliageJitter;
`;

const PALETTE_COLOR = /* glsl */ `
#include <color_fragment>
vec3 foliageCol = uFoliage * ( 1.0 + ( vTint - 0.5 ) * uFoliageJitter );
foliageCol.r += ( vTint - 0.5 ) * uFoliageJitter * 0.08;
diffuseColor.rgb = mix(uTrunk, foliageCol, vPart) * vShade;
`;

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
  };
  const material = new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0 });
  material.userData.treeUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvPart = aPart;\nvShade = aShade;\nvTint = aTint;',
      )
      .replace('#include <project_vertex>', PROJECT_WITH_WIND);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', PALETTE_COLOR);
  };
  material.customProgramCacheKey = () => 'trees-v2';

  const setTheme = (theme: Theme) => {
    const p = THEMES[theme].palette;
    uniforms.uFoliage.value.setHex(p.foliage);
    uniforms.uTrunk.value.setHex(p.trunk);
    uniforms.uFoliageJitter.value = p.foliageJitter;
  };
  const setWind = (strength: number, directionDeg: number) => {
    uniforms.uWindStrength.value = Math.max(0, strength);
    uniforms.uWindDir.value.set(...windVector(directionDeg));
  };
  setTheme('day');
  return { material, uniforms, setTheme, setWind };
}
