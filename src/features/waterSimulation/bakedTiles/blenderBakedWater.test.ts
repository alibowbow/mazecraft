import { describe, expect, it } from 'vitest'
import {
  enhanceBlenderWaterFragmentShader,
  enhanceBlenderWaterVertexShader,
} from './blenderBakedWater'
import {
  BLENDER_WATER_TILE_NAMES,
  parseBlenderWaterManifest,
} from './manifest'

const validManifest = () => ({
  schemaVersion: 1,
  generator: {
    name: 'Blender',
    version: '4.5.12',
    mode: 'procedural-runtime-atlas',
  },
  atlas: {
    file: 'surface-atlas.png',
    width: 1024,
    height: 512,
    tileSize: 64,
    frames: 16,
    rows: 8,
    frameRate: 12,
    colorSpace: 'linear',
  },
  runtime: {
    heightStrength: 0.038,
    normalStrength: 0.34,
    foamStrength: 0.86,
  },
  channels: {
    r: 'normalX',
    g: 'normalY',
    b: 'height',
    a: 'foam',
  },
  tiles: BLENDER_WATER_TILE_NAMES.map((name, row) => ({ name, row })),
})

const vertexFixture = `
  // MAZECRAFT_WATER_SURFACE_DYNAMICS_VERTEX
  uniform sampler2D uTopology;
  uniform sampler2D uDynamicState;
  uniform float uWaveTime;
  uniform vec2 uBoardSize;

  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {
    return 1.0;
  }

  void main() {
    float mask = 1.0;
    float depth = 0.5;
    vec2 velocity = vec2(0.0, -1.0);
    float motion = 0.5;
    vec3 transformed = position;
    vUv = uv;
  }
`

const fragmentFixture = `
  // MAZECRAFT_WATER_SURFACE_DYNAMICS_FRAGMENT
  uniform sampler2D uTopology;
  uniform sampler2D uDynamicState;
  uniform sampler2D uFoamHistory;
  uniform float uWaveTime;
  uniform vec2 uBoardSize;

  void main() {
    vec4 dynamicState = vec4(0.0);
    float depth = 0.5;
    float speed = 0.2;
    vec2 vVelocity = vec2(0.0, -1.0);
    vec2 vUv = vec2(0.5);
    float motion = smoothstep(0.002, 0.12, speed);
    float simulatedHeight = 0.0;
    vec2 simulatedSlope = waterWorldSlope(
      dFdx(vWorldPosition.xy), dFdy(vWorldPosition.xy),
      dFdx(simulatedHeight), dFdy(simulatedHeight)
    ) * 0.04;
    vec3 bodyColor = vec3(0.0);
    float caustic = 0.0;
    bodyColor += vec3(0.12, 0.72, 0.61) * caustic * 0.12;
    float foam = 0.0;
    vec4 detailA = vec4(1.0);
    vec4 detailB = vec4(1.0);
    float turbulence = 0.0;
    float bubbleStructure = mix(
      0.7,
      1.1,
      detailA.b * detailB.a * mix(0.72, 1.0, turbulence)
    );
  }
`

describe('Blender water manifest', () => {
  it('accepts the generated eight-row atlas contract', () => {
    const manifest = parseBlenderWaterManifest(validManifest())
    expect(manifest.atlas.width).toBe(1024)
    expect(manifest.atlas.height).toBe(512)
    expect(manifest.tiles.map((tile) => tile.name)).toEqual(
      BLENDER_WATER_TILE_NAMES,
    )
  })

  it('rejects invalid dimensions and tile ordering', () => {
    const wrongWidth = validManifest()
    wrongWidth.atlas.width = 1000
    expect(() => parseBlenderWaterManifest(wrongWidth)).toThrow(/width/)

    const wrongOrder = validManifest()
    wrongOrder.tiles = [...wrongOrder.tiles].reverse()
    expect(() => parseBlenderWaterManifest(wrongOrder)).toThrow(/tiles\[0\]/)
  })

  it('rejects paths that escape the generated asset directory', () => {
    const manifest = validManifest()
    manifest.atlas.file = '../secret.png'
    expect(() => parseBlenderWaterManifest(manifest)).toThrow(/relative file/)
  })
})

describe('Blender-baked water shader layer', () => {
  it('adds topology classification, animated sampling and height', () => {
    const enhanced = enhanceBlenderWaterVertexShader(vertexFixture)
    expect(enhanced).toContain('MAZECRAFT_BLENDER_BAKED_WATER_VERTEX')
    expect(enhanced).toContain('blenderTileAndOrientation')
    expect(enhanced).toContain('blenderPortalOpen')
    expect(enhanced).toContain('sampleBlenderWater')
    expect(enhanced).toContain('uBlenderWaterHeightStrength')
    expect(enhanceBlenderWaterVertexShader(enhanced)).toBe(enhanced)
  })

  it('adds baked normals, foam and shallow caustic energy', () => {
    const enhanced = enhanceBlenderWaterFragmentShader(fragmentFixture)
    expect(enhanced).toContain('MAZECRAFT_BLENDER_BAKED_WATER_FRAGMENT')
    expect(enhanced).toContain('uBlenderWaterNormalStrength')
    expect(enhanced).toContain('uBlenderWaterFoamStrength')
    expect(enhanced).toContain('blenderCaustic')
    expect(enhanceBlenderWaterFragmentShader(enhanced)).toBe(enhanced)
  })

  it('leaves unrelated shaders untouched', () => {
    const unrelated = 'void main() { gl_Position = vec4(0.0); }'
    expect(enhanceBlenderWaterVertexShader(unrelated)).toBe(unrelated)
    expect(enhanceBlenderWaterFragmentShader(unrelated)).toBe(unrelated)
  })
})
