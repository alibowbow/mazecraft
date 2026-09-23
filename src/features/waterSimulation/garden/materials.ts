import * as THREE from 'three'
import type { GardenField } from './flowField'
import { createLeafShadowTexture, createRippleNormals } from './environment'

export const MAX_POOLS = 16
export const MAX_IMPACTS = 24

function entryTexture(field: GardenField): THREE.DataTexture {
  const data = new Uint16Array(field.entry.length)
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(Math.min(60000, field.entry[i]))
  const texture = new THREE.DataTexture(data, field.width, field.height, THREE.RedFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  texture.name = 'garden-wetting-order'
  return texture
}

/** Uniform objects shared (by reference) by every garden material. */
export function createGardenUniforms(field: GardenField) {
  const texture = new THREE.DataTexture(field.data, field.width, field.height, THREE.RGBAFormat)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  texture.name = 'garden-plan-field'
  return {
    uGardenField: { value: texture },
    uGardenBounds: { value: new THREE.Vector4(...field.bounds) },
    uLevels: { value: new Float32Array(MAX_POOLS).fill(-10) },
    uFloors: { value: new Float32Array(MAX_POOLS) },
    uPoolFlow: { value: new Float32Array(MAX_POOLS) },
    /** Garden-wide current: one speed for every pool, so ripples never jump at a step. */
    uFlowMean: { value: 0 },
    uGardenTime: { value: 0 },
    uGardenStyle: { value: 1 },
    uImpacts: { value: Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4()) },
    uImpactZ: { value: new Float32Array(MAX_IMPACTS) },
    uImpactCount: { value: 0 },
    uFront: { value: new Float32Array(MAX_POOLS).fill(-1) },
    /** Drain vortex: x, y, water level, strength (0–1). */
    uDrain: { value: new THREE.Vector4(0, 0, -10, 0) },
    uGardenEntry: { value: entryTexture(field) },
    uWallScale: { value: 1 },
    uRipplesA: { value: createRippleNormals(17, 256, 14, 4.6) },
    uRipplesB: { value: createRippleNormals(63, 256, 18, 3.4) },
    uLeafShade: { value: createLeafShadowTexture() },
    uCaustics: { value: 1 },
    uSunDirection: { value: new THREE.Vector3(-0.5, 0.35, 0.8).normalize() },
  }
}

export type GardenUniforms = ReturnType<typeof createGardenUniforms>

export const GARDEN_COMMON_GLSL = /* glsl */ `
  #define GARDEN_MAX_POOLS ${MAX_POOLS}
  uniform sampler2D uGardenField;
  uniform vec4 uGardenBounds;
  uniform float uLevels[GARDEN_MAX_POOLS];
  uniform float uFloors[GARDEN_MAX_POOLS];
  uniform float uPoolFlow[GARDEN_MAX_POOLS];
  uniform float uGardenTime;
  uniform float uGardenStyle;
  uniform float uCaustics;
  vec2 gardenUv(vec2 p) { return (p - uGardenBounds.xy) / uGardenBounds.zw; }
  vec4 gardenField(vec2 p) { return texture2D(uGardenField, gardenUv(p)); }
  int gardenPool(vec2 p) {
    ivec2 size = textureSize(uGardenField, 0);
    ivec2 c = clamp(ivec2(gardenUv(p) * vec2(size)), ivec2(0), size - ivec2(1));
    return int(texelFetch(uGardenField, c, 0).a * 255.0 + 0.5) - 1;
  }
  float gardenHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float gardenNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gardenHash(i), gardenHash(i + vec2(1.0, 0.0)), u.x),
      mix(gardenHash(i + vec2(0.0, 1.0)), gardenHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Craquelure: the fine crackle of a fired glaze. F2 − F1 of a jittered
  // cell grid gives the distance to the nearest crack.
  vec2 gardenCell(vec2 i) {
    return vec2(gardenHash(i), gardenHash(i + vec2(17.3, 9.1))) * 0.8 + 0.1;
  }
  float gardenCrack(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float d = length(g + gardenCell(i + g) - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    return d2 - d1;
  }
  // Cracks on the face's dominant plane, faded out once finer than a pixel.
  float gardenCraquelure(vec3 p, vec3 n) {
    vec3 a = abs(n);
    vec2 uv = a.z > max(a.x, a.y) ? p.xy : (a.x > a.y ? p.yz : p.xz);
    vec2 coarse = uv * 7.5, fine = uv * 19.0 + 3.7;
    float fadeCoarse = 1.0 - smoothstep(0.25, 0.8, length(fwidth(coarse)));
    float fadeFine = 1.0 - smoothstep(0.25, 0.8, length(fwidth(fine)));
    float c = (1.0 - smoothstep(0.012, 0.06, gardenCrack(coarse))) * fadeCoarse;
    float f = (1.0 - smoothstep(0.0, 0.04, gardenCrack(fine))) * fadeFine * 0.55;
    return max(c, f);
  }
  // Refracted-sunlight network: the classic tileable iterated-domain caustic
  // (period 2π in p). Band-limited by the pixel footprint so distant beds
  // settle to their mean brightness instead of shimmering.
  float gardenCaustic(vec2 world, float t) {
    vec2 p = mod(world * 4.2, 6.28318) - 250.0;
    vec2 i = p;
    float c = 1.0;
    for (int n = 0; n < 5; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
    }
    c /= 5.0;
    c = 1.17 - pow(c, 1.4);
    return clamp(pow(abs(c), 8.0), 0.0, 2.5);
  }
  float gardenCausticAt(vec2 world, float depth) {
    float footprint = length(fwidth(world * 4.2));
    float fade = 1.0 - smoothstep(0.25, 0.9, footprint);
    float c = gardenCaustic(world + vec2(0.0, depth * 0.6), uGardenTime * 0.45 + 23.0);
    return mix(0.22, c, fade) * smoothstep(0.01, 0.09, depth) * exp(-depth * 0.8);
  }
`

