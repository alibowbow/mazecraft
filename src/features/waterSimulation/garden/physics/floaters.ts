import type * as THREE from 'three'
import type RAPIER_NS from '@dimforge/rapier3d-compat'
import type { GardenLayout } from '../layout'
import { TIPPER_ARM, TIPPER_RADIUS, TIPPER_TAIL, WHEEL_PADDLES } from '../mechanics'
import type { PhysicsWorld } from './world'
import { DRY, RHO } from './shallowWater'

/**
 * Things that float in the garden, as Rapier rigid bodies: they collide with
 * the ceramic walls, beds, spouts and troughs (static triangle meshes) and
 * are pushed by the moving machinery (kinematic tipping tubes and wheels
 * that follow the hydraulics). The water acts on them through the shallow-
 * water and channel solutions: buoyancy from the submerged volume under the
 * simulated surface, and quadratic drag towards the simulated current.
 */
export type Rapier = typeof RAPIER_NS
export type FloaterKind = 'duck' | 'ball' | 'leaf' | 'block'
export const FLOATER_KINDS: FloaterKind[] = ['duck', 'ball', 'leaf', 'block']

interface FloaterSpec {
  name: string
  /** Half extents (cuboid) or radius (ball) in m. */
  size: [number, number, number]
  shape: 'ball' | 'cuboid'
  /** Density (kg/m³): all float, at different depths. */
  density: number
  /** Drag coefficient and whether it rights itself (keel / low centre of mass). */
  drag: number
  upright: boolean
}

export const FLOATER_SPECS: Record<FloaterKind, FloaterSpec> = {
  duck: { name: '고무오리', size: [0.14, 0.14, 0.14], shape: 'ball', density: 180, drag: 0.8, upright: true },
  ball: { name: '비치볼', size: [0.12, 0.12, 0.12], shape: 'ball', density: 90, drag: 0.5, upright: false },
  leaf: { name: '나뭇잎배', size: [0.19, 0.085, 0.025], shape: 'cuboid', density: 420, drag: 1.2, upright: true },
  block: { name: '나무토막', size: [0.09, 0.09, 0.09], shape: 'cuboid', density: 560, drag: 1.05, upright: false },
}

const G = 9.81
const MAX_FLOATERS = 40

let loading: Promise<Rapier> | null = null
/** Load and initialise Rapier (WebAssembly) once, on first use. */
export function loadRapier(): Promise<Rapier> {
  loading ??= import('@dimforge/rapier3d-compat').then(async module => {
    const rapier = ((module as unknown as { default?: Rapier }).default ?? module) as Rapier
    await rapier.init()
    return rapier
  })
  return loading
}

/** Water at a point: surface height, depth, and current (m/s). */
export interface WaterSample { surface: number; depth: number; vx: number; vy: number }

/** Reads the water the hydraulics computed: basin grids, then channels. */
export function waterAt(world: PhysicsWorld, x: number, y: number, z: number): WaterSample | null {
  let best: WaterSample | null = null, bestGap = Infinity
  for (const domain of world.domains) {
    const g = domain.grid
    const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((y - g.y0) / g.dx)
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue
    const c = j * g.nx + i
    if (g.solid[c] || domain.poolOf[c] < 0) continue
    const depth = g.h[c], surface = g.bed[c] + depth
    // Of basins stacked in plan, the one whose water the body is in or above.
    if (z < g.bed[c] - 0.15) continue
    const gap = Math.abs(z - surface)
    if (gap < bestGap) {
      const [vx, vy] = depth > DRY * 5 ? g.velocity(c) : [0, 0]
      best = { surface, depth, vx, vy }; bestGap = gap
    }
  }
  for (const channel of world.channels) {
    const half = channel.width / 2
    for (let k = 0; k < channel.n; k++) {
      const dx = x - channel.px[k], dy = y - channel.py[k]
      if (dx * dx + dy * dy > half * half) continue
      const depth = channel.h[k], surface = channel.bed[k] + depth
      if (z < channel.bed[k] - 0.15 || depth <= DRY) continue
      const gap = Math.abs(z - surface)
      if (gap >= bestGap) continue
      const next = Math.min(channel.n - 1, k + 1), prev = Math.max(0, k - 1)
      const tx = channel.px[next] - channel.px[prev], ty = channel.py[next] - channel.py[prev]
      const length = Math.hypot(tx, ty) || 1
      const speed = channel.discharge(k) / Math.max(1e-4, depth * channel.width)
      best = { surface, depth, vx: tx / length * speed, vy: ty / length * speed }; bestGap = gap
    }
  }
  return best
}

