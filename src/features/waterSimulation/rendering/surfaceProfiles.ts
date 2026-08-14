export type WaterSurfaceStyle = 'calm' | 'natural' | 'dynamic'
export type WaterVisualQuality = 'low' | 'high'
export type WaterFoamMode = 'procedural' | 'history'

export interface DirectionalWaveBand {
  readonly wavelengthCells: number
  readonly amplitude: number
  readonly speed: number
  readonly crossFlow: number
  readonly phase: number
}

export interface WaterSurfaceProfile {
  readonly style: WaterSurfaceStyle
  readonly quality: WaterVisualQuality
  readonly waveBands: readonly DirectionalWaveBand[]
  readonly detailStrength: number
  readonly fresnelPower: number
  readonly glitterStrength: number
  readonly subsurfaceStrength: number
  readonly reflectionStrength: number
  readonly foamMode: WaterFoamMode
  readonly foamBuildRate: number
  readonly foamDecayRate: number
}

interface WaterSurfaceStyleBase {
  readonly amplitude: number
  readonly speed: number
  readonly detail: number
  readonly glitter: number
  readonly subsurface: number
  readonly reflection: number
  readonly crossFlowScale: number
  readonly phaseSalt: number
  readonly build: number
  readonly decay: number
}

const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const STYLE_BASES: Readonly<Record<WaterSurfaceStyle, WaterSurfaceStyleBase>> = {
  calm: {
    amplitude: 0.42,
    speed: 0.55,
    detail: 0.24,
    glitter: 0.18,
    subsurface: 0.16,
    reflection: 0.78,
    crossFlowScale: 0.58,
    phaseSalt: 0x2c1b3c6d,
    build: 1.2,
    decay: 0.82,
  },
  natural: {
    amplitude: 0.78,
    speed: 0.86,
    detail: 0.52,
    glitter: 0.36,
    subsurface: 0.32,
    reflection: 0.68,
    crossFlowScale: 0.86,
    phaseSalt: 0x517cc1b7,
    build: 2.1,
    decay: 0.62,
  },
  dynamic: {
    amplitude: 1.15,
    speed: 1.24,
    detail: 0.82,
    glitter: 0.58,
    subsurface: 0.5,
    reflection: 0.58,
    crossFlowScale: 1.08,
    phaseSalt: 0x68bc21eb,
    build: 3.2,
    decay: 0.46,
  },
}

function seedUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return (value >>> 0) / 0x1_0000_0000
}

function numericSeed(seed: string | number): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) {
      throw new RangeError('Water surface seed must be finite.')
    }
    return seed >>> 0
  }
  let result = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    result = Math.imul(result ^ seed.charCodeAt(index), 16777619)
  }
  return result >>> 0
}

function createBandCrossFlow(
  seed: number,
  index: number,
  scale: number,
): number {
  const magnitudeJitter = seedUnit(seed, index + 23) * 0.035
  const magnitude = (0.055 + index * 0.105 + magnitudeJitter) * scale
  const direction = seedUnit(seed, index + 47) < 0.5 ? -1 : 1
  return direction * magnitude
}

function createBandPhase(seed: number, index: number): number {
  return (seedUnit(seed, index + 71) * TAU + index * GOLDEN_ANGLE) % TAU
}

/**
 * Resolves visual work only. It never changes solver timestep or snapshots,
 * so low/high quality consume identical hydraulic physics.
 */
export function createWaterSurfaceProfile(
  style: WaterSurfaceStyle,
  quality: WaterVisualQuality,
  seed: string | number = 'mazecraft-water',
): WaterSurfaceProfile {
  const base = STYLE_BASES[style]
  const bandCount = quality === 'low'
    ? (style === 'calm' ? 1 : 2)
    : (style === 'calm' ? 2 : 3)
  const wavelengths = [4.8, 1.75, 0.54]
  const amplitudes = [1, 0.46, 0.18]
  const speeds = [0.64, 1.12, 1.86]
  const resolvedSeed = numericSeed(seed)
  const styledSeed = (resolvedSeed ^ base.phaseSalt) >>> 0
  const bands: DirectionalWaveBand[] = []
  for (let index = 0; index < bandCount; index += 1) {
    bands.push(Object.freeze({
      wavelengthCells: wavelengths[index],
      amplitude: base.amplitude * amplitudes[index],
      speed: base.speed * speeds[index],
      crossFlow: createBandCrossFlow(
        styledSeed,
        index,
        base.crossFlowScale,
      ),
      phase: createBandPhase(styledSeed, index),
    }))
  }
  return Object.freeze({
    style,
    quality,
    waveBands: Object.freeze(bands),
    detailStrength: quality === 'high' ? base.detail : base.detail * 0.46,
    fresnelPower: style === 'calm' ? 3.2 : 2.65,
    glitterStrength: quality === 'high' ? base.glitter : base.glitter * 0.45,
    subsurfaceStrength: base.subsurface,
    reflectionStrength: base.reflection,
    foamMode: quality === 'high' ? 'history' : 'procedural',
    foamBuildRate: base.build,
    foamDecayRate: base.decay,
  })
}