function inject(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, uniforms: GardenUniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vGardenWorld;`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvGardenWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vGardenWorld;\n${GARDEN_COMMON_GLSL}`)
}

/** Ensures the world position is computed even without shadows or env maps. */
const FORCE_WORLDPOS = '#define GARDEN_WORLDPOS\n'

export interface CeramicLook {
  glaze: THREE.ColorRepresentation
  bed: THREE.ColorRepresentation
  roughness: number
  clearcoat: number
}

/**
 * Glazed stoneware. Colour and gloss come from the look; cavity shading comes
 * from the plan field, so corners, wall feet and submerged faces read as a
 * single cast object sitting in real light instead of a flat plastic panel.
 */
export function createCeramicMaterial(uniforms: GardenUniforms, kind: 'wall' | 'bed' | 'trim'): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xf2ece2, roughness: kind === 'bed' ? 0.36 : 0.3, metalness: 0,
    clearcoat: kind === 'bed' ? 0.55 : 1, clearcoatRoughness: kind === 'bed' ? 0.12 : 0.045,
    ior: 1.5, envMapIntensity: 1, sheen: kind === 'wall' ? 0.25 : 0, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xfff1dc),
  })
  material.onBeforeCompile = shader => {
    inject(shader, uniforms)
    shader.vertexShader = FORCE_WORLDPOS + shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGardenNormal;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvGardenNormal = normalize(mat3(modelMatrix) * objectNormal);')
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGardenNormal;')
    if (kind === 'wall') {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFloor;\nuniform float uWallScale;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          if (position.z > aFloor + 0.001) objectNormal.z /= uWallScale;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          if (position.z > aFloor) transformed.z = aFloor + (position.z - aFloor) * uWallScale;`)
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Fired glaze over a stoneware body. The glaze pools deeper (richer
        // tone) in hollows and thins over rounded crowns, where the warm body
        // shows through; soft mottling, iron specks and a fine craquelure
        // make it read as ceramic rather than moulded plastic.
        vec3 glazeNormal = normalize(vGardenNormal);
        float glazeCloud = gardenNoise(vGardenWorld.xy * 1.7 + vGardenWorld.z * 0.9) * 0.6 + gardenNoise(vGardenWorld.xy * 5.3 + vGardenWorld.z * 2.1) * 0.4;
        diffuseColor.rgb *= 0.93 + glazeCloud * 0.1;
        // Glaze thickness shifts the tone a little, as a real firing does.
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.97, 1.0, 1.02), smoothstep(0.45, 0.8, gardenNoise(vGardenWorld.xy * 0.8 - vGardenWorld.z * 0.6)));
        float crown = smoothstep(0.12, 0.45, glazeNormal.z) * (1.0 - smoothstep(0.72, 0.96, glazeNormal.z));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.03, 0.985, 0.94), crown * 0.55);
        float speck = step(0.988, gardenHash(floor(vGardenWorld.xy * 150.0) + floor(vGardenWorld.z * 150.0)));
        diffuseColor.rgb *= 1.0 - speck * 0.12;
        float crackle = gardenCraquelure(vGardenWorld, glazeNormal);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.71, 0.68), crackle * 0.48);`)
      .replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>
        // Orange peel: the gentle waviness of a real glaze surface bends the
        // mirrored sky, where a moulded surface would reflect it flat.
        vec2 peel = vec2(gardenNoise(vGardenWorld.xy * 11.0 + vGardenWorld.z * 7.0), gardenNoise(vGardenWorld.yx * 11.0 - vGardenWorld.z * 5.0)) - 0.5;
        vec2 swell = vec2(gardenNoise(vGardenWorld.xy * 2.3 + vGardenWorld.z), gardenNoise(vGardenWorld.yx * 2.3 - vGardenWorld.z)) - 0.5;
        clearcoatNormal = normalize(clearcoatNormal + mat3(viewMatrix) * vec3(peel * 0.05 + swell * 0.07, 0.0));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.85 + gardenNoise(vGardenWorld.xy * 3.1) * 0.3), 0.04, 1.0);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        vec3 gardenNormal = inverseTransformDirection(normal, viewMatrix);
        ${kind === 'bed' ? `
          vec4 gardenBed = gardenField(vGardenWorld.xy);
          int gardenPoolIndex = gardenPool(vGardenWorld.xy);
          float gardenDistance = gardenBed.b < 0.499 ? gardenBed.b : 0.5;
          float gardenAo = mix(0.52, 1.0, smoothstep(0.0, 0.22, gardenDistance));
          float gardenDepth = gardenPoolIndex >= 0 ? uLevels[gardenPoolIndex] - vGardenWorld.z : 0.0;
          float gardenLight = 0.82 + gardenCausticAt(vGardenWorld.xy, gardenDepth) * 4.2 * uCaustics;
        ` : `
          vec2 gardenProbe = vGardenWorld.xy + gardenNormal.xy * 0.07;
          vec4 gardenBed = gardenField(gardenProbe);
          bool gardenWet = gardenBed.b > 0.002 && gardenBed.b < 0.499 && gardenNormal.z < 0.6;
          int gardenPoolIndex = gardenPool(gardenProbe);
          float gardenAo = mix(0.5, 1.0, smoothstep(0.0, 0.42, vGardenWorld.z));
          float gardenLight = 1.0;
          if (gardenWet && gardenPoolIndex >= 0) {
            float h = vGardenWorld.z - uFloors[gardenPoolIndex];
            gardenAo *= mix(0.58, 1.0, smoothstep(-0.02, 0.32, h));
            float depth = uLevels[gardenPoolIndex] - vGardenWorld.z;
            if (depth > 0.0) gardenLight += gardenCausticAt(vGardenWorld.xy + vec2(vGardenWorld.z * 0.8), depth) * 1.6 * uCaustics;
          }
        `}
        reflectedLight.directDiffuse *= mix(1.0, gardenAo, 0.35) * gardenLight;
        reflectedLight.indirectDiffuse *= gardenAo;
        reflectedLight.indirectSpecular *= mix(1.0, gardenAo, 0.75);
      `)
  }
  material.customProgramCacheKey = () => `garden-ceramic-${kind}-v2`
  return material
}

export function createWallDepthMaterial(uniforms: GardenUniforms): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  material.onBeforeCompile = shader => {
    shader.uniforms.uWallScale = uniforms.uWallScale
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFloor;\nuniform float uWallScale;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (position.z > aFloor) transformed.z = aFloor + (position.z - aFloor) * uWallScale;`)
  }
  material.customProgramCacheKey = () => 'garden-wall-depth-v1'
  return material
}

