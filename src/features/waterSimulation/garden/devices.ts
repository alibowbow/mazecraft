import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type Edge, type GardenLayout, type Lift, type Tipper, type Wheel } from './layout'
import type { GardenState } from './simulation'
import { NORIA_POT, NORIA_POTS, SCREW_PITCH } from './physics/world'
import { TIPPER_ARM, TIPPER_RADIUS, TIPPER_REST, TIPPER_TAIL, WHEEL_PADDLES } from './mechanics'

interface Part { group: THREE.Group; pivot: THREE.Object3D }

function merged(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map(geometry => {
    const result = geometry.index ? geometry.toNonIndexed() : geometry
    for (const name of Object.keys(result.attributes)) if (name !== 'position' && name !== 'normal') result.deleteAttribute(name)
    return result
  })
  const geometry = mergeGeometries(clean, false)!
  list.forEach(g => g.dispose()); clean.forEach(g => g.dispose())
  return geometry
}

/** A post from the bed up to an axle, in the plan frame of a device. */
function post(x: number, y: number, bottom: number, top: number, size = 0.07): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size, size, Math.max(0.02, top - bottom))
  geometry.translate(x, y, (bottom + top) / 2)
  return geometry
}

/** A beam between two points (for frames and legs). */
function strut(a: THREE.Vector3, b: THREE.Vector3, size: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size, a.distanceTo(b), size)
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()))
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return geometry
}

const NORIA_BUCKETS = NORIA_POTS

interface Noria extends Part { spin: number; angle: number; water: THREE.Object3D[]; screw?: { count: number; radius: number } }

/** Pot centre radius and depth along the axle (the physics' pot). */
const NORIA_POT_RADIUS = (radius: number) => radius - NORIA_POT.inset
const NORIA_POT_DEPTH = NORIA_POT.reach
/** Axle offset of the A-frames from each face of the wheel, clear of the pots. */
const NORIA_FRAME = 0.45

/** Where a noria's pots pour: over the trough, beside the top of the wheel. */
export function noriaPour(lift: Lift): { x: number; y: number; z: number } {
  if (lift.kind === 'screw') {
    const run = (lift.length ?? 4) * Math.cos(lift.incline ?? 0.5)
    return { x: lift.center[0] + lift.direction[0] * run, y: lift.center[1] + lift.direction[1] * run, z: lift.hub + (lift.length ?? 4) * Math.sin(lift.incline ?? 0.5) }
  }
  const heading = Math.atan2(lift.direction[1], lift.direction[0])
  const ax = -Math.sin(heading), ay = Math.cos(heading), start = lift.path[0]
  const side = Math.sign((start[0] - lift.center[0]) * ax + (start[1] - lift.center[1]) * ay) || 1
  const across = side * (lift.width / 2 + 0.03 + NORIA_POT_DEPTH / 2)
  return { x: lift.center[0] + ax * across, y: lift.center[1] + ay * across, z: lift.hub + NORIA_POT_RADIUS(lift.radius) - NORIA_POT.depth / 2 }
}

/**
 * The garden's machinery: bamboo tipping tubes (shishi-odoshi) that swing
 * with the simulated load, and paddle wheels whose speed follows the flow
 * that drives them.
 */
export class GardenDevices {
  readonly group = new THREE.Group()
  private readonly tippers: Part[] = []
  private readonly wheels: (Part & { spin: number; angle: number })[] = []
  private readonly norias: Noria[] = []
  private readonly bucketWater = new THREE.MeshStandardMaterial({ color: 0x7fd6de, roughness: 0.08, transparent: true, opacity: 0.85 })
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly pocketWater = new THREE.BoxGeometry(SCREW_PITCH * 0.55, 0.42, 0.22)
  private readonly flightMaterial = new THREE.MeshPhysicalMaterial({ color: 0xa9784c, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.25, side: THREE.DoubleSide })
  private readonly potWater = new THREE.BoxGeometry(NORIA_POT.width - 0.04, NORIA_POT_DEPTH - 0.05, NORIA_POT.depth * 0.5)
  private readonly bamboo = new THREE.MeshPhysicalMaterial({ color: 0xb49a55, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.18, sheen: 0.3, sheenColor: new THREE.Color(0xfff0c8) })
  private readonly teak = new THREE.MeshPhysicalMaterial({ color: 0x7e5334, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.25 })
  private previousTime: number | null = null
  /** Set whenever a part moved, so the caller can refresh the shadows. */
  moved = false

