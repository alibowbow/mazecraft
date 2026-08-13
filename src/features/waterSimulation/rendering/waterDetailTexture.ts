export interface WaterDetailTextureOptions {
  size?: number
  seed?: string | number
  octaves?: number
}

export interface WaterDetailTextureData {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  readonly seed: number
  readonly encoding: 'normal-rg-structure-ba'
}

function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new RangeError('Detail seed must be finite.')
    return seed >>> 0
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function latticeHash(x: number, y: number, seed: number): number {
  let value = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return (value >>> 0) / 0x1_0000_0000
}

const smooth = (value: number): number => value * value * (3 - 2 * value)

function periodicValueNoise(
  x: number,
  y: number,
  period: number,
  seed: number,
): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smooth(x - x0)
  const ty = smooth(y - y0)
  const wrap = (value: number) => ((value % period) + period) % period
  const a = latticeHash(wrap(x0), wrap(y0), seed)
  const b = latticeHash(wrap(x0 + 1), wrap(y0), seed)
  const c = latticeHash(wrap(x0), wrap(y0 + 1), seed)
  const d = latticeHash(wrap(x0 + 1), wrap(y0 + 1), seed)
  const lower = a + (b - a) * tx
  const upper = c + (d - c) * tx
  return lower + (upper - lower) * ty
}

function fractalNoise(
  u: number,
  v: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0
  let amplitude = 1
  let amplitudeSum = 0
  let period = 2
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += periodicValueNoise(u * period, v * period, period, seed + octave * 1013) * amplitude
    amplitudeSum += amplitude
    amplitude *= 0.52
    period *= 2
  }
  return sum / amplitudeSum
}

const clampByte = (value: number): number =>
  Math.round(Math.max(0, Math.min(1, value)) * 255)

/**
 * Creates one deterministic, repeatable surface-detail texture for a scene.
 * RG stores periodic normal-XY perturbation components while BA stores
 * independent low/high-frequency structure for foam breakup.
 */
export function createWaterDetailTextureData(
  options: WaterDetailTextureOptions = {},
): WaterDetailTextureData {
  const size = options.size ?? 128
  const octaves = options.octaves ?? 4
  if (!Number.isInteger(size) || size < 8 || size > 512) {
    throw new RangeError('Detail texture size must be an integer from 8 to 512.')
  }
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > 6) {
    throw new RangeError('Detail texture octaves must be an integer from 1 to 6.')
  }
  const seed = hashSeed(options.seed ?? 'mazecraft-water')
  const heights = new Float32Array(size * size)
  const lowStructure = new Float32Array(size * size)
  const highStructure = new Float32Array(size * size)
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const v = y / size
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const texel = y * size + x
      const first = fractalNoise(u, v, octaves, seed)
      const second = fractalNoise(
        (u + 0.371) % 1,
        (v + 0.613) % 1,
        octaves,
        seed ^ 0xa5a5a5a5,
      )
      const fine = periodicValueNoise(u * 32, v * 32, 32, seed ^ 0x51ed270b)
      heights[texel] = first
      lowStructure[texel] = second
      highStructure[texel] = fine
    }
  }

  const wrappedIndex = (x: number, y: number): number =>
    (((y + size) % size) * size + ((x + size) % size))
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const texel = y * size + x
      const slopeX =
        (heights[wrappedIndex(x + 1, y)] -
          heights[wrappedIndex(x - 1, y)]) *
        size *
        0.18
      const slopeY =
        (heights[wrappedIndex(x, y + 1)] -
          heights[wrappedIndex(x, y - 1)]) *
        size *
        0.18
      const inverseLength = 1 / Math.hypot(slopeX, slopeY, 1)
      const offset = texel * 4
      data[offset] = clampByte(-slopeX * inverseLength * 0.5 + 0.5)
      data[offset + 1] = clampByte(-slopeY * inverseLength * 0.5 + 0.5)
      data[offset + 2] = clampByte(lowStructure[texel])
      data[offset + 3] = clampByte(highStructure[texel])
    }
  }
  return {
    width: size,
    height: size,
    data,
    seed,
    encoding: 'normal-rg-structure-ba',
  }
}
