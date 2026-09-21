import * as THREE from 'three'
import { TERRACE_ELEVATION_GLSL } from './terraceElevation'

/** Shared deformation keeps ceramic highlights and its shadow on the same terraces. */
export function applyCeramicGlaze(material: THREE.Material, uniforms: Record<string, THREE.IUniform>, glaze = true): void {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
      #include <common>
      uniform float uCeramicHeight;
      attribute float aCeramicSlope;
      varying vec3 vCeramicPoint;
      ${TERRACE_ELEVATION_GLSL}
    `).replace('#include <beginnormal_vertex>', `
      #include <beginnormal_vertex>
      objectNormal.z /= uCeramicHeight;
      objectNormal.y -= aCeramicSlope * objectNormal.z;
    `).replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vCeramicPoint = position;
      transformed.z = position.z * uCeramicHeight + terraceElevation(position.y);
    `)
    if (!glaze) return
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      uniform float uCeramicMineral;
      varying vec3 vCeramicPoint;
    `).replace('#include <color_fragment>', `
      #include <color_fragment>
      vec3 ceramicP = vCeramicPoint;
      float ceramicWave = abs(sin(ceramicP.x * 2.1 + ceramicP.y * 0.61
        + sin(ceramicP.y * 1.6 + ceramicP.z * 2.4) * 0.6
        + sin(ceramicP.x * 4.1 - ceramicP.y) * 0.18));
      float ceramicVein = 1.0 - smoothstep(0.012, 0.046 + fwidth(ceramicWave), ceramicWave);
      diffuseColor.rgb *= 1.0 - vec3(0.10, 0.13, 0.16) * ceramicVein * uCeramicMineral;
      float ceramicFoot = 1.0 - smoothstep(0.02, 0.17, ceramicP.z);
      diffuseColor.rgb *= 1.0 - ceramicFoot * 0.055;
    `).replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      float ceramicGrain = sin(vCeramicPoint.x * 83.0 + sin(vCeramicPoint.y * 51.0)) * sin(vCeramicPoint.y * 71.0 + vCeramicPoint.z * 67.0);
      roughnessFactor = clamp(roughnessFactor + ceramicGrain * 0.008, 0.06, 1.0);
    `)
  }
  material.customProgramCacheKey = () => glaze ? 'continuous-terraced-ceramic-v1' : 'continuous-terraced-ceramic-depth-v1'
}
