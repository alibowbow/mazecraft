/**
 * Depth-averaged shallow-water flow on a staggered grid (water depth at cell
 * centres, velocities on faces), after Stelling & Duinmeijer. Each basin of
 * a garden has its own grid; walls are solid cells and weirs are one-cell
 * crests, so flow over steps, spreading fronts and currents all come out of
 * the equations. The update is exactly mass-conserving: every face flux is
 * taken from one cell and given to its neighbour in the same step.
 */

export const G = 9.81
export const RHO = 1000
/** Manning roughness of glazed ceramic (s·m^-1/3). */
export const MANNING = 0.011
/** Below this depth a cell is dry and passes no water (m). */
export const DRY = 2e-4
/**
 * Free overfall: once the water beyond a brink falls away, the flow over it
 * is critical and carries Q/w = C·H^1.5 for a head H above the brink
 * (C = √g·(2/3)^1.5 ≈ 1.705, the broad-crested weir).
 */
export const OVERFALL = Math.sqrt(G) * Math.pow(2 / 3, 1.5)
/** Critical velocity as a share of √(g·H) at a free brink, for the head H upstream. */
const BRINK_FROUDE = Math.pow(2 / 3, 1.5)
/** Supercritical sheets on the beds stay below this Froude number. */
const MAX_FROUDE = 2.5

export interface GridSpec {
  x0: number
  y0: number
  dx: number
  nx: number
  ny: number
}

export class ShallowWaterGrid {
  readonly x0: number
  readonly y0: number
  readonly dx: number
  readonly nx: number
  readonly ny: number
  readonly count: number
  /** Bed elevation (absolute z) per cell. */
  readonly bed: Float32Array
  readonly solid: Uint8Array
  /** Water depth per cell (m). */
  readonly h: Float64Array
  /** Velocity on x faces, (nx + 1) × ny, face i sits between cells i - 1 and i. */
  readonly u: Float32Array
  /** Velocity on y faces, nx × (ny + 1). */
  readonly v: Float32Array
  private readonly fx: Float64Array
  private readonly fy: Float64Array
  private readonly out: Float64Array
  private readonly scale: Float64Array

  constructor(spec: GridSpec) {
    this.x0 = spec.x0; this.y0 = spec.y0; this.dx = spec.dx; this.nx = spec.nx; this.ny = spec.ny
    this.count = spec.nx * spec.ny
    this.bed = new Float32Array(this.count)
    this.solid = new Uint8Array(this.count).fill(1)
    this.h = new Float64Array(this.count)
    this.u = new Float32Array((spec.nx + 1) * spec.ny)
    this.v = new Float32Array(spec.nx * (spec.ny + 1))
    this.fx = new Float64Array(this.u.length)
    this.fy = new Float64Array(this.v.length)
    this.out = new Float64Array(this.count)
    this.scale = new Float64Array(this.count)
  }

