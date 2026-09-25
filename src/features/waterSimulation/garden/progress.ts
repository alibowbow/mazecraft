import type { GardenLayout } from './layout'
import type { GardenState } from './simulation'
import { TIPPER_REST } from './mechanics'

/** What the water has achieved so far in a run, read from the physics. */
export interface GardenProgress {
  /** Simulated time (s) when water first reached the course's last pond, or null. */
  arrival: number | null
  /** Shishi-odoshi knocks (tipped and struck back on its stop). */
  knocks: number
  /** Times a siphon caught and emptied its basin. */
  surges: number
  /** Share of the course's pools that hold water (0–1). */
  wetShare: number
}

/**
 * Follows a garden run and counts what the challenges ask for. The last
 * pond is the receiving basin a crafted course ends in (or, for authored
 * gardens, the last pool).
 */
export class GardenProgressTracker {
  private readonly finalPool: number
  private readonly tipped: boolean[]
  private readonly primed: boolean[]
  private progress: GardenProgress = { arrival: null, knocks: 0, surges: 0, wetShare: 0 }

  constructor(private readonly layout: GardenLayout) {
    const receiving = layout.pools.findIndex(pool => layout.vessels[pool.vessel].spec.name === 'receiving-basin')
    this.finalPool = receiving >= 0 ? receiving : layout.pools.length - 1
    this.tipped = layout.tippers.map(() => false)
    this.primed = layout.siphons.map(() => false)
  }

  get current(): GardenProgress { return this.progress }

  reset(): void {
    this.tipped.fill(false); this.primed.fill(false)
    this.progress = { arrival: null, knocks: 0, surges: 0, wetShare: 0 }
  }

  update(state: GardenState): GardenProgress {
    if (state.time < 1e-6) this.reset()
    let { arrival, knocks, surges } = this.progress
    state.tipperAngles.forEach((angle, i) => {
      if (angle < 0) this.tipped[i] = true
      else if (this.tipped[i] && angle > TIPPER_REST - 0.04) { this.tipped[i] = false; knocks++ }
    })
    state.siphonPrimed.forEach((primed, i) => {
      if (primed > 0.5 && !this.primed[i]) surges++
      this.primed[i] = primed > 0.5
    })
    if (arrival === null && (state.fronts[this.finalPool] ?? -1) >= 0) arrival = state.time
    let wet = 0
    state.fronts.forEach(front => { if (front >= 0) wet++ })
    this.progress = { arrival, knocks, surges, wetShare: state.fronts.length ? wet / state.fronts.length : 0 }
    return this.progress
  }
}
