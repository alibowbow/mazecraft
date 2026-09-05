import type { FluidLayout, FluidSnapshot } from './types'

const FIXED_DT = 1 / 120
const GRAVITY = 12
const MAX_SPEED = 11

/** Position-based, weakly compressible 2D liquid with conservative particle accounting.
 * Each admitted particle keeps its area until it leaves the domain. This is a
 * visual free-surface solver, not a calibrated three-dimensional CFD model.
 */
export class FreeSurfaceSolver {
  private readonly x: Float64Array
  private readonly y: Float64Array
  private readonly oldX: Float64Array
  private readonly oldY: Float64Array
  private readonly vx: Float64Array
  private readonly vy: Float64Array
  private readonly crossed: Uint8Array
  private readonly next: Int32Array
  private readonly heads: Int32Array
  private readonly density: Float64Array
  private readonly nearDensity: Float64Array
  private readonly deltaX: Float64Array
  private readonly deltaY: Float64Array
  private readonly wallBuckets: number[][]
  private readonly hashCols: number
  private readonly hashRows: number
  private readonly wallCols: number
  private readonly wallRows: number
  private readonly kernel: number
  private count = 0
  private ticks = 0
  private accumulator = 0
  private emission = 0
  private admitted = 0
  private dischargedCount = 0
  private escapedCount = 0
  private fallingCount = 0
  private outletRate = 0
  private saturated = false
  private spawnSequence = 0

  constructor(readonly layout: FluidLayout) {
    const n = layout.capacity
    this.x = new Float64Array(n); this.y = new Float64Array(n)
    this.oldX = new Float64Array(n); this.oldY = new Float64Array(n)
    this.vx = new Float64Array(n); this.vy = new Float64Array(n)
    this.crossed = new Uint8Array(n); this.next = new Int32Array(n)
    this.density = new Float64Array(n); this.nearDensity = new Float64Array(n)
    this.deltaX = new Float64Array(n); this.deltaY = new Float64Array(n)
    this.kernel = layout.radius * 4.2
    this.hashCols = Math.ceil((layout.maxX - layout.minX) / this.kernel) + 2
    this.hashRows = Math.ceil((layout.maxY - layout.minY) / this.kernel) + 2
    this.heads = new Int32Array(this.hashCols * this.hashRows)
    this.wallCols = Math.ceil(layout.maxX - layout.minX) + 2
    this.wallRows = Math.ceil(layout.maxY - layout.minY) + 2
    this.wallBuckets = Array.from({ length: this.wallCols * this.wallRows }, () => [])
    layout.walls.forEach((wall, index) => {
      const minCol = Math.max(0, Math.floor(wall.x0 - layout.radius - layout.minX))
      const maxCol = Math.min(this.wallCols - 1, Math.floor(wall.x1 + layout.radius - layout.minX))
      const minRow = Math.max(0, Math.floor(wall.y0 - layout.radius - layout.minY))
      const maxRow = Math.min(this.wallRows - 1, Math.floor(wall.y1 + layout.radius - layout.minY))
      for (let row = minRow; row <= maxRow; row++) for (let col = minCol; col <= maxCol; col++) this.wallBuckets[row * this.wallCols + col].push(index)
    })
  }

  reset(): void {
    this.count = 0; this.ticks = 0; this.accumulator = 0; this.emission = 0
    this.admitted = 0; this.dischargedCount = 0; this.escapedCount = 0; this.fallingCount = 0
    this.outletRate = 0; this.saturated = false; this.spawnSequence = 0
    this.crossed.fill(0)
  }

