import * as THREE from 'three'

/** A finite daylight source: shadows sharpen at contact and soften with distance.
 * Orthographic shadow depth is linear, so blocker separation is in world units.
 * This replaces only this scene's material chunks, never Three's global chunks.
 */
export class StudioShadows {
  private readonly materials = new WeakSet<THREE.Material>()
  private readonly scale = { value: new THREE.Vector3(1, 1, 1) }

  update(light: THREE.DirectionalLight): void {
    const camera = light.shadow.camera
    this.scale.value.set(camera.far - camera.near, camera.right - camera.left, camera.top - camera.bottom)
  }

  apply(scene: THREE.Object3D): void {
    scene.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (this.materials.has(material)) continue
        this.materials.add(material)
        const compile = material.onBeforeCompile
        const key = material.customProgramCacheKey()
        material.onBeforeCompile = (shader, renderer) => {
          compile.call(material, shader, renderer)
          shader.uniforms.uStudioShadowScale = this.scale
          shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', shadowChunk)
        }
        material.customProgramCacheKey = () => `${key}:studio-contact-shadows-v2`
      }
    })
  }
}

const signature = 'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {'
const baseChunk = THREE.ShaderChunk.shadowmap_pars_fragment
const shadowChunk = baseChunk.slice(0, baseChunk.indexOf(signature)) + `
  uniform vec3 uStudioShadowScale;
  vec2 studioDisk(float i, float count, float rotation) {
    float angle = i * 2.39996323 + rotation;
    return vec2(cos(angle), sin(angle)) * sqrt((i + 0.5) / count);
  }
  // Bilinear depth comparison: a smooth edge between shadow texels instead
  // of a hard step, so penumbrae stay clean without per-pixel noise.
  float studioCompare(sampler2D depths, vec2 size, vec2 uv, float compare) {
    vec2 texel = uv * size - 0.5;
    vec2 f = fract(texel), base = (floor(texel) + 0.5) / size, unit = 1.0 / size;
    float a = texture2DCompare(depths, base, compare);
    float b = texture2DCompare(depths, base + vec2(unit.x, 0.0), compare);
    float c = texture2DCompare(depths, base + vec2(0.0, unit.y), compare);
    float d = texture2DCompare(depths, base + unit, compare);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float studioShadow(sampler2D depths, vec2 size, float bias, vec4 coordinate) {
    vec3 p = coordinate.xyz / coordinate.w;
    p.z += bias;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
    vec2 texel = 1.0 / size;
    // Interleaved gradient noise turns the kernel per pixel; with filtered
    // taps it only dissolves banding and never shows as grain or dots.
    float rotation = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
    vec2 search = vec2(0.32) / uStudioShadowScale.yz;
    float sum = 0.0, count = 0.0;
    for (int i = 0; i < 12; i++) {
      float depth = unpackRGBAToDepth(texture2D(depths, p.xy + studioDisk(float(i), 12.0, rotation) * search));
      if (depth < p.z - 0.00005) { sum += depth; count += 1.0; }
    }
    if (count < 0.5) return studioCompare(depths, size, p.xy, p.z);
    float separation = max(0.0, p.z - sum / count) * uStudioShadowScale.x;
    vec2 radius = max(texel * 1.5, vec2(min(0.45, separation * 0.10)) / uStudioShadowScale.yz);
    float visibility = 0.0;
    for (int i = 0; i < 20; i++) {
      visibility += studioCompare(depths, size, p.xy + studioDisk(float(i), 20.0, rotation) * radius, p.z);
    }
    return visibility / 20.0;
  }
  ${signature}
    return mix(1.0, studioShadow(shadowMap, shadowMapSize, shadowBias, shadowCoord), shadowIntensity);
  }
` + baseChunk.slice(baseChunk.indexOf('vec2 cubeToUV('))

/** The key and its reflected window rotate together when the light preset changes. */
export function orientStudioEnvironment(scene: THREE.Scene, direction: readonly number[]): void {
  const reference = new THREE.Vector3(-0.72, 0.30, 1.35).normalize()
  // Three negates the Euler components before uploading this lookup rotation.
  const lookup = new THREE.Quaternion().setFromUnitVectors(reference, new THREE.Vector3(...direction).normalize()).invert()
  const rotation = new THREE.Euler().setFromQuaternion(lookup)
  rotation.set(-rotation.x, -rotation.y, -rotation.z)
  scene.environmentRotation.copy(rotation)
  scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material instanceof THREE.MeshStandardMaterial) material.envMapRotation.copy(rotation)
    }
  })
}