/**
 * Clear water with physically based transmission: refraction of the bed,
 * depth-dependent absorption, Fresnel sky reflections and sun glints. The
 * surface follows each pool's simulated level; ripples are advected along the
 * route the water actually takes through the maze.
 */
export function createWaterMaterial(uniforms: GardenUniforms): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.035, transmission: 1, thickness: 1, ior: 1.333,
    attenuationColor: new THREE.Color(0x57d3dc), attenuationDistance: 0.75, specularIntensity: 1, envMapIntensity: 1,
  })
  material.onBeforeCompile = shader => {
    inject(shader, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPool;
        #define GARDEN_MAX_POOLS ${MAX_POOLS}
        uniform sampler2D uGardenField;
        uniform vec4 uGardenBounds;
        uniform float uLevels[GARDEN_MAX_POOLS];
        uniform float uFloors[GARDEN_MAX_POOLS];
        uniform float uPoolFlow[GARDEN_MAX_POOLS];
        uniform float uFlowMean;
        uniform float uFront[GARDEN_MAX_POOLS];
        uniform float uGardenTime;
        uniform float uGardenStyle;
        uniform vec4 uImpacts[${MAX_IMPACTS}];
        uniform float uImpactZ[${MAX_IMPACTS}];
        uniform int uImpactCount;
        uniform vec4 uDrain;
        varying float vPoolDepth;
        varying float vPoolFlow;
        varying float vPoolFront;
        // Real surface undulation: deep-water wave trains (ω² = g·k), one
        // aligned with the local current, plus rings spreading from falls.
        float waterWave(vec2 p, vec2 dir, float k, float amplitude, float phase, inout vec2 grad) {
          float omega = sqrt(9.81 * k);
          float arg = dot(dir, p) * k - omega * uGardenTime + phase;
          grad += dir * (amplitude * k * cos(arg));
          return amplitude * sin(arg);
        }`)
      .replace('#include <beginnormal_vertex>', `
        int gardenPoolIndex = int(aPool + 0.5);
        float poolLevel = uLevels[gardenPoolIndex];
        vec4 waveField = texture2D(uGardenField, (position.xy - uGardenBounds.xy) / uGardenBounds.zw);
        vec2 waveFlow = (waveField.rg * 2.0 - 1.0) * uFlowMean;
        float waveSpeed = length(waveFlow);
        float wallDistance = waveField.b < 0.499 ? waveField.b : 0.5;
        float settled = step(9000.0, uFront[gardenPoolIndex]);
        float amplitude = (0.004 + 0.016 * smoothstep(0.02, 0.5, waveSpeed)) * (0.4 + 0.6 * uGardenStyle)
          * smoothstep(0.02, 0.16, wallDistance) * mix(0.25, 1.0, settled);
        vec2 along = waveSpeed > 1e-4 ? waveFlow / waveSpeed : vec2(0.6, 0.8);
        vec2 waveGrad = vec2(0.0);
        float waveHeight = waterWave(position.xy, along, 11.0, amplitude, 0.0, waveGrad)
          + waterWave(position.xy, normalize(vec2(0.83, -0.56)), 17.0, amplitude * 0.55, 1.7, waveGrad)
          + waterWave(position.xy, normalize(vec2(-0.37, 0.93)), 26.0, amplitude * 0.35, 4.1, waveGrad)
          + waterWave(position.xy, normalize(vec2(-0.9, -0.44)), 7.0, amplitude * 0.5, 2.9, waveGrad);
        for (int i = 0; i < ${MAX_IMPACTS}; i++) {
          if (i >= uImpactCount) break;
          vec4 impact = uImpacts[i];
          if (abs(uImpactZ[i] - poolLevel) > 0.03) continue;
          vec2 d = position.xy - impact.xy;
          float r = length(d) + 1e-4;
          float envelope = exp(-r * 2.2) * impact.w * 0.022;
          float arg = r * 16.0 - uGardenTime * 9.0;
          waveHeight += sin(arg) * envelope;
          waveGrad += d / r * (cos(arg) * 16.0 * envelope - sin(arg) * 2.2 * envelope);
        }
        // A drain draws the surface down into a shallow vortex dimple.
        if (abs(uDrain.z - poolLevel) < 0.03 && uDrain.w > 0.0) {
          vec2 d = position.xy - uDrain.xy;
          float r2 = dot(d, d);
          float dimple = uDrain.w * 0.05 * exp(-r2 / 0.03);
          waveHeight -= dimple;
          waveGrad -= d * (-2.0 / 0.03) * dimple;
        }
        vec3 objectNormal = normalize(vec3(-waveGrad, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position.xy, poolLevel + waveHeight);
        vPoolDepth = poolLevel - uFloors[gardenPoolIndex];
        vPoolFlow = uFlowMean;
        vPoolFront = uFront[gardenPoolIndex];`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uRipplesA;
        uniform sampler2D uRipplesB;
        uniform vec4 uImpacts[${MAX_IMPACTS}];
        uniform float uImpactZ[${MAX_IMPACTS}];
        uniform int uImpactCount;
        uniform sampler2D uGardenEntry;
        uniform vec4 uDrain;
        varying float vPoolDepth;
        varying float vPoolFlow;
        varying float vPoolFront;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Wetting front: a dry bed is uncovered in the order water reaches it.
        float entryDistance = texture2D(uGardenEntry, gardenUv(vGardenWorld.xy)).r;
        if (vPoolFront < 0.0 || entryDistance > vPoolFront + 0.02) discard;
        float leadingEdge = vPoolFront > 9000.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.3, vPoolFront - entryDistance);
        vec4 waterField = gardenField(vGardenWorld.xy);
        vec2 waterFlow = (waterField.rg * 2.0 - 1.0) * vPoolFlow;
        float waterSpeed = length(waterFlow);
        // Two-phase flow map: texture coordinates advect along the route and
        // reset alternately, so the pattern travels without stretching.
        float flowCycle = 1.4;
        float phaseA = fract(uGardenTime / flowCycle), phaseB = fract(uGardenTime / flowCycle + 0.5);
        float blendB = abs(phaseA - 0.5) * 2.0;
        vec2 rippleUv = vGardenWorld.xy * 0.62;
        vec2 uvA = rippleUv - waterFlow * phaseA * flowCycle * 0.62;
        vec2 uvB = rippleUv - waterFlow * phaseB * flowCycle * 0.62 + vec2(0.37, 0.19);
        vec4 flowA = texture2D(uRipplesA, uvA), flowB = texture2D(uRipplesA, uvB);
        vec4 flowSample = mix(flowA, flowB, blendB);
        float wallDistance = waterField.b < 0.499 ? waterField.b : 0.5;
        float waterFoam = 0.0;
        vec2 impactSlope = vec2(0.0);
        // Fine, drifting bubble texture for foam (two scales, opposite drift).
        float foamNoise = texture2D(uRipplesB, vGardenWorld.xy * 3.1 + vec2(0.05, 0.03) * uGardenTime).a * 0.55
          + texture2D(uRipplesA, vGardenWorld.xy * 5.3 - vec2(0.04, 0.06) * uGardenTime).a * 0.45;
        for (int i = 0; i < ${MAX_IMPACTS}; i++) {
          if (i >= uImpactCount) break;
          vec4 impact = uImpacts[i];
          if (abs(uImpactZ[i] - vGardenWorld.z) > 0.02) continue;
          vec2 d = vGardenWorld.xy - impact.xy;
          float r = length(d) / max(impact.z, 0.05);
          float core = exp(-r * r * 1.6) * impact.w;
          waterFoam += core * mix(0.62, 1.0, smoothstep(0.35, 0.7, foamNoise)) * smoothstep(0.0, 0.25, core + foamNoise * 0.2 - 0.1);
          // Expanding rings from the falling water.
          float ring = sin(r * 9.0 - uGardenTime * 7.0) * exp(-r * 1.2) * impact.w;
          impactSlope += normalize(d + 1e-4) * ring * 0.16;
        }
        // Meniscus/flow foam along walls where the current is strong.
        waterFoam += (1.0 - smoothstep(0.015, 0.06, wallDistance)) * smoothstep(0.15, 0.6, waterSpeed) * mix(0.25, 0.7, foamNoise) * 0.5;
        // Spiral foam arms wind into the drain.
        if (abs(uDrain.z - vGardenWorld.z) < 0.08 && uDrain.w > 0.0) {
          vec2 d = vGardenWorld.xy - uDrain.xy;
          float r = length(d);
          float arms = sin(atan(d.y, d.x) * 3.0 + log(r + 0.02) * 9.0 + uGardenTime * 6.0);
          waterFoam += uDrain.w * smoothstep(0.55, 1.0, arms) * smoothstep(0.55, 0.15, r) * smoothstep(0.1, 0.16, r) * 0.7;
        }
        // The advancing tongue of water is aerated and bright.
        waterFoam += leadingEdge * mix(0.3, 1.0, smoothstep(0.42, 0.62, foamNoise)) * 0.75;
        waterFoam = clamp(waterFoam, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), waterFoam);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.6, waterFoam);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 flowSlope = flowSample.xy * 2.0 - 1.0;
        vec2 windA = texture2D(uRipplesB, vGardenWorld.xy * 1.35 + vec2(0.021, 0.013) * uGardenTime).xy * 2.0 - 1.0;
        vec2 windB = texture2D(uRipplesB, mat2(0.8, 0.6, -0.6, 0.8) * vGardenWorld.xy * 2.3 - vec2(0.017, 0.026) * uGardenTime).xy * 2.0 - 1.0;
        float calm = 0.35 + 0.65 * uGardenStyle;
        // Slopes of ~0.1–0.2 rad tilt enough facets towards the sun for the
        // scattered glints of real rippled water.
        vec2 waterSlope = flowSlope * (0.08 + 0.3 * smoothstep(0.02, 0.6, waterSpeed)) * calm
          + (windA * 0.6 + windB * 0.4) * 0.15 * calm + impactSlope;
        normal = normalize(normal + mat3(viewMatrix) * vec3(waterSlope, 0.0));`)
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment
        .replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - waterFoam * 0.9);')
        // A short refraction path keeps the screen-space refraction from
        // sampling the walls above the water; Beer–Lambert absorption uses
        // the true depth below.
        .replace('material.thickness = thickness;', 'material.thickness = 0.04;')
        .replace('totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );',
          'transmitted.rgb *= pow(max(attenuationColor, vec3(1e-3)), vec3((0.2 + 0.25 * clamp(vPoolDepth, 0.0, 0.6)) * thickness * 1.15 / attenuationDistance));\n\ttotalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );'))
  }
  material.customProgramCacheKey = () => 'garden-water-v2'
  return material
}

