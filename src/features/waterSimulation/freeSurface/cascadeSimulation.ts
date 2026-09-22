import type { FluidLayout } from './types'
import {
  CASCADE_AREAS, CASCADE_FLOORS, CASCADE_INITIAL_DEPTH, CASCADE_SILL_DEPTH,
  CASCADE_SPILLS, CASCADE_WALL_HEIGHT, type CascadeSnapshot,
} from './cascadeTypes'

type Triple = [number, number, number]
const STEP = 1 / 120
const WEIR_FACTOR = 0.62 * Math.sqrt(2 * 9.81)
const SOURCE_FLOW = 0.42

/** Three real reservoirs exchange the same water that leaves their visible lips. */
export class CascadeSimulation {
  readonly areas: readonly [number, number, number]
  private readonly initialStoredVolume: number
  private readonly volumes: Triple
  private readonly activeCells: Uint8Array
  private readonly tierAt: Uint8Array
  private readonly depth: Float32Array
  private readonly velocity: Float32Array
  private readonly connections: Uint8Array
  private discharge: Triple = [0, 0, 0]
  private time = 0
  private accumulator = 0
  private injected = 0
  private discharged = 0
  private escaped = 0
  private injectedRemainder = 0
  private dischargedRemainder = 0
  private sourceRate = 0
  private maximumDepth = CASCADE_WALL_HEIGHT - 0.04
  private rimDepth = CASCADE_WALL_HEIGHT

  constructor(private readonly layout: FluidLayout, areas: readonly [number, number, number] = CASCADE_AREAS) {
    if (areas.some(area => !Number.isFinite(area) || area <= 0)) throw new RangeError('Cascade areas must be positive and finite.')
    if (layout.activeCells.length !== layout.rows * layout.cols || layout.bottomY <= layout.topY) throw new RangeError('Invalid cascade layout.')
    this.areas = [...areas]
    this.volumes = areas.map(area => area * CASCADE_INITIAL_DEPTH) as Triple
    this.initialStoredVolume = this.volumes.reduce((sum, volume) => sum + volume, 0)
    this.activeCells = Uint8Array.from(layout.activeCells)
    this.tierAt = new Uint8Array(this.activeCells.length)
    this.depth = new Float32Array(this.activeCells.length)
    this.velocity = new Float32Array(this.activeCells.length * 2)
    this.connections = new Uint8Array(this.activeCells.length).fill(255)
    for (let cell = 0; cell < this.activeCells.length; cell++) {
      const row = Math.floor(cell / layout.cols)
      this.tierAt[cell] = Math.max(0, Math.min(2, Math.floor((row - layout.topY) * 3 / (layout.bottomY - layout.topY))))
    }
    // These compatibility fields describe the three basins, not the old
    // editor wall network. Different levels meet only at their rendered lips.
    for (let cell = 0; cell < this.activeCells.length; cell++) {
      if (!this.activeCells[cell]) continue
      const row = Math.floor(cell / layout.cols), col = cell % layout.cols
      let portals = 0
      for (const [r, c, bit] of [[row, col + 1, 1], [row + 1, col, 2], [row, col - 1, 4], [row - 1, col, 8]]) {
        const neighbor = r * layout.cols + c
        if (r >= 0 && r < layout.rows && c >= 0 && c < layout.cols
          && this.activeCells[neighbor] && this.tierAt[neighbor] === this.tierAt[cell]) portals |= bit
      }
      this.connections[cell] = portals
    }
    // Initial water already stands above the lips, so all three waterfalls
    // have real head from the first frame, with that volume fully accounted.
    this.refreshDischarge()
  }

  private depths(): Triple {
    return this.volumes.map((volume, tier) => volume / this.areas[tier]) as Triple
  }

  private refreshDischarge(): void {
    const depths = this.depths()
    for (let tier = 0; tier < 3; tier++) {
      const sillHead = CASCADE_FLOORS[tier] + CASCADE_SILL_DEPTH
      const receivingHead = tier < 2 ? CASCADE_FLOORS[tier + 1] + depths[tier + 1] : sillHead
      const head = Math.max(0, CASCADE_FLOORS[tier] + depths[tier] - Math.max(sillHead, receivingHead))
      this.discharge[tier] = WEIR_FACTOR * CASCADE_SPILLS[tier].width * head ** 1.5
    }
  }

