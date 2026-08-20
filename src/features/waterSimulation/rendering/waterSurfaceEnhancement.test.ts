import { describe, expect, it } from 'vitest'
import { resolveWaterSurfaceHistoryResolution } from './waterFoamRenderTargets'
import {
  enhanceWaterFragmentShader,
  enhanceWaterVertexShader,
} from './waterShaderEnhancer'

const VERTEX_FIXTURE = `
  uniform sampler2D uDynamicState;
  uniform vec2 uBoardSize;

  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {
    return 1.0;
  }

  void main() {
    vec4 dynamicState = texture2D(uDynamicState, uv);
    float depth = dynamicState.r;
    float speed = length(dynamicState.gb);
    float motion = speed;
    float wave = 0.0;
    float impactDimple = 0.0;
    float impactShoulder = 0.0;
    float mask = 1.0;
    vec3 transformed = position;
    transformed.z += mask * (
      depth * (0.012 + wave * motion * mix(0.035, 0.12, motion)) -
      impactDimple * 0.026 +
      impactShoulder * 0.026
    );
    float totalAmplitude = 1.0;
    vWaveCrest = max(
      clamp(wave / totalAmplitude * 0.5 + 0.5, 0.0, 1.0) * motion,
      impactShoulder * 0.72
    );
  }
`

const FRAGMENT_FIXTURE = `
  uniform sampler2D uDynamicState;
  uniform sampler2D uFoamHistory;
  uniform float uFoamHistoryEnabled;
  uniform vec2 uBoardSize;

  void main() {
    vec4 dynamicState = texture2D(uDynamicState, vUv);
    vec4 detailA = vec4(1.0);
    vec4 detailB = vec4(1.0);
    float uDetailStrength = 1.0;
    float motion = 1.0;
    vec3 geometricNormal = vec3(0.0, 0.0, 1.0);
    vec2 detailNormal =
      ((detailA.rg * 2.0 - 1.0) +
        (detailB.rg * 2.0 - 1.0) * 0.48) *
      uDetailStrength * motion;
    vec3 normal = normalize(vec3(
      geometricNormal.xy + detailNormal * 0.24,
      max(0.2, geometricNormal.z)
    ));
    vec3 reflectedSun = vec3(1.0);
    vec3 viewDirection = vec3(1.0);
    float uGlitterStrength = 1.0;
    float glitter = pow(max(dot(reflectedSun, viewDirection), 0.0), 48.0) *
      uGlitterStrength;
    float depth = dynamicState.r;
    vec3 skyReflection = vec3(1.0);
    float fresnel = 0.2;
    float uReflectionStrength = 1.0;
    vec3 shallowCyan = vec3(0.025, 0.73, 0.9);
    vec3 deepBlue = vec3(0.005, 0.28, 0.59);
    vec3 bodyColor = mix(shallowCyan, deepBlue, smoothstep(0.08, 0.86, depth));
    bodyColor = mix(
      bodyColor,
      skyReflection,
      clamp(fresnel * uReflectionStrength, 0.0, 0.92)
    );
    bodyColor += vec3(0.82, 0.97, 1.0) * glitter;
    float subsurface = 0.0;
    float impactRing = 0.0;
    bodyColor += vec3(0.04, 0.7, 0.68) * subsurface;
    bodyColor = mix(bodyColor, vec3(0.15, 0.76, 0.84), impactRing * 0.18);
    vec2 channelUv = vUv;
    float uWaveTime = 0.0;
    vec3 sunDirection = vec3(1.0);
    float bubbleStructure = mix(0.72, 1.08, detailA.b * detailB.a);
    float foamLighting = mix(0.82, 1.12, max(dot(normal, sunDirection), 0.0));
    float mask = 1.0;
    float foam = 0.0;
    float alpha = mask * mix(0.38, 0.9, sqrt(depth));
    alpha = max(alpha, foam * mask * 0.76);
  }
`

describe('high-resolution water surface history', () => {
  it('upsamples ordinary mazes while respecting the GPU size ceiling', () => {
    expect(resolveWaterSurfaceHistoryResolution(30, 20)).toEqual({
      sourceWidth: 30,
      sourceHeight: 20,
      width: 360,
      height: 240,
      pixelsPerCell: 12,
    })
    expect(resolveWaterSurfaceHistoryResolution(100, 60)).toEqual({
      sourceWidth: 100,
      sourceHeight: 60,
      width: 500,
      height: 300,
      pixelsPerCell: 5,
    })
    expect(resolveWaterSurfaceHistoryResolution(512, 512)).toEqual({
      sourceWidth: 512,
      sourceHeight: 512,
      width: 512,
      height: 512,
      pixelsPerCell: 1,
    })
  })

  it('rejects invalid source and target dimensions', () => {
    expect(() => resolveWaterSurfaceHistoryResolution(0, 10)).toThrow(
      /source dimensions/,
    )
    expect(() => resolveWaterSurfaceHistoryResolution(10, 10, 16)).toThrow(
      /maximumSize/,
    )
  })
})

describe('water shader enhancement', () => {
  it('adds smooth hydraulic sampling and simulated vertex displacement once', () => {
    const enhanced = enhanceWaterVertexShader(VERTEX_FIXTURE)
    expect(enhanced).toContain('MAZECRAFT_WATER_SURFACE_DYNAMICS_VERTEX')
    expect(enhanced).toContain('sampleDynamicStateSmooth')
    expect(enhanced).toContain('hydraulicSurfaceHeight')
    expect(enhanced).toContain('simulatedVerticalVelocity')
    expect(enhanced).not.toContain('depth * (0.012')
    expect(enhanceWaterVertexShader(enhanced)).toBe(enhanced)
  })

  it('adds optical absorption, micro normals and turbulence-aware foam once', () => {
    const enhanced = enhanceWaterFragmentShader(FRAGMENT_FIXTURE)
    expect(enhanced).toContain('MAZECRAFT_WATER_SURFACE_DYNAMICS_FRAGMENT')
    expect(enhanced).toContain('absorptionCoefficient')
    expect(enhanced).toContain('simulatedSlope')
    expect(enhanced).toContain('causticInterference')
    expect(enhanced).toContain('opticalAlpha')
    expect(enhanceWaterFragmentShader(enhanced)).toBe(enhanced)
  })

  it('leaves unrelated shader sources untouched', () => {
    const unrelated = 'void main() { gl_Position = vec4(0.0); }'
    expect(enhanceWaterVertexShader(unrelated)).toBe(unrelated)
    expect(enhanceWaterFragmentShader(unrelated)).toBe(unrelated)
  })
})