export interface CurtainUniforms {
  uStart: THREE.IUniform<THREE.Vector3>
  uDirection: THREE.IUniform<THREE.Vector2>
  uReach: THREE.IUniform<number>
  uDrop: THREE.IUniform<number>
  uWidth: THREE.IUniform<number>
  uFlare: THREE.IUniform<number>
  uStrength: THREE.IUniform<number>
  uAeration: THREE.IUniform<number>
  uTravel: THREE.IUniform<number>
  uCurtainTint: THREE.IUniform<THREE.Color>
}

/**
 * A falling or flowing sheet. The vertex shader bends a flat strip along the
 * ballistic path P(v) = start + dir·reach·v − z·drop·v²; the fragment shader
 * adds travelling streaks, white aeration and translucent glassy water.
 */
export function createCurtainMaterial(uniforms: GardenUniforms): { material: THREE.MeshPhysicalMaterial; uniforms: CurtainUniforms } {
  const own: CurtainUniforms = {
    uStart: { value: new THREE.Vector3() }, uDirection: { value: new THREE.Vector2(0, -1) },
    uReach: { value: 0.3 }, uDrop: { value: 0.5 }, uWidth: { value: 0.5 }, uFlare: { value: 0.15 },
    uStrength: { value: 0 }, uAeration: { value: 0.6 }, uTravel: { value: 0 }, uCurtainTint: { value: new THREE.Color(0.75, 0.93, 0.95) },
  }
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    envMapIntensity: 1.4, ior: 1.333, specularIntensity: 1, transmission: 1, thickness: 0.05,
  })
  material.onBeforeCompile = shader => {
    inject(shader, uniforms)
    Object.assign(shader.uniforms, own)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uStart;
        uniform vec2 uDirection;
        uniform float uReach;
        uniform float uDrop;
        uniform float uWidth;
        uniform float uFlare;
        uniform float uTravel;
        varying vec2 vCurtainUv;
        varying float vCurtainFacing;`)
      .replace('#include <beginnormal_vertex>', `
        // A rounded sheet: the cross-section bulges like a real pouring
        // lip (thicker in the middle), which catches light across its width.
        float cv = uv.y;
        float theta = (uv.x - 0.5) * 3.14159;
        vec3 curtainDir = vec3(uDirection, 0.0);
        vec3 curtainAcross = vec3(-uDirection.y, uDirection.x, 0.0);
        vec3 curtainTangent = normalize(curtainDir * uReach - vec3(0.0, 0.0, 2.0 * uDrop * cv));
        vec3 sheetNormal = normalize(cross(curtainAcross, curtainTangent));
        vec3 objectNormal = normalize(sheetNormal * cos(theta) + curtainAcross * sin(theta) * 0.8);
        vCurtainFacing = cos(theta);
        #ifdef USE_TANGENT
          vec3 objectTangent = curtainAcross;
        #endif`)
      .replace('#include <begin_vertex>', `
        float thickness = min(0.07, uWidth * 0.14) * (0.6 + 0.8 * cv);
        // Travelling wobble: the sheet necks and swells as it falls.
        float wobble = sin(cv * 9.0 - uTravel * 5.0 + uv.x * 3.0) * 0.012 * cv;
        vec3 transformed = uStart + curtainDir * (uReach * cv) - vec3(0.0, 0.0, uDrop * cv * cv)
          + curtainAcross * ((uv.x - 0.5) * uWidth * (1.0 + uFlare * cv) + wobble)
          + sheetNormal * thickness * cos(theta);
        vCurtainUv = uv;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uRipplesA;
        uniform sampler2D uRipplesB;
        uniform float uStrength;
        uniform float uAeration;
        uniform float uTravel;
        uniform float uWidth;
        uniform float uDrop;
        uniform float uReach;
        uniform vec3 uCurtainTint;
        varying vec2 vCurtainUv;
        varying float vCurtainFacing;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float pathLength = uReach + uDrop;
        float along = vCurtainUv.y;
        // Long vertical streaks: noise stretched along the fall and pulled
        // down at the water's speed; a second, finer layer shears past it.
        vec2 streakUv = vec2(vCurtainUv.x * uWidth * 3.2, along * pathLength * 0.35 - uTravel * 0.55);
        vec4 streak = texture2D(uRipplesA, streakUv * vec2(1.0, 0.18));
        float fine = texture2D(uRipplesB, vec2(vCurtainUv.x * uWidth * 7.0 + 0.3, along * pathLength * 0.8 - uTravel * 0.9) * vec2(1.0, 0.25)).a;
        float streaks = streak.a * 0.6 + fine * 0.4;
        float edge = smoothstep(0.0, 0.12, vCurtainUv.x) * smoothstep(1.0, 0.88, vCurtainUv.x);
        float lip = smoothstep(0.0, 0.04, along);
        // Aeration grows with the fall; the tail breaks into ragged fingers.
        // Clear, refracting water; only the bottom of a real drop aerates.
        float aerated = uAeration * smoothstep(0.45, 1.0, along);
        float white = smoothstep(0.35, 0.85, aerated * (0.55 + streaks * 0.9));
        float tail = 1.0 - smoothstep(0.85, 1.0, along) * (1.0 - smoothstep(0.35, 0.75, streaks));
        diffuseColor.rgb = mix(uCurtainTint, vec3(1.0), white);
        diffuseColor.a = uStrength * edge * lip * tail * mix(0.9, 0.97, white);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.03, 0.55, white);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Rope-like corrugation of a falling sheet: bends refraction and glints.
        vec2 streakSlope = streak.xy * 2.0 - 1.0;
        normal = normalize(normal + vec3(streakSlope.x * 0.35 + (fine - 0.5) * 0.3, streakSlope.y * 0.1, 0.0));`)
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment
        .replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - white);'))
  }
  material.customProgramCacheKey = () => 'garden-curtain-v3'
  return { material, uniforms: own }
}

