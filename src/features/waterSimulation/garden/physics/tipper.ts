import { G, OVERFALL, RHO } from './shallowWater'

/**
 * A shishi-odoshi: a bamboo tube on a pivot, closed at its tail end and open
 * at its mouth. Its motion is integrated from I·θ'' = τ_water + τ_tube − c·θ'.
 * The water inside keeps a level free surface: the tube is cut into slices,
 * each holding the circular segment under that surface, which gives both the
 * volume (solved for the surface height) and the water's moment about the
 * pivot. As the tube fills, its water creeps past the pivot until its moment
 * beats the heavy tail; the tube swings down, the mouth drops below the
 * surface and pours, and the tail swings it back onto its stone.
 *
 * As in real bamboo, a node closes the tube just on the mouth side of the
 * pivot: the water chamber runs from that node to the open mouth, and the
 * tail beyond the pivot is a dry, heavy counterweight.
 *
 * Angles: θ > 0 lifts the mouth. Arc length s runs along the axis from the
 * pivot, negative towards the mouth.
 */
export interface TubeShape {
  /** Pivot to mouth, pivot to closed tail (m). */
  arm: number
  tail: number
  radius: number
  /** Rest stop (tail on its stone) and full tip (mouth down). */
  rest: number
  tipped: number
  /** Node closing the water chamber, on the mouth side of the pivot (s < 0). */
  node?: number
}

const SLICES = 28

export interface TubeWater {
  /** Free surface height relative to the pivot. */
  surface: number
  /** Moment of the water's weight about the pivot (N·m, + lifts the mouth). */
  torque: number
  /** Second moment of the water's mass about the pivot (kg·m²). */
  inertia: number
  /** Height of the mouth's lowest rim point relative to the pivot. */
  lip: number
}

/** Area below a chord at signed distance w from the centre of a circle of radius r. */
function segmentArea(w: number, r: number): number {
  if (w <= -r) return 0
  if (w >= r) return Math.PI * r * r
  return r * r * Math.acos(-w / r) + w * Math.sqrt(r * r - w * w)
}

/** Centroid offset of that segment from the circle's centre (≤ 0). */
function segmentCentroid(w: number, r: number, area: number): number {
  if (area <= 1e-12 || w >= r) return 0
  const c = Math.max(0, r * r - w * w)
  return -(2 / 3) * c * Math.sqrt(c) / area
}

export function tubeWater(shape: TubeShape, angle: number, volume: number): TubeWater {
  const { arm, radius } = shape
  const node = shape.node ?? -0.03
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const ds = (node + arm) / SLICES
  const axisZ = (s: number) => -s * sin
  const lip = axisZ(-arm) - radius * cos
  const fill = (surface: number) => {
    let total = 0
    for (let k = 0; k < SLICES; k++) {
      const s = -arm + (k + 0.5) * ds
      total += segmentArea((surface - axisZ(s)) / cos, radius) * ds
    }
    return total
  }
  let low = Math.min(axisZ(-arm), axisZ(node)) - radius, high = Math.max(axisZ(-arm), axisZ(node)) + radius
  if (volume <= 0) return { surface: low, torque: 0, inertia: 0, lip }
  for (let n = 0; n < 40; n++) {
    const mid = (low + high) / 2
    if (fill(mid) < volume) low = mid; else high = mid
  }
  const surface = (low + high) / 2
  let torque = 0, inertia = 0
  for (let k = 0; k < SLICES; k++) {
    const s = -arm + (k + 0.5) * ds
    const w = (surface - axisZ(s)) / cos
    const area = segmentArea(w, radius)
    if (area <= 0) continue
    const mass = RHO * area * ds
    // Horizontal lever of the slice's water: along the axis, plus the
    // segment centroid sitting low in the cross-section.
    const lever = s * cos - segmentCentroid(w, radius, area) * sin
    torque += mass * G * lever
    inertia += mass * (s * s + radius * radius / 2)
  }
  return { surface, torque, inertia, lip }
}

export class TipperBody {
  angle: number
  speed = 0
  volume = 0
  /** Water that left the mouth in the last step (m³). */
  poured = 0
  /** Volume at which the moments balance at rest. */
  readonly tipVolume: number
  /** Tube (with its tail plug) mass moment: m·s_c (kg·m, + on the tail side). */
  private readonly moment: number
  private readonly inertia: number
  /** Impact speed of the last knock on the stone (for sound and spray). */
  knock = 0

  constructor(readonly shape: TubeShape, readonly damping = 0.12) {
    this.angle = shape.rest
    // Fill at rest until the water would reach the mouth's lip.
    let full = 0
    for (let volume = 0.0002; volume < Math.PI * shape.radius ** 2 * shape.arm; volume += 0.0002) {
      if (tubeWater(shape, shape.rest, volume).surface >= tubeWater(shape, shape.rest, volume).lip) break
      full = volume
    }
    // The tail is weighted so the tube tips at about two thirds of that.
    const torques: number[] = []
    for (let k = 1; k <= 40; k++) torques.push(tubeWater(shape, shape.rest, full * k / 40).torque)
    const most = Math.min(...torques)
    let tip = full * 0.66
    for (let k = 0; k < torques.length; k++) if (torques[k] <= most * 0.7) { tip = full * (k + 1) / 40; break }
    this.tipVolume = tip
    const water = tubeWater(shape, shape.rest, tip)
    this.moment = Math.max(0.05, -water.torque / (G * Math.cos(shape.rest)))
    const tubeMass = 2.2 + this.moment / Math.max(0.05, shape.tail * 0.8)
    this.inertia = tubeMass * (shape.arm ** 2 + shape.tail ** 2) / 3
  }

  /** How much of a sheet of `width` falling at the mouth the tube catches (0–1). */
  catchShare(width: number): number {
    const facing = Math.max(0, Math.min(1, this.angle / this.shape.rest))
    return Math.min(1, 2.2 * this.shape.radius / Math.max(width, 1e-3)) * facing
  }

  step(dt: number, inflow: number): void {
    this.volume += inflow
    this.poured = 0
    this.knock = 0
    const substeps = 4, h = dt / substeps
    for (let n = 0; n < substeps; n++) {
      const water = tubeWater(this.shape, this.angle, this.volume)
      // Water over the mouth's lip pours out as over a weir.
      const head = water.surface - water.lip
      if (head > 0 && this.volume > 0) {
        const out = Math.min(this.volume, 0.6 * OVERFALL * 2 * this.shape.radius * Math.pow(head, 1.5) * h)
        this.volume -= out
        this.poured += out
      }
      const torque = water.torque + this.moment * G * Math.cos(this.angle) - this.damping * this.speed
      this.speed += torque / (this.inertia + water.inertia) * h
      this.angle += this.speed * h
      if (this.angle > this.shape.rest) {
        this.knock = Math.max(this.knock, Math.abs(this.speed))
        this.angle = this.shape.rest; this.speed = -0.3 * this.speed
        if (Math.abs(this.speed) < 0.05) this.speed = 0
      } else if (this.angle < this.shape.tipped) {
        this.angle = this.shape.tipped; this.speed = -0.2 * this.speed
      }
    }
  }

  reset(): void {
    this.angle = this.shape.rest; this.speed = 0; this.volume = 0; this.poured = 0; this.knock = 0
  }
}
