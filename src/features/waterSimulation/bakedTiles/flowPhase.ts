/** Integrated normalized hydraulic displacement, independent of render FPS. */
export class WaterFlowPhase {
  readonly data: Float32Array
  private readonly accumulated: Float64Array
  private time = 0

  constructor(readonly width: number, readonly height: number) {
    this.data = new Float32Array(width * height * 4)
    this.accumulated = new Float64Array(this.data.length)
  }

  reset(): void {
    this.data.fill(0)
    this.accumulated.fill(0)
    this.time = 0
  }

  update(state: ArrayLike<number>, simulationTime: number): void {
    if (simulationTime < this.time) this.reset()
    const dt = simulationTime - this.time
    if (dt <= 0) return
    this.time = simulationTime
    for (let offset = 0; offset < this.data.length; offset += 4) {
      if (state[offset] <= 0.0015) {
        this.accumulated.fill(0, offset, offset + 4)
        this.data.fill(0, offset, offset + 4)
        continue
      }
      const vx = state[offset + 1]
      const vy = state[offset + 2]
      // One reference-speed (.12 normalized) cycle takes 16 / 12 seconds.
      const scale = dt * 6.25
      this.accumulated[offset] += vx * scale
      this.accumulated[offset + 1] += vy * scale
      this.accumulated[offset + 2] += Math.hypot(vx, vy) * scale
      // Integer cycle wrap preserves precision during long-running sessions.
      for (let component = 0; component < 3; component += 1) {
        const index = offset + component
        this.accumulated[index] %= 256
        this.data[index] = this.accumulated[index]
      }
    }
  }
}