/** Volume of a sphere of radius r submerged to depth d (spherical cap). */
function capVolume(r: number, d: number): number {
  const h = Math.max(0, Math.min(2 * r, d))
  return Math.PI * h * h * (3 * r - h) / 3
}

interface Floater { kind: FloaterKind; body: RAPIER_NS.RigidBody; volume: number; radius: number }
interface Driven { body: RAPIER_NS.RigidBody; update(angle: number): void }

export class FloaterWorld {
  private readonly world: RAPIER_NS.World
  private readonly floaters: Floater[] = []
  private readonly tippers: Driven[] = []
  private readonly wheels: Driven[] = []

  constructor(private readonly R: Rapier, private readonly layout: GardenLayout, solids: THREE.BufferGeometry[]) {
    this.world = new R.World({ x: 0, y: 0, z: -G })
    // Sand, then every ceramic surface as static triangle meshes.
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed())
    const { bounds } = layout
    this.world.createCollider(R.ColliderDesc.cuboid((bounds.maxX - bounds.minX) / 2 + 20, (bounds.maxY - bounds.minY) / 2 + 20, 0.05)
      .setTranslation((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, -0.05).setFriction(0.8), ground)
    for (const geometry of solids) {
      const mesh = trimesh(geometry)
      if (mesh) this.world.createCollider(R.ColliderDesc.trimesh(mesh.vertices, mesh.indices).setFriction(0.5), ground)
    }
    // Tipping tubes: a capsule about the pivot, turned to the hydraulics' angle.
    for (const tipper of layout.tippers) {
      const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(tipper.pivot[0], tipper.pivot[1], tipper.pivotZ))
      const length = TIPPER_ARM + TIPPER_TAIL
      this.world.createCollider(R.ColliderDesc.capsule(length / 2, TIPPER_RADIUS).setTranslation(0, (TIPPER_ARM - TIPPER_TAIL) / 2, 0), body)
      const [dx, dy] = tipper.direction
      this.tippers.push({ body, update: angle => {
        // Local +y runs from the pivot to the mouth: back along the spout, raised by the angle.
        const axis = { x: -dx * Math.cos(angle), y: -dy * Math.cos(angle), z: Math.sin(angle) }
        body.setNextKinematicRotation(fromTo({ x: 0, y: 1, z: 0 }, axis))
      } })
    }
    // Wheels: paddles about the axle, turned to the hydraulics' angle.
    for (const wheel of layout.wheels) {
      const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(wheel.center[0], wheel.center[1], wheel.z))
      const paddles = WHEEL_PADDLES + (wheel.overshot ? 2 : 0)
      for (let p = 0; p < paddles; p++) {
        const a = p / paddles * Math.PI * 2
        this.world.createCollider(R.ColliderDesc.cuboid(wheel.width / 2, wheel.radius * 0.2, 0.015)
          .setTranslation(0, Math.cos(a) * wheel.radius * 0.8, Math.sin(a) * wheel.radius * 0.8)
          .setRotation(axisAngle({ x: 1, y: 0, z: 0 }, a + Math.PI / 2)), body)
      }
      const align = fromTo({ x: 1, y: 0, z: 0 }, { x: wheel.axis[0], y: wheel.axis[1], z: 0 })
      this.wheels.push({ body, update: angle => body.setNextKinematicRotation(multiply(align, axisAngle({ x: 1, y: 0, z: 0 }, angle))) })
    }
  }

  get count(): number { return this.floaters.length }

  drop(kind: FloaterKind, x: number, y: number, z: number): void {
    const R = this.R, spec = FLOATER_SPECS[kind]
    if (this.floaters.length >= MAX_FLOATERS) this.remove(0)
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setRotation(axisAngle({ x: 0, y: 0, z: 1 }, Math.random() * Math.PI * 2)).setCcdEnabled(true))
    const [a, b, c] = spec.size
    const desc = spec.shape === 'ball' ? R.ColliderDesc.ball(a) : R.ColliderDesc.cuboid(a, b, c)
    const volume = spec.shape === 'ball' ? 4 / 3 * Math.PI * a ** 3 : 8 * a * b * c
    this.world.createCollider(desc.setDensity(spec.density).setFriction(0.4).setRestitution(0.2), body)
    this.floaters.push({ kind, body, volume, radius: Math.cbrt(volume * 3 / (4 * Math.PI)) })
  }

  clear(): void { while (this.floaters.length) this.remove(this.floaters.length - 1) }

  private remove(index: number): void {
    const [floater] = this.floaters.splice(index, 1)
    this.world.removeRigidBody(floater.body)
  }

  /** Advance by dt with the current water and machinery. */
  step(dt: number, water: PhysicsWorld, tipperAngles: ArrayLike<number>, wheelAngles: ArrayLike<number>): void {
    this.tippers.forEach((tipper, i) => tipper.update(tipperAngles[i] ?? 0))
    this.wheels.forEach((wheel, i) => wheel.update(wheelAngles[i] ?? 0))
    for (let k = this.floaters.length - 1; k >= 0; k--) {
      const { body, volume, radius, kind } = this.floaters[k]
      const p = body.translation()
      if (p.z < -3 || !Number.isFinite(p.z)) { this.remove(k); continue }
      body.resetForces(true); body.resetTorques(true)
      const sample = waterAt(water, p.x, p.y, p.z)
      if (!sample || sample.depth <= DRY * 5) continue
      const submerged = capVolume(radius, sample.surface - (p.z - radius))
      if (submerged <= 0) continue
      const share = submerged / volume
      const v = body.linvel()
      // Buoyancy (Archimedes) and quadratic drag towards the current.
      const rx = sample.vx - v.x, ry = sample.vy - v.y, rz = -v.z
      const rel = Math.hypot(rx, ry, rz)
      const drag = 0.5 * RHO * FLOATER_SPECS[kind].drag * Math.PI * radius * radius * rel * Math.min(1, share * 1.5)
      body.addForce({ x: drag * rx, y: drag * ry, z: RHO * G * submerged + drag * rz * 1.6 }, true)
      // Water damps spin; keeled floaters turn upright.
      const w = body.angvel(), mass = body.mass()
      const damping = mass * 2.5 * share
      let tx = -w.x * damping, ty = -w.y * damping
      const tz = -w.z * damping * 0.4
      if (FLOATER_SPECS[kind].upright) {
        const q = body.rotation()
        // Body up in world: third column of the rotation.
        const ux = 2 * (q.x * q.z + q.w * q.y), uy = 2 * (q.y * q.z - q.w * q.x)
        const righting = mass * G * radius * 3 * share
        tx += uy * righting; ty -= ux * righting
      }
      body.addTorque({ x: tx, y: ty, z: tz }, true)
    }
    this.world.timestep = dt
    this.world.step()
  }

  /** x, y, z, qx, qy, qz, qw, kind for each floater. */
  snapshot(out = new Float32Array(this.floaters.length * 8)): Float32Array {
    this.floaters.forEach(({ body, kind }, k) => {
      const p = body.translation(), q = body.rotation()
      out.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, FLOATER_KINDS.indexOf(kind)], k * 8)
    })
    return out
  }

  dispose(): void { this.world.free() }
}

