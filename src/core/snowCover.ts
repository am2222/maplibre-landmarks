import type { Material } from 'three';

export interface SnowCoverUniform {
  uSnowCover: { value: number };
}

/** Fresh snow, slightly blue. */
export const SNOW_COLOR = [0.93, 0.95, 0.98] as const;

/**
 * Let snow settle on `material`: upward-facing faces turn white as `uSnowCover` rises (0–1).
 * The model's Y axis must point up (glTF axes, as every module's meshes do).
 */
export function withSnowCover(material: Material, uniform: SnowCoverUniform): void {
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnowCover = uniform.uSnowCover;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSnowUp;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvSnowUp = objectNormal.y;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vSnowUp;\nuniform float uSnowCover;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( ${SNOW_COLOR.join(', ')} ),
  uSnowCover * smoothstep( 0.25, 0.65, vSnowUp ) );`,
      );
  };
  material.customProgramCacheKey = () => `${key()}|snow-cover`;
}