  setWallHeight(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return
    this.rimDepth = CASCADE_WALL_HEIGHT * Math.max(0.55, Math.min(1.75, multiplier))
    this.maximumDepth = this.rimDepth - 0.04
    // Lowering a wall into existing water physically displaces its excess.
    // Account for that spill explicitly; never silently delete stored water.
    for (let tier = 0; tier < 3; tier++) {
      const limit = this.areas[tier] * this.rimDepth
      if (this.volumes[tier] > limit) {
        this.escaped += this.volumes[tier] - limit
        this.volumes[tier] = limit
      }
    }
    this.refreshDischarge()
  }

  advance(seconds: number, inflow: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const requested = Number.isFinite(inflow) ? Math.max(0, Math.min(2.5, inflow)) : 0
    this.accumulator += Math.min(0.5, seconds)
    while (this.accumulator + 1e-10 >= STEP) {
      this.refreshDischarge()
      // Resolve downstream capacity first. Every accepted inter-basin
      // transfer is subtracted once upstream and added once downstream.
      for (let tier = 2; tier >= 0; tier--) {
        const available = Math.max(0, this.volumes[tier] - this.areas[tier] * CASCADE_SILL_DEPTH) / STEP
        const receiving = tier < 2
          ? Math.max(0, (this.areas[tier + 1] * this.maximumDepth - this.volumes[tier + 1]) / STEP + this.discharge[tier + 1])
          : Infinity
        this.discharge[tier] = Math.min(this.discharge[tier], available, receiving)
      }
      const room = Math.max(0, (this.areas[0] * this.maximumDepth - this.volumes[0]) / STEP + this.discharge[0])
      this.sourceRate = Math.min(SOURCE_FLOW * requested, room)
      const input = this.sourceRate * STEP, output = this.discharge[2] * STEP
      this.volumes[0] += input - this.discharge[0] * STEP
      this.volumes[1] += (this.discharge[0] - this.discharge[1]) * STEP
      this.volumes[2] += (this.discharge[1] - this.discharge[2]) * STEP
      // Compensated totals keep the global balance accurate during long runs.
      const addInput = input - this.injectedRemainder, nextInput = this.injected + addInput
      this.injectedRemainder = (nextInput - this.injected) - addInput
      this.injected = nextInput
      const addOutput = output - this.dischargedRemainder, nextOutput = this.discharged + addOutput
      this.dischargedRemainder = (nextOutput - this.discharged) - addOutput
      this.discharged = nextOutput
      this.time += STEP
      this.accumulator = Math.max(0, this.accumulator - STEP)
    }
  }

  reset(): void {
    for (let tier = 0; tier < 3; tier++) this.volumes[tier] = this.areas[tier] * CASCADE_INITIAL_DEPTH
    this.time = 0; this.accumulator = 0
    this.injected = 0; this.discharged = 0; this.escaped = 0
    this.injectedRemainder = 0; this.dischargedRemainder = 0
    this.sourceRate = 0
    this.refreshDischarge()
  }

  snapshot(): CascadeSnapshot {
    const depths = this.depths()
    const speeds = depths.map((depth, tier) => {
      const input = tier ? this.discharge[tier - 1] : this.sourceRate
      return (input + this.discharge[tier]) * 0.5 / Math.max(0.001, depth * Math.sqrt(this.areas[tier]))
    })
    this.depth.fill(0); this.velocity.fill(0)
    let wetCells = 0
    for (let cell = 0; cell < this.activeCells.length; cell++) {
      if (!this.activeCells[cell]) continue
      const tier = this.tierAt[cell]
      this.depth[cell] = depths[tier]
      this.velocity[cell * 2 + 1] = speeds[tier]
      if (depths[tier] > 0.002) wetCells++
    }
    const stored = this.volumes.reduce((sum, volume) => sum + volume, 0)
    return {
      rows: this.layout.rows, cols: this.layout.cols,
      depth: this.depth, velocity: this.velocity, connections: this.connections,
      sourceRate: this.sourceRate, initialStoredVolume: this.initialStoredVolume,
      cascade: { time: this.time, depths, sourceRate: this.sourceRate, discharge: [...this.discharge] },
      diagnostics: {
        time: this.time, count: 0, injected: this.injected, discharged: this.discharged,
        escaped: this.escaped, stored,
        massError: Math.abs(this.initialStoredVolume + this.injected - this.discharged - this.escaped - stored),
        maxVelocity: Math.max(...speeds), wetCells, reachedExit: this.discharge[2] > 1e-8 || this.discharged > 1e-8,
        outletRate: this.discharge[2], saturated: depths[0] >= this.maximumDepth - 0.002,
      },
    }
  }
}
