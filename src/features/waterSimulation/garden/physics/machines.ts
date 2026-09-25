import { G, RHO } from './shallowWater'

const TAU = Math.PI * 2
const wrap = (angle: number) => ((angle % TAU) + TAU) % TAU

/**
 * An overshot bucket wheel under a spout. Angles: ψ grows in the driven
 * direction; bucket k sits at φ = ψ + 2πk/n, measured from the top towards
 * the downstream side. The jet fills the bucket passing under it and pushes
 * on it (impulse ρ·Q·(v − ω·r)); every bucket's water pulls on the rim with
 * its weight (m·g·r·sin φ) until the bucket turns over and empties.
 * I·ω' = τ_jet + τ_weight − c·ω − τ_bearing.
 */
export class BucketWheel {
  angle = 0
  speed = 0
  readonly buckets: Float64Array
  readonly capacity: number
  private readonly inertia: number
  /** Water spilled from each bucket in the last step, at its angle. */
  readonly spilled: Float64Array

  constructor(readonly radius: number, readonly width: number, readonly count: number) {
    this.buckets = new Float64Array(count)
    this.spilled = new Float64Array(count)
    // Buckets fill the outer half of the rim, about half full at most.
    this.capacity = 0.5 * Math.PI * radius * radius * 0.75 * width / count
    const mass = 30 * radius * width + 2
    this.inertia = 0.7 * mass * radius * radius
  }

  bucketAngle(k: number): number { return wrap(this.angle + TAU * k / this.count) }

  /** What a bucket can hold at φ: full on the descending side, empty once it turns over. */
  holds(phi: number): number {
    if (phi <= Math.PI * 0.55) return this.capacity
    if (phi < Math.PI * 0.95) return this.capacity * (Math.PI * 0.95 - phi) / (Math.PI * 0.4)
    if (phi > TAU - 0.35) return this.capacity * (phi - (TAU - 0.35)) / 0.35
    return 0
  }

  /**
   * Advance by dt with `volume` of jet water arriving at rim angle `impact`
   * with tangential speed `jetSpeed`. Returns the volume that could not be
   * caught (it falls through).
   */
  step(dt: number, volume: number, impact: number, jetSpeed: number): number {
    this.spilled.fill(0)
    let missed = 0
    if (volume > 0) {
      let best = 0, gap = Infinity
      for (let k = 0; k < this.count; k++) {
        const d = Math.abs(((this.bucketAngle(k) - impact + Math.PI * 3) % TAU) - Math.PI)
        if (d < gap) { gap = d; best = k }
      }
      const room = Math.max(0, this.holds(this.bucketAngle(best)) - this.buckets[best])
      const caught = Math.min(volume, room)
      this.buckets[best] += caught
      missed = volume - caught
    }
    const r = this.radius
    let torque = 0, water = 0
    for (let k = 0; k < this.count; k++) {
      const phi = this.bucketAngle(k)
      const excess = this.buckets[k] - this.holds(phi)
      if (excess > 0) { this.buckets[k] -= excess; this.spilled[k] += excess }
      const mass = RHO * this.buckets[k]
      torque += mass * G * r * Math.sin(phi)
      water += mass
    }
    // Impulse of the jet on the bucket it strikes.
    if (volume > 0 && dt > 0) torque += RHO * (volume - missed) / dt * (jetSpeed - this.speed * r) * r
    const inertia = this.inertia + water * r * r
    torque -= 3 * this.inertia * this.speed + Math.sign(this.speed) * 1
    this.speed += torque / inertia * dt
    if (Math.abs(this.speed) < 0.02 && Math.abs(torque) < 0.4) this.speed = 0
    this.angle = wrap(this.angle + this.speed * dt)
    return missed
  }

  held(): number { let sum = 0; for (const v of this.buckets) sum += v; return sum }

  reset(): void { this.angle = 0; this.speed = 0; this.buckets.fill(0); this.spilled.fill(0) }
}

/**
 * An undershot paddle wheel over a weir: the paddles dip into the sheet
 * running over the crest and are dragged along by it,
 * F = ½·ρ·C_d·A·(v − ω·r)·|v − ω·r|. The same force slows the water.
 */
export class PaddleWheel {
  angle = 0
  speed = 0
  private readonly inertia: number

  constructor(readonly radius: number, readonly width: number) {
    const mass = 25 * radius * width + 1.5
    this.inertia = 0.6 * mass * radius * radius
  }

