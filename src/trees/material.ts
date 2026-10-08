import { Color, MeshStandardMaterial, Vector2 } from 'three';
import { THEMES, type Theme } from '../core/theme';

export interface TreeUniforms {
  uTime: { value: number };
  uWindDir: { value: Vector2 };
  uWindStrength: { value: number };
  uFoliage: { value: Color };
  uFoliageJitter: { value: number };
  uTrunk: { value: Color };
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
varying float vPart;
varying float vShade;
varying float vTint;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
`;

const PROJECT_WITH_WIND = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 treeOrigin = instanceMatrix[3].xyz;
#else
  vec3 treeOrigin = vec3( 0.0 );
#endif
float treeY = max( mvPosition.y - treeOrigin.y, 0.0 );
float phase = dot( treeOrigin.xz, vec2( 0.13, 0.07 ) );
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
  material.customProgramCacheKey = () => 'trees-v1';

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
