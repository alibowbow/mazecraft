import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { GardenLayout, Tipper, Wheel } from './layout'
import type { GardenState } from './simulation'
import { criticalDepth } from './geometry'
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

/**
 * The garden's machinery: bamboo tipping tubes (shishi-odoshi) that swing
 * with the simulated load, and paddle wheels whose speed follows the flow
 * that drives them.
 */
export class GardenDevices {
  readonly group = new THREE.Group()
  private readonly tippers: Part[] = []
  private readonly wheels: (Part & { spin: number; angle: number })[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly bamboo = new THREE.MeshPhysicalMaterial({ color: 0xb49a55, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.18, sheen: 0.3, sheenColor: new THREE.Color(0xfff0c8) })
  private readonly teak = new THREE.MeshPhysicalMaterial({ color: 0x7e5334, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.25 })
  private previousTime: number | null = null
  /** Set whenever a part moved, so the caller can refresh the shadows. */
  moved = false

  constructor(private readonly layout: GardenLayout, private readonly ceramic: THREE.Material, private readonly brass: THREE.Material) {
    this.group.name = 'garden-machinery'
    for (const tipper of layout.tippers) this.tippers.push(this.buildTipper(tipper))
    for (const wheel of layout.wheels) this.wheels.push({ ...this.buildWheel(wheel), spin: 0, angle: wheel.index * 0.7 })
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
    this.layout.wheels.forEach((wheel, i) => {
      const part = this.wheels[i], edge = this.layout.edges[wheel.edge]
      const q = Math.abs(state.discharge[wheel.edge] ?? 0)
      const h = Math.max(0.01, criticalDepth(q, edge.width))
      const velocity = Math.min(2.2, q / (edge.width * h))
      // Overshot wheels are pushed down their front by the jet; undershot
      // paddles are dragged along by the flow beneath the axle.
      const target = (wheel.overshot ? 1 : -1) * velocity * 0.55 / wheel.radius * THREE.MathUtils.smoothstep(q, 0, 0.01)
      part.spin += (target - part.spin) * Math.min(1, dt * 1.2)
      part.angle += part.spin * dt
      if (Math.abs(part.spin) > 1e-3) this.moved = true
      part.pivot.rotation.y = part.angle
    })
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    this.bamboo.dispose(); this.teak.dispose()
    this.group.clear()
  }
}