  cellAt(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.dx), j = Math.floor((y - this.y0) / this.dx)
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i
  }

  centre(cell: number): [number, number] {
    return [this.x0 + (cell % this.nx + 0.5) * this.dx, this.y0 + (Math.floor(cell / this.nx) + 0.5) * this.dx]
  }

  volume(): number {
    let sum = 0
    for (let c = 0; c < this.count; c++) sum += this.h[c]
    return sum * this.dx * this.dx
  }

  /** Largest gravity-wave plus flow speed, for the time step. */
  maxSpeed(): number {
    let speed = 0
    for (let c = 0; c < this.count; c++) if (this.h[c] > DRY) speed = Math.max(speed, Math.sqrt(G * this.h[c]))
    for (let f = 0; f < this.u.length; f++) speed = Math.max(speed, Math.abs(this.u[f]))
    for (let f = 0; f < this.v.length; f++) speed = Math.max(speed, Math.abs(this.v[f]))
    return speed
  }

  /**
   * One explicit step: momentum from the surface slope (with hydrostatic
   * reconstruction at steps, so a lower dry bed never pulls water through a
   * wall), Manning friction, critical flow over free brinks, then fluxes
   * limited so that no cell gives away more water than it holds.
   */
  step(dt: number): void {
    const { nx, ny, dx, bed, solid, h, u, v, fx, fy, out, scale } = this
    const friction = dt * G * MANNING * MANNING
    const maxVelocity = 0.45 * dx / dt
    for (let j = 0; j < ny; j++) {
      const row = j * nx, faceRow = j * (nx + 1)
      fx[faceRow] = 0; u[faceRow] = 0; fx[faceRow + nx] = 0; u[faceRow + nx] = 0
      for (let i = 1; i < nx; i++) {
        const f = faceRow + i, L = row + i - 1, R = L + 1
        fx[f] = 0
        if (solid[L] || solid[R]) { u[f] = 0; continue }
        const velocity = this.face(u[f], bed[L], h[L], bed[R], h[R], dt, friction, maxVelocity)
        u[f] = velocity
        if (velocity !== 0) fx[f] = velocity * this.faceDepth * dx
      }
    }
    for (let j = 0; j <= ny; j++) {
      const faceRow = j * nx
      for (let i = 0; i < nx; i++) {
        const f = faceRow + i
        fy[f] = 0
        if (j === 0 || j === ny) { v[f] = 0; continue }
        const B = (j - 1) * nx + i, T = B + nx
        if (solid[B] || solid[T]) { v[f] = 0; continue }
        const velocity = this.face(v[f], bed[B], h[B], bed[T], h[T], dt, friction, maxVelocity)
        v[f] = velocity
        if (velocity !== 0) fy[f] = velocity * this.faceDepth * dx
      }
    }
    // Donor-cell limiting: scale every outflow of a cell that would run dry.
    out.fill(0)
    for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) {
      const f = j * (nx + 1) + i, q = fx[f]
      if (q > 0) out[j * nx + i - 1] += q; else if (q < 0) out[j * nx + i] -= q
    }
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const f = j * nx + i, q = fy[f]
      if (q > 0) out[f - nx] += q; else if (q < 0) out[f] -= q
    }
    const area = dx * dx
    for (let c = 0; c < this.count; c++) {
      const leaving = out[c] * dt
      scale[c] = leaving > h[c] * area ? h[c] * area / leaving : 1
    }
    for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) {
      const f = j * (nx + 1) + i, q = fx[f]
      if (q === 0) continue
      const k = scale[q > 0 ? j * nx + i - 1 : j * nx + i]
      if (k < 1) { fx[f] = q * k; u[f] *= k }
    }
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const f = j * nx + i, q = fy[f]
      if (q === 0) continue
      const k = scale[q > 0 ? f - nx : f]
      if (k < 1) { fy[f] = q * k; v[f] *= k }
    }
    const rate = dt / area
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      if (solid[c]) continue
      const fl = j * (nx + 1) + i
      const net = fx[fl] - fx[fl + 1] + fy[c] - fy[c + nx]
      if (net !== 0) {
        const next = h[c] + net * rate
        h[c] = next > 0 ? next : 0
      }
    }
  }

  /** Upwind depth of the face last passed to `face`. */
  private faceDepth = 0

  private face(previous: number, bedA: number, hA: number, bedB: number, hB: number, dt: number, friction: number, maxVelocity: number): number {
    const brink = bedA > bedB ? bedA : bedB
    const etaA = bedA + hA, etaB = bedB + hB
    if (etaA - brink <= DRY && etaB - brink <= DRY) return 0
    const sA = etaA > brink ? etaA : brink, sB = etaB > brink ? etaB : brink
    let velocity = previous - G * dt * (sB - sA) / this.dx
    const depth = velocity >= 0 ? sA - brink : sB - brink
    if (depth <= DRY) return 0
    velocity /= 1 + friction * Math.abs(velocity) / (depth * Math.cbrt(depth))
    // Water falling away beyond the brink: the flow over it is critical.
    const downstream = velocity >= 0 ? etaB : etaA
    const limit = Math.min(maxVelocity, (downstream <= brink + DRY ? BRINK_FROUDE : MAX_FROUDE) * Math.sqrt(G * depth))
    if (velocity > limit) velocity = limit; else if (velocity < -limit) velocity = -limit
    this.faceDepth = depth
    return velocity
  }

  /**
   * Add water that falls onto the grid near (x, y), spread over the wet-able
   * cells within `radius`, carrying its horizontal velocity into the faces
   * around it. Returns the volume that found no cell (it missed the basin).
   */
  deposit(x: number, y: number, volume: number, vx: number, vy: number, radius = 0.14): number {
    if (volume <= 0) return 0
    const { dx, nx, ny, solid, h, u, v } = this
    const ci = Math.floor((x - this.x0) / dx), cj = Math.floor((y - this.y0) / dx)
    const reach = Math.max(1, Math.ceil(radius / dx))
    let total = 0
    const cells: number[] = [], weights: number[] = []
    for (let search = reach; search <= reach + 5 && !cells.length; search += 2) {
      for (let j = cj - search; j <= cj + search; j++) for (let i = ci - search; i <= ci + search; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue
        const c = j * nx + i
        if (solid[c]) continue
        const px = this.x0 + (i + 0.5) * dx - x, py = this.y0 + (j + 0.5) * dx - y
        const w = Math.exp(-(px * px + py * py) / (radius * radius))
        if (w < 1e-3 && search === reach) continue
        cells.push(c); weights.push(w + 1e-6); total += w + 1e-6
      }
    }
    if (!cells.length) return volume
    const area = dx * dx
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], added = volume * weights[k] / total / area
      const share = added / (h[c] + added)
      h[c] += added
      // The falling water's momentum mixes into the four faces of the cell.
      const i = c % nx, j = (c - i) / nx
      const fl = j * (nx + 1) + i
      if (!solid[c]) {
        if (i > 0 && !solid[c - 1]) u[fl] += (vx - u[fl]) * share * 0.5
        if (i < nx - 1 && !solid[c + 1]) u[fl + 1] += (vx - u[fl + 1]) * share * 0.5
        if (j > 0 && !solid[c - nx]) v[c] += (vy - v[c]) * share * 0.5
        if (j < ny - 1 && !solid[c + nx]) v[c + nx] += (vy - v[c + nx]) * share * 0.5
      }
    }
    return 0
  }

  /** Take up to `volume` from the given cells in proportion to their depth. Returns what was taken. */
  withdraw(cells: Int32Array, volume: number): number {
    if (volume <= 0 || !cells.length) return 0
    const { h } = this, area = this.dx * this.dx
    let available = 0
    for (let k = 0; k < cells.length; k++) available += h[cells[k]]
    available *= area
    if (available <= 1e-12) return 0
    const taken = Math.min(volume, available * 0.95)
    const keep = 1 - taken / available
    for (let k = 0; k < cells.length; k++) h[cells[k]] *= keep
    return taken
  }

  /** Mean water surface over the wet cells of a set, or NaN if all dry. */
  surface(cells: Int32Array): number {
    let sum = 0, wet = 0
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      if (this.h[c] > DRY * 5) { sum += this.bed[c] + this.h[c]; wet++ }
    }
    return wet ? sum / wet : NaN
  }

  /** Cell-centred velocity at a cell. */
  velocity(cell: number): [number, number] {
    const { nx } = this
    const i = cell % nx, j = (cell - i) / nx
    const fl = j * (nx + 1) + i
    return [(this.u[fl] + this.u[fl + 1]) / 2, (this.v[cell] + this.v[cell + nx]) / 2]
  }

  /**
   * Nudge the face velocities around a set of cells towards `speed` along
   * (dx, dy) by momentum `impulse` (kg·m/s), e.g. the drag of wheel paddles.
   */
  push(cells: Int32Array, dirX: number, dirY: number, impulse: number): void {
    const { nx, h, u, v, solid } = this, area = this.dx * this.dx
    let mass = 0
    for (let k = 0; k < cells.length; k++) mass += h[cells[k]] * area * RHO
    if (mass <= 1e-6) return
    const dvel = impulse / mass
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      if (solid[c] || h[c] <= DRY) continue
      const i = c % nx, j = (c - i) / nx, fl = j * (nx + 1) + i
      u[fl] += dirX * dvel * 0.5; u[fl + 1] += dirX * dvel * 0.5
      v[c] += dirY * dvel * 0.5; v[c + nx] += dirY * dvel * 0.5
    }
  }

  reset(): void {
    this.h.fill(0); this.u.fill(0); this.v.fill(0)
  }
}
