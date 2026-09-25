import { DRY, G, MANNING, OVERFALL } from './shallowWater'

type Point = readonly [number, number, number]

/**
 * One-dimensional open-channel flow (Saint-Venant, staggered) along the bed
 * of a chute or trough: gravity down the bed slope, Manning friction, and a
 * free overfall at the open end. Water enters at any point along it and
 * leaves over the end as a jet.
 */
export class OpenChannel {
  readonly n: number
  readonly ds: number
  readonly width: number
  /** Bed elevation and plan position of each cell centre. */
  readonly bed: Float64Array
  readonly px: Float64Array
  readonly py: Float64Array
  /** Arc length of each cell centre from the intake. */
  readonly along: Float64Array
  readonly length: number
  readonly h: Float64Array
  /** Face velocities, n + 1 (face k sits upstream of cell k). */
  readonly u: Float64Array
  private readonly flux: Float64Array
  /** Direction of the last reach, for the jet. */
  readonly exit: [number, number]
  /** Volume and speed that left over the end in the last step. */
  outflow = 0
  exitSpeed = 0

  constructor(path: readonly Point[], width: number, spacing = 0.1) {
    const lengths = [0]
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]))
    this.length = lengths[lengths.length - 1]
    this.n = Math.max(3, Math.round(this.length / spacing))
    this.ds = this.length / this.n
    this.width = width
    this.bed = new Float64Array(this.n); this.px = new Float64Array(this.n); this.py = new Float64Array(this.n); this.along = new Float64Array(this.n)
    let segment = 1
    for (let k = 0; k < this.n; k++) {
      const s = (k + 0.5) * this.ds
      while (segment < path.length - 1 && lengths[segment] < s) segment++
      const a = path[segment - 1], b = path[segment], span = lengths[segment] - lengths[segment - 1] || 1
      const t = Math.min(1, Math.max(0, (s - lengths[segment - 1]) / span))
      this.px[k] = a[0] + (b[0] - a[0]) * t
      this.py[k] = a[1] + (b[1] - a[1]) * t
      this.bed[k] = a[2] + (b[2] - a[2]) * t
      this.along[k] = s
    }
    const last = path[path.length - 1], before = path[path.length - 2]
    const l = Math.hypot(last[0] - before[0], last[1] - before[1]) || 1
    this.exit = [(last[0] - before[0]) / l, (last[1] - before[1]) / l]
    this.h = new Float64Array(this.n)
    this.u = new Float64Array(this.n + 1)
    this.flux = new Float64Array(this.n + 1)
  }

  volume(): number {
    let sum = 0
    for (let k = 0; k < this.n; k++) sum += this.h[k]
    return sum * this.ds * this.width
  }

  /** Cell nearest a plan point (for pours into a trough). */
  cellNear(x: number, y: number): number {
    let best = 0, distance = Infinity
    for (let k = 0; k < this.n; k++) {
      const d = (this.px[k] - x) ** 2 + (this.py[k] - y) ** 2
      if (d < distance) { distance = d; best = k }
    }
    return best
  }

  add(cell: number, volume: number): void {
    if (volume > 0) this.h[cell] += volume / (this.ds * this.width)
  }

  /** Discharge (m³/s) through cell k's upstream face. */
  discharge(k: number): number {
    return this.flux[Math.min(this.n, Math.max(0, k))]
  }

  step(dt: number): void {
    const { n, ds, width, bed, h, u, flux } = this
    const friction = dt * G * MANNING * MANNING
    const maxVelocity = 0.45 * ds / dt
    flux[0] = 0; u[0] = 0
    for (let k = 1; k < n; k++) {
      const a = k - 1, b = k
      const brink = Math.max(bed[a], bed[b])
      const etaA = bed[a] + h[a], etaB = bed[b] + h[b]
      flux[k] = 0
      if (etaA - brink <= DRY && etaB - brink <= DRY) { u[k] = 0; continue }
      const sA = Math.max(etaA, brink), sB = Math.max(etaB, brink)
      let velocity = u[k] - G * dt * (sB - sA) / ds
      const depth = velocity >= 0 ? sA - brink : sB - brink
      if (depth <= DRY) { u[k] = 0; continue }
      velocity /= 1 + friction * Math.abs(velocity) / (depth * Math.cbrt(depth))
      const limit = Math.min(maxVelocity, 6 * Math.sqrt(G * depth))
      if (velocity > limit) velocity = limit; else if (velocity < -limit) velocity = -limit
      u[k] = velocity
      flux[k] = velocity * depth * width
    }
    // Free overfall at the open end: critical flow over the last cell's lip.
    const head = h[n - 1]
    const endVelocity = Math.max(u[n - 1], 0)
    let endFlux = head > DRY ? Math.max(OVERFALL * width * Math.pow(head, 1.5), endVelocity * head * width) : 0
    flux[n] = endFlux
    // Donor limiting keeps every cell's depth non-negative.
    for (let k = 0; k < n; k++) {
      const leaving = (Math.max(flux[k + 1], 0) + Math.max(-flux[k], 0)) * dt
      const held = h[k] * ds * width
      if (leaving > held && leaving > 0) {
        const s = held / leaving
        if (flux[k + 1] > 0) { flux[k + 1] *= s; if (k + 1 < n) u[k + 1] *= s }
        if (flux[k] < 0) { flux[k] *= s; u[k] *= s }
      }
    }
    endFlux = flux[n]
    const rate = dt / (ds * width)
    for (let k = 0; k < n; k++) {
      const next = h[k] + (flux[k] - flux[k + 1]) * rate
      h[k] = next > 0 ? next : 0
    }
    this.outflow = endFlux * dt
    this.exitSpeed = head > DRY ? endFlux / (head * width) : 0
  }

  reset(): void {
    this.h.fill(0); this.u.fill(0); this.flux.fill(0); this.outflow = 0; this.exitSpeed = 0
  }
}