/** Lit spray droplets animated entirely on the GPU from the impact list. */
export function createDropletMaterial(uniforms: GardenUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.85, envMapIntensity: 1.3 })
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSlot;
        attribute vec3 aSeed;
        uniform vec4 uImpacts[${MAX_IMPACTS}];
        uniform float uImpactZ[${MAX_IMPACTS}];
        uniform float uGardenTime;`)
      .replace('#include <begin_vertex>', `
        vec4 impact = uImpacts[int(aSlot + 0.5)];
        float life = fract(uGardenTime * (0.8 + aSeed.x * 0.9) + aSeed.y);
        float angle = aSeed.z * 6.2831853;
        float speed = (0.35 + aSeed.x * 0.9) * sqrt(impact.w);
        vec2 spread = vec2(cos(angle), sin(angle)) * (impact.z * 0.4 + speed * life * 0.55);
        float rise = speed * 1.1 * life - 4.9 * life * life * 0.5;
        float size = (0.014 + 0.028 * aSeed.y) * step(0.02, impact.w) * (1.0 - life * 0.6) * step(0.0, rise + 0.01);
        vec3 transformed = position * size + vec3(impact.xy + spread, uImpactZ[int(aSlot + 0.5)] + max(rise, 0.0));`)
  }
  material.customProgramCacheKey = () => 'garden-droplets-v1'
  return material
}

/**
 * Warm sand ground: fine grain, broad mottling, dappled leaf shade and a
 * contact occlusion halo from the plan field. It fades exactly into the
 * background colour so the studio has no visible horizon edge.
 */
export function createGroundMaterial(uniforms: GardenUniforms, center: THREE.Vector2, radius: number): { material: THREE.MeshStandardMaterial; background: THREE.IUniform<THREE.Color> } {
  const background = { value: new THREE.Color(0xf0e7da) }
  const material = new THREE.MeshStandardMaterial({ color: 0xd9c8b0, roughness: 0.93, metalness: 0, envMapIntensity: 0.6 })
  const shadeRects = { value: [new THREE.Vector4(center.x - radius * 1.35, center.y + radius * 0.2, radius * 1.3, radius * 1.3), new THREE.Vector4(center.x + radius * 0.45, center.y - radius * 1.25, radius * 1.1, radius * 1.1)] }
  material.onBeforeCompile = shader => {
    inject(shader, uniforms)
    Object.assign(shader.uniforms, { uBackgroundColor: background, uShadeRects: shadeRects, uGroundCenter: { value: center }, uGroundRadius: { value: radius } })
    shader.vertexShader = FORCE_WORLDPOS + shader.vertexShader
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <dithering_pars_fragment>', `#include <dithering_pars_fragment>
        uniform sampler2D uLeafShade;
        uniform vec3 uBackgroundColor;
        uniform vec4 uShadeRects[2];
        uniform vec2 uGroundCenter;
        uniform float uGroundRadius;
        float leafShade(vec2 p) {
          float light = 1.0;
          for (int i = 0; i < 2; i++) {
            vec4 r = uShadeRects[i];
            vec2 uv = (p - r.xy) / r.zw;
            if (i == 1) uv = vec2(1.0) - uv.yx;
            float sway = sin(uGardenTime * 0.7 + float(i) * 2.0) * 0.004;
            float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
            light *= mix(1.0, texture2D(uLeafShade, uv + sway).r, inside);
          }
          return light;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 sandP = vGardenWorld.xy;
        float sand = gardenNoise(sandP * 0.6) * 0.5 + gardenNoise(sandP * 2.3) * 0.3 + gardenNoise(sandP * 9.0) * 0.2;
        float grain = gardenHash(floor(sandP * 220.0));
        diffuseColor.rgb *= 0.93 + sand * 0.1 + (grain - 0.5) * 0.05;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        vec4 groundField = gardenField(vGardenWorld.xy);
        float outside = groundField.b >= 0.5 ? (groundField.b - 0.5) * 2.0 * 2.0 : 0.0;
        float contact = mix(0.45, 1.0, smoothstep(0.0, 0.9, outside));
        reflectedLight.directDiffuse *= leafShade(vGardenWorld.xy);
        reflectedLight.indirectDiffuse *= contact;
        reflectedLight.directDiffuse *= mix(1.0, contact, 0.3);`)
      .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
        float groundFade = smoothstep(uGroundRadius * 1.1, uGroundRadius * 2.4, length(vGardenWorld.xy - uGroundCenter));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uBackgroundColor, groundFade);`)
  }
  material.customProgramCacheKey = () => 'garden-sand-ground-v1'
  return { material, background }
}