  /** Returns the force on the water along the flow (N, negative: it slows the flow). */
  step(dt: number, flowSpeed: number, depth: number): number {
    const dip = Math.max(0, Math.min(depth, this.radius * 0.5))
    const lever = this.radius - dip / 2
    const relative = flowSpeed - this.speed * lever
    const force = 0.5 * RHO * 1.8 * this.width * dip * relative * Math.abs(relative)
    let torque = force * lever - 0.3 * this.inertia * this.speed - Math.sign(this.speed) * 0.15
    if (Math.abs(this.speed) < 0.02 && Math.abs(force * lever) < 0.15) { torque = 0; this.speed = 0 }
    this.speed += torque / this.inertia * dt
    this.angle = wrap(this.angle + this.speed * dt)
    return -force
  }

  reset(): void { this.angle = 0; this.speed = 0 }
}

/** DC gear motor: torque falls linearly from stall to zero at its free speed. */
export interface Motor { stall: number; free: number }

/**
 * A noria: pots on a great wheel, turned by a gear motor. A pot scoops as
 * it passes through the sump (it fills as deep as it is submerged), rides
 * up full, and spills into the trough as it turns over the top. Its weight
 * on the rising side is the load the motor works against:
 * I·ω' = τ_motor(ω) − Σ m·g·r·sin φ − c·ω, with φ = 0 at the bottom and
 * growing up the rising side.
 */
export class NoriaWheel {
  angle = 0
  speed = 0
  readonly pots: Float64Array
  readonly motor: Motor
  private readonly inertia: number
  /** Scooped and poured volumes of the last step. */
  scooped = 0
  poured = 0

  constructor(
    readonly radius: number,
    /** Pot centre radius, depth (radial) and capacity. */
    readonly potRadius: number, readonly potDepth: number, readonly capacity: number,
    readonly count: number, readonly spill: number, rimSpeed: number,
  ) {
    this.pots = new Float64Array(count)
    const load = RHO * capacity * G * potRadius * count / Math.PI
    this.motor = { stall: 2.2 * load, free: 1.8 * rimSpeed / radius }
    this.inertia = 140 * radius * radius
  }

  potAngle(k: number): number { return wrap(this.angle + TAU * k / this.count) }

  holds(phi: number): number {
    if (phi < Math.PI - this.spill) return this.capacity
    if (phi < Math.PI + this.spill) return this.capacity * (Math.PI + this.spill - phi) / (2 * this.spill)
    return 0
  }

  /** How much each submerged pot wants to scoop this step, given the sump level. */
  demand(dt: number, hub: number, level: number, out: Float64Array): number {
    let total = 0
    for (let k = 0; k < this.count; k++) {
      out[k] = 0
      const phi = this.potAngle(k)
      const near = phi < 0.5 || phi > TAU - 0.5
      if (!near) continue
      const bottom = hub - (this.potRadius + this.potDepth / 2) * Math.cos(phi)
      const target = this.capacity * Math.max(0, Math.min(1, (level - bottom) / this.potDepth))
      if (target > this.pots[k]) { out[k] = (target - this.pots[k]) * (1 - Math.exp(-10 * dt)); total += out[k] }
    }
    return total
  }

  step(dt: number, scoops: Float64Array, share: number): void {
    this.scooped = 0; this.poured = 0
    let torque = 0, water = 0
    for (let k = 0; k < this.count; k++) {
      const got = scoops[k] * share
      this.pots[k] += got; this.scooped += got
      const phi = this.potAngle(k)
      const excess = this.pots[k] - this.holds(phi)
      if (excess > 0 && phi >= Math.PI - this.spill) { this.pots[k] -= excess; this.poured += excess }
      const mass = RHO * this.pots[k]
      torque -= mass * G * this.potRadius * Math.sin(phi)
      water += mass
    }
    const drive = this.motor.stall * Math.max(0, 1 - this.speed / this.motor.free)
    torque += drive - 0.4 * this.inertia * this.speed
    this.speed = Math.max(0, this.speed + torque / (this.inertia + water * this.potRadius ** 2) * dt)
    this.angle = wrap(this.angle + this.speed * dt)
  }

  held(): number { let sum = 0; for (const v of this.pots) sum += v; return sum }

  reset(): void { this.angle = 0; this.speed = 0; this.pots.fill(0); this.scooped = 0; this.poured = 0 }
}

/**
 * A bell siphon's pipe. Once the rising water tops the crown it primes, and
 * the column accelerates under the head between the basin and the mouth:
 * (L/(g·A))·Q' = Δh − (1 + K)·Q²/(2·g·A²). When the falling level uncovers
 * the bell's rim, air rushes in and the column breaks.
 */
