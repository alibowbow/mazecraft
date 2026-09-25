import * as THREE from 'three'

/**
 * A camera operator for the water: while it runs, the garden is filmed in
 * shots of a few seconds, each with its own subject, angle and move — a
 * slow orbit, a push-in, a crane up — and the camera glides from one to the
 * next. New water always takes the lead: when it reaches a basin or pours
 * off a device, the next shot goes to it; between arrivals the camera tours
 * the devices and pulls back for a wide shot now and then.
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

const TAU = Math.PI * 2
const smootherstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10) }

export class CinematicDirector {
  private shot: Shot | null = null
  private previous: ShotFrame | null = null
  private blendStart = 0
  private count = 0
  private tour = 0
  private lastHead: THREE.Vector3 | null = null
  private readonly water = new THREE.Vector3()

  /**
   * @param centre garden centre, @param extent its size, @param baseAzimuth
   * the default view's azimuth, @param sights devices worth a close look.
   */
  constructor(private readonly centre: THREE.Vector3, private readonly extent: THREE.Vector3,
    private readonly baseAzimuth: number, private readonly sights: THREE.Vector3[]) {}

  reset(): void { this.shot = null; this.previous = null; this.lastHead = null; this.count = 0 }

  /** Frame for time `now` (s), given the head of the newest water (or null). */
  frame(now: number, head: THREE.Vector3 | null): ShotFrame {
    if (head) {
      const arrived = !this.lastHead || head.distanceTo(this.lastHead) > 2.5
      this.lastHead = this.lastHead ? this.lastHead.lerp(head, 0.15) : head.clone()
      if (arrived && this.shot && this.shot.subject !== 'water' && now - this.shot.start > 1.5) this.cut(now, head)
    }
    if (!this.shot || now - this.shot.start > this.shot.length) this.cut(now, head)
    const shot = this.shot!
    if (shot.subject === 'water' && head) {
      // Track the water softly: the subject leads, the camera follows.
      this.water.lerp(head, 0.06)
      shot.target.copy(this.water)
    }
    const current = this.shotFrame(shot, now)
    if (!this.previous) return current
    const blend = smootherstep((now - this.blendStart) / 2.4)
    if (blend >= 1) { this.previous = null; return current }
    return {
      target: this.previous.target.clone().lerp(current.target, blend),
      direction: this.previous.direction.clone().lerp(current.direction, blend).normalize(),
      height: THREE.MathUtils.lerp(this.previous.height, current.height, blend),
    }
  }

  private shotFrame(shot: Shot, now: number): ShotFrame {
    const t = Math.min(1, (now - shot.start) / shot.length)
    const eased = smootherstep(t)
    const azimuth = shot.azimuth + shot.orbit * (now - shot.start)
    const elevation = shot.elevation + shot.crane * eased
    return {
      target: shot.target.clone(),
      direction: new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)),
      height: shot.height * (1 - shot.push * eased),
    }
  }

  private cut(now: number, head: THREE.Vector3 | null): void {
    if (this.shot) this.previous = this.shotFrame(this.shot, now)
    this.blendStart = now
    const k = this.count++
    // Every fourth shot pulls back wide; otherwise the water, or a device.
    const wide = k % 4 === 3 || (!head && !this.sights.length)
    const size = Math.max(this.extent.x, this.extent.y)
    const side = k % 2 ? 1 : -1
    let subject: Shot['subject'], target: THREE.Vector3
    if (wide) { subject = 'wide'; target = this.centre.clone() }
    else if (head) { subject = 'water'; target = head.clone(); this.water.copy(head) }
    else { subject = 'device'; target = this.sights[this.tour++ % this.sights.length].clone() }
    const variety = (k * 0.618034) % 1
    this.shot = {
      subject, target, start: now,
      azimuth: this.baseAzimuth + side * (0.35 + variety * 0.9),
      elevation: wide ? 0.62 : 0.28 + variety * 0.3,
      height: wide ? Math.max(8, size * 0.85) : 3.2 + variety * 2.2,
      orbit: side * (wide ? 0.035 : 0.06) * (k % 3 === 1 ? 0.3 : 1),
      push: wide ? 0.08 : k % 3 === 1 ? 0.28 : 0.12,
      crane: k % 3 === 2 ? 0.18 : 0,
      length: wide ? 9 : 7 + variety * 2,
    }
    if (this.shot.azimuth > TAU) this.shot.azimuth -= TAU
  }
}
