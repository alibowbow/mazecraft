import * as THREE from 'three'

/**
 * A camera operator for the water: while it runs, the garden is filmed in
 * shots of several seconds. The water leads: the camera holds on where it
 * is running now and glides after it (smoothly, with a dead zone, so the
 * wetting front's small jumps never shake the frame). When the course runs
 * steadily it looks at the device nearest the water, and pulls back for a
 * wide shot now and then. Moves are slow: a gentle push-in or crane on the
 * water, a slow orbit only on wide and device shots.
 */
export interface ShotFrame {
  target: THREE.Vector3
  /** Direction from the target to the camera (unit). */
  direction: THREE.Vector3
  /** Height of the framed view at the target (m). */
  height: number
}

interface Shot {
  subject: 'water' | 'device' | 'wide'
  target: THREE.Vector3
  azimuth: number
  elevation: number
  height: number
  /** Motion over the shot: orbit (rad/s), push (share of height), crane (rad). */
  orbit: number
  push: number
  crane: number
  start: number
  length: number
}

const smootherstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10) }

export class CinematicDirector {
  private shot: Shot | null = null
  private previous: ShotFrame | null = null
  private blendStart = 0
  private count = 0
  /** The water the camera follows: smoothed in time, with a dead zone. */
  private focus: THREE.Vector3 | null = null
  private goal: THREE.Vector3 | null = null
  private lastTime = 0

  constructor(private readonly centre: THREE.Vector3, private readonly extent: THREE.Vector3,
    private readonly baseAzimuth: number, private readonly sights: THREE.Vector3[]) {}

  reset(): void { this.shot = null; this.previous = null; this.focus = null; this.goal = null; this.count = 0 }

  /**
   * Frame for time `now` (s). `water` is where the water is running now (the
   * advancing front, or the newest stretch once it is steady); `advancing`
   * says whether it is still spreading.
   */
  frame(now: number, water: THREE.Vector3 | null, advancing: boolean): ShotFrame {
    const dt = this.lastTime ? Math.min(0.25, Math.max(0, now - this.lastTime)) : 0
    this.lastTime = now
    let jumped = false
    if (water) {
      if (!this.goal || water.distanceTo(this.goal) > 3.5) jumped = Boolean(this.goal)
      // Dead zone: small steps of the front do not move the goal at all.
      if (!this.goal) this.goal = water.clone()
      else if (water.distanceTo(this.goal) > 0.6) this.goal.lerp(water, 0.5)
      if (!this.focus) this.focus = this.goal.clone()
      // Critically damped glide (about 1.5 s to settle).
      this.focus.lerp(this.goal, 1 - Math.exp(-dt / 0.7))
    }
    const age = this.shot ? now - this.shot.start : Infinity
    if (!this.shot || age > this.shot.length || (jumped && age > 3 && this.shot.subject !== 'water')) this.cut(now, advancing)
    const shot = this.shot!
    if (shot.subject === 'water' && this.focus) shot.target.copy(this.focus)
    const current = this.shotFrame(shot, now)
    if (!this.previous) return current
    const blend = smootherstep((now - this.blendStart) / 3)
    if (blend >= 1) { this.previous = null; return current }
    return {
      target: this.previous.target.clone().lerp(current.target, blend),
      direction: this.previous.direction.clone().lerp(current.direction, blend).normalize(),
      height: THREE.MathUtils.lerp(this.previous.height, current.height, blend),
    }
  }

  private shotFrame(shot: Shot, now: number): ShotFrame {
    const eased = smootherstep((now - shot.start) / shot.length)
    const azimuth = shot.azimuth + shot.orbit * (now - shot.start)
    const elevation = shot.elevation + shot.crane * eased
    return {
      target: shot.target.clone(),
      direction: new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)),
      height: shot.height * (1 - shot.push * eased),
    }
  }

  private cut(now: number, advancing: boolean): void {
    if (this.shot) this.previous = this.shotFrame(this.shot, now)
    this.blendStart = now
    const k = this.count++
    const size = Math.max(this.extent.x, this.extent.y)
    const variety = (k * 0.618034) % 1
    // While the water advances the camera stays on it, with a wide shot
    // every fourth cut; once it runs steadily it also visits the device
    // nearest the water.
    const kind: Shot['subject'] = k % 4 === 3 || !this.focus ? 'wide' : !advancing && k % 2 === 1 && this.sights.length ? 'device' : 'water'
    const side = k % 2 ? 1 : -1
    let target = this.centre.clone()
    if (kind === 'water') target = this.focus!.clone()
    if (kind === 'device') {
      const from = this.focus!
      target = this.sights.reduce((best, sight) => sight.distanceTo(from) < best.distanceTo(from) ? sight : best).clone()
    }
    this.shot = {
      subject: kind, target, start: now,
      // Stay on the same side of the garden as the default view, turned a little.
      azimuth: this.baseAzimuth + side * (0.25 + variety * 0.4),
      elevation: kind === 'wide' ? 0.62 : 0.42 + variety * 0.18,
      height: kind === 'wide' ? Math.max(8, size * 0.85) : kind === 'device' ? 4.2 + variety * 1.2 : 5.5 + variety * 2,
      orbit: kind === 'water' ? 0 : side * 0.02,
      push: kind === 'wide' ? 0.06 : 0.1,
      crane: kind === 'water' && k % 3 === 2 ? 0.08 : 0,
      length: kind === 'wide' ? 8 : 9 + variety * 3,
    }
  }
}