  constructor(private readonly layout: GardenLayout, private readonly ceramic: THREE.Material, private readonly brass: THREE.Material) {
    this.group.name = 'garden-machinery'
    for (const tipper of layout.tippers) this.tippers.push(this.buildTipper(tipper))
    for (const wheel of layout.wheels) this.wheels.push({ ...this.buildWheel(wheel), spin: 0, angle: wheel.index * 0.7 })
    for (const lift of layout.lifts) this.norias.push(lift.kind === 'screw' ? this.buildScrew(lift) : this.buildNoria(lift))
    for (const edge of layout.edges) if (edge.chain) this.buildChain(edge)
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, name: string): THREE.Mesh {
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true
    this.geometries.push(geometry)
    parent.add(mesh)
    return mesh
  }

  private buildTipper(tipper: Tipper): Part {
    const group = new THREE.Group()
    group.name = `garden-tipper-${tipper.index}`
    group.position.set(tipper.pivot[0], tipper.pivot[1], tipper.pivotZ)
    group.rotation.z = Math.atan2(tipper.direction[1], tipper.direction[0])
    const pivot = new THREE.Group()
    group.add(pivot)
    // Bamboo tube along local x: open mouth at -ARM, node-closed end at +TAIL.
    const length = TIPPER_ARM + TIPPER_TAIL
    const tube = new THREE.CylinderGeometry(TIPPER_RADIUS, TIPPER_RADIUS * 1.04, length, 28, 1, true)
    tube.rotateZ(Math.PI / 2)
    tube.translate((TIPPER_TAIL - TIPPER_ARM) / 2, 0, 0)
    const inner = new THREE.CylinderGeometry(TIPPER_RADIUS * 0.86, TIPPER_RADIUS * 0.86, length * 0.98, 28, 1, true)
    inner.rotateZ(Math.PI / 2)
    inner.translate((TIPPER_TAIL - TIPPER_ARM) / 2, 0, 0)
    // Inner wall faces inward: reverse its winding.
    if (inner.index) inner.setIndex(Array.from(inner.index.array).reverse())
    const normals = inner.getAttribute('normal')
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i))
    const lip = new THREE.RingGeometry(TIPPER_RADIUS * 0.86, TIPPER_RADIUS, 28)
    lip.rotateY(-Math.PI / 2)
    lip.translate(-TIPPER_ARM, 0, 0)
    const cap = new THREE.CircleGeometry(TIPPER_RADIUS * 1.04, 28)
    cap.rotateY(Math.PI / 2)
    cap.translate(TIPPER_TAIL, 0, 0)
    const nodes = [-TIPPER_ARM * 0.35, TIPPER_TAIL * 0.55].map(x => {
      const node = new THREE.TorusGeometry(TIPPER_RADIUS * 1.03, 0.011, 8, 28)
      node.rotateY(Math.PI / 2)
      node.translate(x, 0, 0)
      return node
    })
    this.mesh(merged([tube, inner, lip, cap, ...nodes]), this.bamboo, pivot, 'garden-tipper-tube')
    // Brass axle through two ceramic posts standing on the bed.
    const span = TIPPER_RADIUS + 0.09
    const axle = new THREE.CylinderGeometry(0.016, 0.016, span * 2 + 0.1, 12)
    this.mesh(axle, this.brass, group, 'garden-tipper-axle')
    const base = tipper.base - tipper.pivotZ
    this.mesh(merged([post(0, -span, base, 0.05), post(0, span, base, 0.05)]), this.ceramic, group, 'garden-tipper-posts')
    // The closed end rests (and knocks) on a small stone post.
    const [tx, , tz] = [TIPPER_TAIL * 0.8 * Math.cos(TIPPER_REST), 0, -TIPPER_TAIL * 0.8 * Math.sin(TIPPER_REST) - TIPPER_RADIUS]
    const stone = new THREE.CylinderGeometry(0.05, 0.06, Math.max(0.02, tz - base), 16)
    stone.rotateX(Math.PI / 2)
    stone.translate(tx, 0, (tz + base) / 2)
    this.mesh(stone, this.ceramic, group, 'garden-tipper-rest')
    this.group.add(group)
    return { group, pivot }
  }

  private buildWheel(wheel: Wheel): Part {
    const group = new THREE.Group()
    group.name = `garden-wheel-${wheel.index}`
    group.position.set(wheel.center[0], wheel.center[1], wheel.z)
    group.rotation.z = Math.atan2(wheel.direction[1], wheel.direction[0])
    const pivot = new THREE.Group()
    group.add(pivot)
    const r = wheel.radius, w = wheel.width
    const wood: THREE.BufferGeometry[] = []
    for (const side of [-1, 1]) {
      // Side shrouds: a solid annulus each side, joined to the hub by spokes.
      for (const face of [-1, 1]) {
        const shroud = new THREE.RingGeometry(r * 0.58, r, 48)
        shroud.rotateX(face * Math.PI / 2)
        shroud.translate(0, side * w / 2 + face * 0.009, 0)
        wood.push(shroud)
      }
      const outer = new THREE.CylinderGeometry(r, r, 0.018, 48, 1, true)
      outer.translate(0, side * w / 2, 0)
      wood.push(outer)
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.BoxGeometry(r * 1.2, 0.024, 0.03)
        spoke.rotateY(k / 3 * Math.PI)
        spoke.translate(0, side * w / 2, 0)
        wood.push(spoke)
      }
    }
    const paddles = wheel.overshot ? WHEEL_PADDLES + 2 : WHEEL_PADDLES
    for (let k = 0; k < paddles; k++) {
      const a = k / paddles * Math.PI * 2
      const paddle = new THREE.BoxGeometry(0.022, w, r * 0.5)
      // Overshot wheels carry shallow buckets: paddles lean into the flow.
      paddle.rotateY(wheel.overshot ? 0.35 : 0)
      paddle.translate(0, 0, r * 0.74)
      paddle.rotateY(a)
      wood.push(paddle)
    }
    this.mesh(merged(wood), this.teak, pivot, 'garden-wheel-paddles')
    const hub = new THREE.CylinderGeometry(0.045, 0.045, w + 0.04, 16)
    const axle = new THREE.CylinderGeometry(0.018, 0.018, wheel.overshot ? w + 0.26 : w / 0.78 + 0.34, 12)
    this.mesh(merged([hub, axle]), this.brass, pivot, 'garden-wheel-hub')
    if (wheel.overshot) {
      const span = w / 2 + 0.1, base = wheel.base - wheel.z
      this.mesh(merged([post(0, -span, base, 0.05), post(0, span, base, 0.05)]), this.ceramic, group, 'garden-wheel-posts')
    }
    this.group.add(group)
    return { group, pivot }
  }

  /**
   * A great bucket wheel in local frame: x along its plane, y along the axle.
   * Floats between the rims take the sump's current; pots hung on the trough side
   * of the rim scoop at the bottom, rise on the +x side and pour as they
   * turn over the top, into the trough that runs beside the wheel.
   */
  private buildNoria(lift: Lift): Noria {
    const group = new THREE.Group()
    group.name = `garden-noria-${lift.index}`
    group.position.set(lift.center[0], lift.center[1], lift.hub)
    const heading = Math.atan2(lift.direction[1], lift.direction[0])
    group.rotation.z = heading
    const pivot = new THREE.Group()
    group.add(pivot)
    const R = lift.radius, w = lift.width
    // Which face of the wheel the trough (and so the pots) is on.
    const start = lift.path[0]
    const side = Math.sign((start[0] - lift.center[0]) * -Math.sin(heading) + (start[1] - lift.center[1]) * Math.cos(heading)) || 1
    const wood: THREE.BufferGeometry[] = []
    for (const face of [-1, 1]) {
      for (const radius of [R, R * 0.72]) {
        const rim = new THREE.TorusGeometry(radius, 0.035, 8, 96)
        rim.rotateX(Math.PI / 2)
        rim.translate(0, face * w / 2, 0)
        wood.push(rim)
      }
      for (let k = 0; k < 8; k++) {
        const spoke = new THREE.BoxGeometry(R * 2, 0.05, 0.06)
        spoke.rotateY(k / 8 * Math.PI)
        spoke.translate(0, face * w / 2, 0)
        wood.push(spoke)
      }
    }
    const place = (geometry: THREE.BufferGeometry, a: number, radius: number) => {
      geometry.rotateY(a)
      geometry.translate(Math.sin(a) * radius, 0, -Math.cos(a) * radius)
      return geometry
    }
    for (let k = 0; k < NORIA_BUCKETS; k++) {
      const a = (k + 0.5) / NORIA_BUCKETS * Math.PI * 2
      // Floats between the rims catch the sump's current.
      const float = new THREE.BoxGeometry(0.02, w * 0.96, 0.18)
      float.translate(0, 0, 0.09)
      wood.push(place(float, a, R))
    }
    const water: THREE.Object3D[] = []
    const depth = NORIA_POT_DEPTH, inner = w / 2 + 0.03, mid = side * (inner + depth / 2)
    for (let k = 0; k < NORIA_BUCKETS; k++) {
      const a = k / NORIA_BUCKETS * Math.PI * 2
      // A pot: bottom outward, two walls and two ends, open towards the axle.
      const pw = NORIA_POT.width, pd = NORIA_POT.depth
      for (const [dx, y, dz, sx, sy, sz] of [
        [0, mid, -pd / 2, pw + 0.02, depth, 0.025], [-pw / 2, mid, 0, 0.025, depth, pd], [pw / 2, mid, 0, 0.025, depth, pd],
        [0, side * inner, 0, pw + 0.02, 0.025, pd], [0, side * (inner + depth), 0, pw + 0.02, 0.025, pd],
      ] as const) {
        const plank = new THREE.BoxGeometry(sx, sy, sz)
        plank.translate(dx, y, dz)
        wood.push(place(plank, a, NORIA_POT_RADIUS(R)))
      }
      // Its water stays level while the pot swings: a child that counter-rotates.
      const anchor = new THREE.Object3D()
      anchor.position.set(Math.sin(a) * NORIA_POT_RADIUS(R), mid, -Math.cos(a) * NORIA_POT_RADIUS(R))
      const fill = new THREE.Mesh(this.potWater, this.bucketWater)
      fill.name = 'garden-noria-bucket-water'
      fill.visible = false
      anchor.add(fill)
      pivot.add(anchor)
      water.push(anchor)
    }
    this.mesh(merged(wood), this.teak, pivot, 'garden-noria-wheel')
    const hub = new THREE.CylinderGeometry(0.12, 0.12, w + 0.12, 24)
    const axle = new THREE.CylinderGeometry(0.045, 0.045, w + 2 * NORIA_FRAME + 0.3, 16)
    this.mesh(merged([hub, axle]), this.brass, pivot, 'garden-noria-hub')
    // Two A-frames standing in the sump carry the axle, outside the pots.
    const frame: THREE.BufferGeometry[] = []
    const base = lift.base - lift.hub
    for (const face of [-1, 1]) {
      const y = face * (w / 2 + NORIA_FRAME), top = new THREE.Vector3(0, y, 0.08)
      frame.push(strut(new THREE.Vector3(-0.75, y, base), top, 0.12), strut(new THREE.Vector3(0.75, y, base), top, 0.12))
      frame.push(strut(new THREE.Vector3(-0.42, y, base * 0.45), new THREE.Vector3(0.42, y, base * 0.45), 0.08))
    }
    this.mesh(merged(frame), this.ceramic, group, 'garden-noria-frame')
    this.group.add(group)
    return { group, pivot, spin: 0, angle: lift.index * 0.4, water }
  }

  /**
   * An Archimedes screw in local frame: x up its axis from the lower end,
   * the whole group pitched up by the incline. The flights and shaft turn
   * about x; the water pockets ride up between the flights, level.
   */
  private buildScrew(lift: Lift): Noria {
    const L = lift.length ?? 4, incline = lift.incline ?? Math.PI / 6, R = lift.radius
    const group = new THREE.Group()
    group.name = `garden-screw-${lift.index}`
    group.position.set(lift.center[0], lift.center[1], lift.hub)
    group.rotation.set(0, -incline, Math.atan2(lift.direction[1], lift.direction[0]), 'ZYX')
    const pivot = new THREE.Group()
    group.add(pivot)
    // Open trough the screw turns in: a half-pipe, glazed like the basins.
    const trough = new THREE.CylinderGeometry(R + 0.05, R + 0.05, L, 36, 1, true, Math.PI / 2, Math.PI)
    trough.rotateZ(-Math.PI / 2)
    trough.translate(L / 2, 0, 0)
    const inner = trough.clone()
    inner.scale(1, 0.94, 0.94)
    if (inner.index) inner.setIndex(Array.from(inner.index.array).reverse())
    this.mesh(merged([trough, inner]), this.ceramic, group, 'garden-screw-trough')
    // Helical flights: a ribbon from the shaft to the rim, one turn per pitch.
    const turns = L / SCREW_PITCH, steps = Math.ceil(turns * 40)
    const positions: number[] = [], index: number[] = []
    for (let k = 0; k <= steps; k++) {
      const x = k / steps * L, a = k / steps * turns * Math.PI * 2
      for (const r of [R * 0.2, R * 0.96]) positions.push(x, Math.cos(a) * r, Math.sin(a) * r)
      if (k < steps) { const b = k * 2; index.push(b, b + 2, b + 1, b + 1, b + 2, b + 3) }
    }
    const flight = new THREE.BufferGeometry()
    flight.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    flight.setIndex(index)
    flight.computeVertexNormals()
    const flightMesh = this.mesh(flight, this.flightMaterial, pivot, 'garden-screw-flights')
    flightMesh.castShadow = true
    const shaft = new THREE.CylinderGeometry(R * 0.2, R * 0.2, L + 0.3, 20)
    shaft.rotateZ(-Math.PI / 2)
    shaft.translate(L / 2, 0, 0)
    this.mesh(shaft, this.brass, pivot, 'garden-screw-shaft')
    // Bearings at both ends and a gear motor above the upper one.
    const frame: THREE.BufferGeometry[] = []
    const lower = new THREE.BoxGeometry(0.16, 0.5, 0.12); lower.translate(-0.12, 0, -R * 0.4); frame.push(lower)
    const upper = new THREE.BoxGeometry(0.16, 0.6, 0.14); upper.translate(L + 0.14, 0, 0); frame.push(upper)
    const motor = new THREE.BoxGeometry(0.34, 0.3, 0.26); motor.translate(L + 0.3, 0, 0.22); frame.push(motor)
    this.mesh(merged(frame), this.ceramic, group, 'garden-screw-bearings')
    const gear = new THREE.CylinderGeometry(0.16, 0.16, 0.05, 24)
    gear.rotateZ(-Math.PI / 2); gear.translate(L + 0.2, 0, 0)
    this.mesh(gear, this.brass, pivot, 'garden-screw-gear')
    // Posts from the ground to the upper bearing (the lower end sits in the sump).
    const top = lift.hub + L * Math.sin(incline)
    const post = new THREE.CylinderGeometry(0.07, 0.09, top, 12)
    post.rotateX(Math.PI / 2)
    const run = L * Math.cos(incline)
    post.translate(lift.center[0] + lift.direction[0] * (run + 0.1), lift.center[1] + lift.direction[1] * (run + 0.1), top / 2)
    this.mesh(post, this.ceramic, this.group, 'garden-screw-post')
    // Water pockets: level boxes that ride up the axis between the flights.
    const water: THREE.Object3D[] = []
    const count = Math.max(2, Math.floor(L / SCREW_PITCH))
    for (let k = 0; k < count; k++) {
      const anchor = new THREE.Object3D()
      const fill = new THREE.Mesh(this.pocketWater, this.bucketWater)
      fill.name = 'garden-screw-pocket-water'
      fill.visible = false
      // Undo the incline so the pocket's surface stays level.
      fill.rotation.y = incline
      anchor.add(fill)
      group.add(anchor)
      water.push(anchor)
    }
    this.group.add(group)
    return { group, pivot, spin: 0, angle: 0, water, screw: { count, radius: R } }
  }

  /** A rain chain of copper cups hanging from a spout's lip to the pool below. */
  private buildChain(edge: Edge): void {
    const lip = edge.lipEnd!, top = edge.crest - 0.02
    const below = this.layout.pools[edge.b]
    const bottom = below.floor + 0.12
    const parts: THREE.BufferGeometry[] = []
    const x = lip[0] + edge.normal[0] * 0.05, y = lip[1] + edge.normal[1] * 0.05
    for (let z = top - 0.08, k = 0; z > bottom; z -= 0.14, k++) {
      const cup = new THREE.CylinderGeometry(0.055, 0.03, 0.07, 14, 1, true)
      cup.rotateX(Math.PI / 2)
      cup.translate(x, y, z)
      parts.push(cup)
      const ring = new THREE.TorusGeometry(0.018, 0.005, 6, 12)
      ring.rotateY(k % 2 ? Math.PI / 2 : 0)
      ring.translate(x, y, z - 0.07)
      parts.push(ring)
    }
    const hook = new THREE.TorusGeometry(0.04, 0.008, 8, 16)
    hook.translate(x, y, top)
    parts.push(hook)
    if (parts.length) this.mesh(merged(parts), this.brass, this.group, 'garden-rain-chain')
  }

  update(state: GardenState): void {
    let dt = this.previousTime === null ? 0 : state.time - this.previousTime
    if (dt < 0) dt = 0
    this.previousTime = state.time
    this.moved = false
    this.layout.tippers.forEach((tipper, i) => {
      const angle = state.tipperAngles[i] ?? TIPPER_REST
      const pivot = this.tippers[i].pivot
      if (Math.abs(pivot.rotation.y - angle) > 1e-4) this.moved = true
      pivot.rotation.y = angle
    })
    // Wheels and norias turn as the physics turns them.
    this.layout.wheels.forEach((_, i) => {
      const part = this.wheels[i], angle = state.wheelAngles[i] ?? 0
      if (Math.abs(part.pivot.rotation.y - angle) > 1e-4) this.moved = true
      part.pivot.rotation.y = angle
    })
    this.layout.lifts.forEach((lift, i) => {
      const noria = this.norias[i], angle = state.noriaAngles[i] ?? 0
      if (noria.screw) {
        const { count } = noria.screw
        if (Math.abs(noria.pivot.rotation.x - angle) > 1e-4) this.moved = true
        noria.pivot.rotation.x = angle
        noria.water.forEach((anchor, k) => {
          const fill = state.noriaPots[i * NORIA_BUCKETS + k] ?? 0
          const s = (((k + angle / (Math.PI * 2)) % count) + count) % count * SCREW_PITCH + SCREW_PITCH * 0.5
          anchor.position.set(s, 0, -lift.radius * 0.45)
          const mesh = anchor.children[0] as THREE.Mesh
          mesh.visible = fill > 0.02
          mesh.scale.set(1, 1, Math.max(0.05, fill))
        })
        return
      }
      if (Math.abs(noria.pivot.rotation.y - angle) > 1e-4) this.moved = true
      noria.pivot.rotation.y = angle
      noria.water.forEach((anchor, k) => {
        const fill = state.noriaPots[i * NORIA_BUCKETS + k] ?? 0
        const mesh = anchor.children[0] as THREE.Mesh
        mesh.visible = fill > 0.02
        // Level water in the swinging pot, settling as it empties.
        anchor.rotation.y = -angle
        mesh.scale.set(1, 1, fill)
        mesh.position.z = -NORIA_POT.depth * 0.25 * (1 - fill)
      })
    })
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    this.potWater.dispose(); this.pocketWater.dispose(); this.flightMaterial.dispose()
    this.bamboo.dispose(); this.teak.dispose(); this.bucketWater.dispose()
    this.group.clear()
  }
}
