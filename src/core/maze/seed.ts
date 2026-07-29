export type SeedInput = string | number

function xmur3(value: string): () => number {
  let hash = 1779033703 ^ value.length
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }

  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
    return (hash ^= hash >>> 16) >>> 0
  }
}
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function normalizeSeed(seed: SeedInput): string {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) {
      throw new TypeError('Seed must be a finite number or string.')
    }
    return String(seed)
  }

  const normalized = seed.trim()
  if (!normalized) {
    throw new TypeError('Seed must not be empty.')
  }
  return normalized
}

export class SeededRandom {
  readonly seed: string
  private readonly nextValue: () => number

  constructor(seed: SeedInput, stream = 'default') {
    this.seed = normalizeSeed(seed)
    const hash = xmur3(`${this.seed}\u0000${stream}`)
    this.nextValue = mulberry32(hash())
  }

  next(): number {
    return this.nextValue()
  }

  integer(minInclusive: number, maxExclusive: number): number {
    if (
      !Number.isInteger(minInclusive) ||
      !Number.isInteger(maxExclusive) ||
      maxExclusive <= minInclusive
    ) {
      throw new RangeError('Random integer bounds are invalid.')
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive))
  }

  boolean(probability = 0.5): boolean {
    const bounded = Math.min(1, Math.max(0, probability))
    return this.next() < bounded
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError('Cannot choose from an empty array.')
    }
    return values[this.integer(0, values.length)]
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values]
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.integer(0, index + 1)
      const value = result[index]
      result[index] = result[swapIndex]
      result[swapIndex] = value
    }
    return result
  }
}

export function createSeededRandom(seed: SeedInput, stream?: string): SeededRandom {
  return new SeededRandom(seed, stream)
}

export function deriveSeed(seed: SeedInput, ...parts: readonly (string | number)[]): string {
  return [normalizeSeed(seed), ...parts.map(String)].join(':')
}