type V3 = { x: number; y: number; z: number }
type Q = { x: number; y: number; z: number; w: number }

function axisAngle(axis: V3, angle: number): Q {
  const s = Math.sin(angle / 2), l = Math.hypot(axis.x, axis.y, axis.z) || 1
  return { x: axis.x / l * s, y: axis.y / l * s, z: axis.z / l * s, w: Math.cos(angle / 2) }
}

function multiply(a: Q, b: Q): Q {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

/** Shortest rotation taking unit vector a onto b. */
function fromTo(a: V3, b: V3): Q {
  const lb = Math.hypot(b.x, b.y, b.z) || 1
  const bx = b.x / lb, by = b.y / lb, bz = b.z / lb
  const dot = a.x * bx + a.y * by + a.z * bz
  if (dot < -0.999999) return Math.abs(a.x) < 0.9 ? axisAngle({ x: 1, y: 0, z: 0 }, Math.PI) : axisAngle({ x: 0, y: 1, z: 0 }, Math.PI)
  const q = { x: a.y * bz - a.z * by, y: a.z * bx - a.x * bz, z: a.x * by - a.y * bx, w: 1 + dot }
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

function trimesh(geometry: THREE.BufferGeometry): { vertices: Float32Array; indices: Uint32Array } | null {
  const position = geometry.getAttribute('position')
  if (!position || position.count < 3) return null
  const vertices = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) { vertices[i * 3] = position.getX(i); vertices[i * 3 + 1] = position.getY(i); vertices[i * 3 + 2] = position.getZ(i) }
  const indices = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: position.count }, (_, i) => i)
  return { vertices, indices }
}