export class SiphonPipe {
  primed = false
  flow = 0
  private readonly area: number

  constructor(readonly length: number, readonly diameter: number, readonly mouth: number, readonly trigger: number, readonly stop: number, readonly losses = 2.5) {
    this.area = Math.PI * diameter * diameter / 4
  }

  step(dt: number, level: number): number {
    if (!this.primed && level >= this.trigger) this.primed = true
    if (this.primed && level <= this.stop) this.primed = false
    const A = this.area
    if (this.primed) {
      const head = level - this.mouth
      const accel = G * A / this.length * (head - (1 + this.losses) * this.flow * Math.abs(this.flow) / (2 * G * A * A))
      this.flow = Math.max(0, this.flow + accel * dt)
    } else {
      this.flow *= Math.exp(-dt / 0.2)
      if (this.flow < 1e-5) this.flow = 0
    }
    return this.flow
  }

  reset(): void { this.primed = false; this.flow = 0 }
}

/**
 * An Archimedes screw in an inclined trough, turned by a gear motor. The
 * flights trap one pocket of water per pitch; each turn carries every pocket
 * one pitch up the axis. The lowest pocket fills as deep as its mouth sits
 * in the sump; the top pocket empties over the upper end. The load is the
 * weight the flights push up the axis: τ = Σ m·g·sin α · p / 2π.
 */
export class ScrewLift {
  angle = 0
  speed = 0
  readonly pockets: Float64Array
  readonly count: number
  readonly capacity: number
  readonly motor: Motor
  private readonly inertia: number
  scooped = 0
  poured = 0

  constructor(readonly length: number, readonly radius: number, readonly pitch: number, readonly incline: number, revolutionsPerSecond: number) {
    this.count = Math.max(2, Math.floor(length / pitch))
    this.pockets = new Float64Array(this.count)
    // At a 30° incline a pocket holds about a third of the flight volume.
    this.capacity = 0.34 * Math.PI * (radius * radius - (radius * 0.2) ** 2) * pitch
    const load = RHO * this.capacity * G * Math.sin(incline) * pitch / TAU * this.count
    this.motor = { stall: 2.2 * load + 20, free: 1.8 * revolutionsPerSecond * TAU }
    this.inertia = 60 * radius * radius * length
  }

  /** Axial position of pocket k along the screw (0 at the bottom). */
  position(k: number): number {
    return (((k + this.angle / TAU) % this.count) + this.count) % this.count * this.pitch
  }

  /** Volume the bottom pocket wants from the sump this step. */
  demand(dt: number, bottom: number, level: number): number {
    const k = this.bottomPocket()
    const submerged = Math.max(0, Math.min(1, (level - (bottom - this.radius)) / (2 * this.radius)))
    const target = this.capacity * submerged
    return target > this.pockets[k] ? (target - this.pockets[k]) * (1 - Math.exp(-6 * dt)) : 0
  }

  private bottomPocket(): number {
    let best = 0, low = Infinity
    for (let k = 0; k < this.count; k++) { const s = this.position(k); if (s < low) { low = s; best = k } }
    return best
  }

  step(dt: number, scooped: number): void {
    this.scooped = scooped; this.poured = 0
    this.pockets[this.bottomPocket()] += scooped
    let torque = 0, water = 0
    for (let k = 0; k < this.count; k++) {
      const mass = RHO * this.pockets[k]
      torque -= mass * G * Math.sin(this.incline) * this.pitch / TAU
      water += mass
    }
    torque += this.motor.stall * Math.max(0, 1 - this.speed / this.motor.free) - 0.5 * this.inertia * this.speed
    this.speed = Math.max(0, this.speed + torque / (this.inertia + water * this.radius ** 2) * dt)
    const before = this.angle
    this.angle += this.speed * dt
    // A pocket that passes the top empties over the end.
    for (let k = 0; k < this.count; k++) {
      const s0 = (((k + before / TAU) % this.count) + this.count) % this.count, s1 = (((k + this.angle / TAU) % this.count) + this.count) % this.count
      if (s1 < s0) { this.poured += this.pockets[k]; this.pockets[k] = 0 }
    }
  }

  /** Fill of the pocket at slot k, 0–1, for the renderer. */
  fill(k: number): number { return this.pockets[k] / this.capacity }

  held(): number { let sum = 0; for (const v of this.pockets) sum += v; return sum }

  reset(): void { this.angle = 0; this.speed = 0; this.pockets.fill(0); this.scooped = 0; this.poured = 0 }
}
