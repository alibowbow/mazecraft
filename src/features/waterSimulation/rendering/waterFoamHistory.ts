export interface FoamHistoryOptions {
  buildRate?: number
  decayRate?: number
}

/** CPU reference/history buffer. A GPU ping-pong target can mirror this rule. */
export class WaterFoamHistory {
  private front: Float32Array
  private back: Float32Array
  private readonly buildRate: number
  private readonly decayRate: number
  version = 0

  constructor(
    readonly width: number,
    readonly height: number,
    options: FoamHistoryOptions = {},
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 512 ||
      height > 512
    ) {
      throw new RangeError('Foam history dimensions must be integers from 1 to 512.')
    }
    this.buildRate = options.buildRate ?? 2.1
    this.decayRate = options.decayRate ?? 0.62
    if (!(this.buildRate >= 0) || !(this.decayRate >= 0)) {
      throw new RangeError('Foam build and decay rates must be non-negative.')
    }
    this.front = new Float32Array(width * height)
    this.back = new Float32Array(width * height)
  }

  get data(): Float32Array {
    return this.front
  }

  /** Paused updates are a strict no-op, including buffer identity and version. */
  step(source: ArrayLike<number>, deltaSeconds: number, paused = false): Float32Array {
    if (paused || deltaSeconds === 0) return this.front
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
      throw new RangeError('Foam deltaSeconds must be in the range [0, 1].')
    }
    if (source.length < this.front.length) {
      throw new RangeError('Foam source dimensions must match the history buffer.')
    }
    const decay = Math.exp(-this.decayRate * deltaSeconds)
    for (let index = 0; index < this.front.length; index += 1) {
      const sourceValue = Number(source[index])
      if (!Number.isFinite(sourceValue)) {
        throw new RangeError('Foam source must contain only finite values.')
      }
      const excitation = Math.max(0, Math.min(1, sourceValue))
      const retained = this.front[index] * decay
      const build = 1 - Math.exp(-this.buildRate * excitation * deltaSeconds)
      this.back[index] = Math.max(0, Math.min(1, retained + (1 - retained) * build))
    }
    const previous = this.front
    this.front = this.back
    this.back = previous
    this.version += 1
    return this.front
  }

  reset(): void {
    this.front.fill(0)
    this.back.fill(0)
    this.version += 1
  }
}