export interface ChannelUniforms {
  uChannelFlow: THREE.IUniform<THREE.DataTexture>
  uChannelTint: THREE.IUniform<THREE.Color>
}

/**
 * Water running along chutes and troughs. The flow texture holds the
 * simulated discharge sampled along every channel (one row each), so the
 * advancing head, its foam and the depth all follow the transit lines.
 */
export function createChannelWaterMaterial(uniforms: GardenUniforms, flow: THREE.DataTexture): { material: THREE.MeshPhysicalMaterial; uniforms: ChannelUniforms } {
  const own: ChannelUniforms = { uChannelFlow: { value: flow }, uChannelTint: { value: new THREE.Color(0.72, 0.92, 0.94) } }
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, depthWrite: false,
    envMapIntensity: 1.3, ior: 1.333, specularIntensity: 1, transmission: 1, thickness: 0.04,
  })
  material.onBeforeCompile = shader => {
    inject(shader, uniforms)
    Object.assign(shader.uniforms, own)
    const common = `
        uniform sampler2D uChannelFlow;
        attribute float aAlong;
        attribute float aRow;
        attribute float aSide;
        attribute float aLength;
        attribute float aWidth;
        varying float vFlow;
        varying float vAhead;
        varying vec2 vChannel;
        float channelFlow(float along) { return texture2D(uChannelFlow, vec2(along, aRow)).r; }`
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${common}`)
      .replace('#include <begin_vertex>', `
        vFlow = channelFlow(aAlong);
        vAhead = channelFlow(min(1.0, aAlong + 0.35 / aLength));
        // Critical depth over the channel width, crowned in the middle.
        float depth = clamp(pow(max(vFlow, 0.0) / (1.705 * aWidth), 0.6667), 0.0, 0.13);
        vec3 transformed = position;
        transformed.z += 0.004 + depth * (1.0 + 0.12 * (1.0 - aSide * aSide));
        vChannel = vec2(aAlong * aLength, aSide * aWidth * 0.5);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uRipplesA;
        uniform sampler2D uRipplesB;
        uniform vec3 uChannelTint;
        varying float vFlow;
        varying float vAhead;
        varying vec2 vChannel;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wet = smoothstep(0.0005, 0.004, vFlow);
        if (wet < 0.01) discard;
        // The advancing head: churned white where water has nothing ahead.
        float head = 1.0 - smoothstep(0.0005, 0.006, vAhead);
        vec2 flowUv = vec2(vChannel.x * 0.9 - uGardenTime * 1.4, vChannel.y * 1.6);
        vec4 ripple = texture2D(uRipplesA, flowUv * vec2(0.5, 1.0));
        float fine = texture2D(uRipplesB, vec2(vChannel.x * 2.1 - uGardenTime * 2.2, vChannel.y * 3.0)).a;
        float white = clamp(head * (0.55 + fine * 0.6) + smoothstep(0.62, 0.9, ripple.a * 0.6 + fine * 0.5) * 0.35, 0.0, 1.0);
        diffuseColor.rgb = mix(uChannelTint, vec3(1.0), white);
        diffuseColor.a = wet * mix(0.9, 0.97, white);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.04, 0.5, white);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 channelSlope = ripple.xy * 2.0 - 1.0;
        normal = normalize(normal + vec3(channelSlope * 0.35, 0.0) + vec3((fine - 0.5) * 0.25));`)
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment
        .replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - white);'))
  }
  material.customProgramCacheKey = () => 'garden-channel-water-v1'
  return { material, uniforms: own }
}