  step(dt: number, inflow = 1): void {
    if (!Number.isFinite(dt) || dt <= 0) return
    const source = Number.isFinite(inflow) ? Math.min(3, Math.max(0, inflow)) : 0
    this.accumulator += dt
    // The worker submits bounded batches. Keeping the remainder preserves elapsed time.
    while (this.accumulator >= FIXED_DT - 1e-10) {
      this.substep(source)
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT)
    }
  }

  private rebuildHash(): void {
    this.heads.fill(-1)
    for (let i = 0; i < this.count; i++) {
      const col = Math.max(0, Math.min(this.hashCols - 1, Math.floor((this.x[i] - this.layout.minX) / this.kernel)))
      const row = Math.max(0, Math.min(this.hashRows - 1, Math.floor((this.y[i] - this.layout.minY) / this.kernel)))
      const key = row * this.hashCols + col
      this.next[i] = this.heads[key]; this.heads[key] = i
    }
  }

  private emit(inflow: number): void {
    this.saturated = false
    if (inflow <= 0) { this.emission = 0; return }
    const rate = Math.min(220, 80 + Math.sqrt(this.layout.activeCellCount) * 5) * inflow
    this.emission = Math.min(8, this.emission + rate * FIXED_DT)
    while (this.emission >= 1) {
      if (this.count >= this.layout.capacity) { this.saturated = true; this.emission = 0; break }
      // Six lanes across the reservoir give a continuous supply without co-located births.
      const lane = this.spawnSequence % 6
      const px = this.layout.inletX + (lane - 2.5) * this.layout.radius * 2.12
      const py = this.layout.inletY + ((Math.floor(this.spawnSequence / 6) % 2) * 0.006)
      let clear = true
      const clearance2 = (this.layout.radius * 1.9) ** 2
      // Only the small source neighbourhood matters, including births in this substep.
      for (let i = this.count - 1; i >= 0; i--) {
        const dx = this.x[i] - px, dy = this.y[i] - py
        if (Math.abs(dy) < this.layout.radius * 1.9 && dx * dx + dy * dy < clearance2) { clear = false; break }
      }
      this.spawnSequence++
      if (!clear) { this.saturated = true; this.emission = Math.min(this.emission, 1); break }
      const i = this.count++
      this.x[i] = px; this.y[i] = py; this.vx[i] = 0; this.vy[i] = 1.6
      this.crossed[i] = 0; this.admitted++; this.emission--
    }
  }

  /** Axis swept movement stops at the first inflated wall, then slides tangentially. */
  private move(i: number, targetX: number, targetY: number): void {
    let px = this.x[i], py = this.y[i]
    const radius = this.layout.radius
    const stepLimit = radius * 0.7
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(targetX - px), Math.abs(targetY - py)) / stepLimit))
    const dx = (targetX - px) / steps, dy = (targetY - py) / steps
    for (let s = 0; s < steps; s++) {
      let nx = px + dx
      const row = Math.floor(py - this.layout.minY)
      // Wall buckets already include the particle-radius margin. Query only buckets
      // intersected by this short sweep, rather than all nine neighbouring cells.
      const minCol = Math.floor(Math.min(px, nx) - this.layout.minX)
      const maxCol = Math.floor(Math.max(px, nx) - this.layout.minX)
      if (row >= 0 && row < this.wallRows) {
        for (let cx = Math.max(0, minCol); cx <= Math.min(this.wallCols - 1, maxCol); cx++) {
          for (const index of this.wallBuckets[row * this.wallCols + cx]) {
            const wall = this.layout.walls[index]
            const x0 = wall.x0 - radius, x1 = wall.x1 + radius
            if (py <= wall.y0 - radius || py >= wall.y1 + radius) continue
            if (dx > 0 && px <= x0 && nx > x0) nx = Math.min(nx, x0)
            if (dx < 0 && px >= x1 && nx < x1) nx = Math.max(nx, x1)
          }
        }
      }
      px = nx
      let ny = py + dy
      const nextCol = Math.floor(px - this.layout.minX)
      const minRow = Math.floor(Math.min(py, ny) - this.layout.minY)
      const maxRow = Math.floor(Math.max(py, ny) - this.layout.minY)
      if (nextCol >= 0 && nextCol < this.wallCols) {
        for (let cy = Math.max(0, minRow); cy <= Math.min(this.wallRows - 1, maxRow); cy++) {
          for (const index of this.wallBuckets[cy * this.wallCols + nextCol]) {
            const wall = this.layout.walls[index]
            const y0 = wall.y0 - radius, y1 = wall.y1 + radius
            if (px <= wall.x0 - radius || px >= wall.x1 + radius) continue
            if (dy > 0 && py <= y0 && ny > y0) ny = Math.min(ny, y0)
            if (dy < 0 && py >= y1 && ny < y1) ny = Math.max(ny, y1)
          }
        }
      }
      py = ny
    }
    this.x[i] = px; this.y[i] = py
  }

  private substep(inflow: number): void {
    this.emit(inflow)
    const n = this.count, h = this.kernel, h2 = h * h
    for (let i = 0; i < n; i++) {
      this.oldX[i] = this.x[i]; this.oldY[i] = this.y[i]
      this.vy[i] += GRAVITY * FIXED_DT
      const speed = Math.hypot(this.vx[i], this.vy[i])
      const factor = speed > MAX_SPEED ? MAX_SPEED / speed : 1
      this.vx[i] *= factor; this.vy[i] *= factor
      this.move(i, this.x[i] + this.vx[i] * FIXED_DT, this.y[i] + this.vy[i] * FIXED_DT)
    }
    for (let iteration = 0; iteration < 3; iteration++) {
      this.rebuildHash()
      this.density.fill(0, 0, n); this.nearDensity.fill(0, 0, n)
      this.deltaX.fill(0, 0, n); this.deltaY.fill(0, 0, n)
      this.forEachPair((i, j, dx, dy, d2) => {
        if (d2 >= h2) return
        const q = 1 - Math.sqrt(d2) / h, q2 = q * q
        this.density[i] += q2; this.density[j] += q2
        this.nearDensity[i] += q2 * q; this.nearDensity[j] += q2 * q
      })
      this.forEachPair((i, j, dx, dy, d2) => {
        if (d2 >= h2) return
        let distance = Math.sqrt(d2)
        if (distance < 1e-7) { dx = 1e-6; dy = 0; distance = 1e-6 }
        const q = 1 - distance / h
        const pressure = Math.max(-0.001, (this.density[i] + this.density[j] - 5.2) * 0.016)
        const nearPressure = (this.nearDensity[i] + this.nearDensity[j]) * 0.006
        const separation = Math.max(0, this.layout.radius * 1.8 - distance) * 0.24
        const correction = Math.min(0.018, (pressure * q + nearPressure * q * q) * 0.5 + separation)
        const cx = dx / distance * correction, cy = dy / distance * correction
        this.deltaX[i] -= cx; this.deltaY[i] -= cy
        this.deltaX[j] += cx; this.deltaY[j] += cy
      })
      for (let i = 0; i < n; i++) {
        const length = Math.hypot(this.deltaX[i], this.deltaY[i])
        const scale = length > 0.035 ? 0.035 / length : 1
        this.move(i, this.x[i] + this.deltaX[i] * scale, this.y[i] + this.deltaY[i] * scale)
      }
    }
    for (let i = 0; i < n; i++) {
      this.vx[i] = (this.x[i] - this.oldX[i]) / FIXED_DT
      this.vy[i] = (this.y[i] - this.oldY[i]) / FIXED_DT
    }
    // XSPH damping exchanges momentum symmetrically; falling jets retain acceleration.
    this.rebuildHash()
    this.deltaX.fill(0, 0, n); this.deltaY.fill(0, 0, n)
    this.forEachPair((i, j, dx, dy, d2) => {
      if (d2 >= h2) return
      const q = 1 - Math.sqrt(d2) / h
      const amount = q * 0.035
      const cx = (this.vx[j] - this.vx[i]) * amount, cy = (this.vy[j] - this.vy[i]) * amount
      this.deltaX[i] += cx; this.deltaY[i] += cy
      this.deltaX[j] -= cx; this.deltaY[j] -= cy
    })
    let newlyDischarged = 0
    for (let i = 0; i < this.count; i++) {
      this.vx[i] += this.deltaX[i]; this.vy[i] += this.deltaY[i]
      const speed = Math.hypot(this.vx[i], this.vy[i])
      if (speed > MAX_SPEED) { this.vx[i] *= MAX_SPEED / speed; this.vy[i] *= MAX_SPEED / speed }
      if (!this.crossed[i] && this.oldY[i] <= this.layout.outletY && this.y[i] > this.layout.outletY && Math.abs(this.x[i] - this.layout.outletX) <= 0.4) {
        this.crossed[i] = 1; this.dischargedCount++; this.fallingCount++; newlyDischarged++
      }
      if (this.y[i] > this.layout.maxY || this.y[i] < this.layout.minY || this.x[i] < this.layout.minX || this.x[i] > this.layout.maxX || !Number.isFinite(this.x[i] + this.y[i])) {
        if (this.crossed[i]) this.fallingCount--
        else this.escapedCount++
        this.remove(i); i--
      }
    }
    this.outletRate += (newlyDischarged * this.layout.particleArea / FIXED_DT - this.outletRate) * 0.04
    this.ticks++
  }

  private forEachPair(visit: (i: number, j: number, dx: number, dy: number, distanceSquared: number) => void): void {
    const h = this.kernel
    for (let i = 0; i < this.count; i++) {
      const col = Math.floor((this.x[i] - this.layout.minX) / h)
      const row = Math.floor((this.y[i] - this.layout.minY) / h)
      for (let cy = Math.max(0, row - 1); cy <= Math.min(this.hashRows - 1, row + 1); cy++) {
        for (let cx = Math.max(0, col - 1); cx <= Math.min(this.hashCols - 1, col + 1); cx++) {
          for (let j = this.heads[cy * this.hashCols + cx]; j >= 0; j = this.next[j]) {
            if (j <= i) continue
            const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i]
            visit(i, j, dx, dy, dx * dx + dy * dy)
          }
        }
      }
    }
  }

  private remove(i: number): void {
    const last = --this.count
    if (last === i) return
    this.x[i] = this.x[last]; this.y[i] = this.y[last]
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]
    this.crossed[i] = this.crossed[last]
    this.oldX[i] = this.oldX[last]; this.oldY[i] = this.oldY[last]
    this.deltaX[i] = this.deltaX[last]; this.deltaY[i] = this.deltaY[last]
  }

  snapshot(): FluidSnapshot {
    const positions = new Float32Array(this.count * 2), velocities = new Float32Array(this.count * 2)
    const wet = new Uint8Array(this.layout.activeCells.length)
    let maxVelocity = 0, wetCells = 0
    for (let i = 0; i < this.count; i++) {
      positions[i * 2] = this.x[i]; positions[i * 2 + 1] = this.y[i]
      velocities[i * 2] = this.vx[i]; velocities[i * 2 + 1] = this.vy[i]
      maxVelocity = Math.max(maxVelocity, Math.hypot(this.vx[i], this.vy[i]))
      const col = Math.floor(this.x[i]), row = Math.floor(this.y[i])
      const cell = row * this.layout.cols + col
      if (col >= 0 && col < this.layout.cols && row >= 0 && row < this.layout.rows && this.layout.activeCells[cell] && !wet[cell]) { wet[cell] = 1; wetCells++ }
    }
    const storedCount = this.count - this.fallingCount
    const particleBalance = this.admitted - this.dischargedCount - this.escapedCount - storedCount
    const area = this.layout.particleArea
    return {
      positions, velocities, count: this.count,
      diagnostics: {
        time: this.ticks * FIXED_DT, count: this.count,
        injected: this.admitted * area, discharged: this.dischargedCount * area,
        escaped: this.escapedCount * area, stored: storedCount * area,
        massError: particleBalance * area, maxVelocity, wetCells,
        reachedExit: this.dischargedCount > 0, outletRate: this.outletRate, saturated: this.saturated,
      },
    }
  }
}
