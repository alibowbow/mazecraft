import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FLOATER_KINDS, FLOATER_SPECS, type FloaterKind } from './physics/floaters'

const CAPACITY = 40

/** A part of a floater drawn as one instanced mesh (one material). */
interface Part { kind: FloaterKind; mesh: THREE.InstancedMesh }

function painted(geometry: THREE.BufferGeometry, color: (x: number, y: number, z: number) => THREE.Color): THREE.BufferGeometry {
  const position = geometry.getAttribute('position')
  const colors = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const c = color(position.getX(i), position.getY(i), position.getZ(i))
    colors.set([c.r, c.g, c.b], i * 3)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/** Geometry of each floater, in its body frame (z up, x forward). */
function floaterGeometry(kind: FloaterKind): THREE.BufferGeometry {
  const [a, b, c] = FLOATER_SPECS[kind].size
  if (kind === 'duck') {
    const yellow = new THREE.Color('#f6c630'), orange = new THREE.Color('#ee7b22'), eye = new THREE.Color('#1c1c1c')
    const body = new THREE.SphereGeometry(a, 24, 16); body.scale(1.25, 0.95, 0.8)
    const head = new THREE.SphereGeometry(a * 0.55, 20, 14); head.translate(a * 0.7, 0, a * 0.75)
    const beak = new THREE.ConeGeometry(a * 0.22, a * 0.45, 12); beak.rotateZ(-Math.PI / 2); beak.translate(a * 1.3, 0, a * 0.7)
    const tail = new THREE.ConeGeometry(a * 0.3, a * 0.5, 10); tail.rotateZ(Math.PI / 2 + 0.6); tail.translate(-a * 1.2, 0, a * 0.35)
    const eyes = [-1, 1].map(side => { const e = new THREE.SphereGeometry(a * 0.08, 8, 6); e.translate(a * 1.05, side * a * 0.25, a * 0.92); return e })
    return mergeGeometries([
      painted(body, () => yellow), painted(head, () => yellow), painted(tail, () => yellow),
      painted(beak, () => orange), ...eyes.map(e => painted(e, () => eye)),
    ].map(g => g.toNonIndexed()))!
  }
  if (kind === 'ball') {
    const stripes = ['#e84a3c', '#ffffff', '#2f7fd8', '#ffffff', '#f2c230', '#ffffff'].map(color => new THREE.Color(color))
    return painted(new THREE.SphereGeometry(a, 32, 20), (x, y) => stripes[Math.floor(((Math.atan2(y, x) / (Math.PI * 2)) + 1) * 6) % 6])
  }
  if (kind === 'leaf') {
    const green = new THREE.Color('#5f8f3a'), vein = new THREE.Color('#a9c77a')
    const leaf = new THREE.SphereGeometry(1, 28, 12); leaf.scale(a * 1.05, b * 1.1, c * 1.6)
    return painted(leaf, (_x, y) => Math.abs(y) < b * 0.08 ? vein : green)
  }
  const wood = new THREE.Color('#b07a45'), grain = new THREE.Color('#9a6536')
  const box = new THREE.BoxGeometry(a * 2, b * 2, c * 2, 4, 4, 4)
  return painted(box, (x, _y, z) => Math.sin((x + z * 0.3) * 90) > 0.6 ? grain : wood)
}

/** Draws the Rapier floaters of a garden snapshot. */
export class GardenFloaters {
  readonly group = new THREE.Group()
  private readonly parts: Part[] = []
  private readonly material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 })
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3(1, 1, 1)

  constructor() {
    this.group.name = 'garden-floaters'
    for (const kind of FLOATER_KINDS) {
      const mesh = new THREE.InstancedMesh(floaterGeometry(kind), this.material, CAPACITY)
      mesh.name = `garden-floater-${kind}`
      mesh.count = 0
      mesh.castShadow = true; mesh.receiveShadow = true
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.parts.push({ kind, mesh })
    }
  }

  update(bodies: Float32Array): boolean {
    const counts = new Map<FloaterKind, number>()
    for (let k = 0; k + 7 < bodies.length; k += 8) {
      const kind = FLOATER_KINDS[bodies[k + 7]]
      const part = this.parts.find(item => item.kind === kind)
      if (!part) continue
      const n = counts.get(kind) ?? 0
      if (n >= CAPACITY) continue
      this.position.set(bodies[k], bodies[k + 1], bodies[k + 2])
      this.rotation.set(bodies[k + 3], bodies[k + 4], bodies[k + 5], bodies[k + 6])
      part.mesh.setMatrixAt(n, this.matrix.compose(this.position, this.rotation, this.scale))
      counts.set(kind, n + 1)
    }
    let moved = false
    for (const part of this.parts) {
      const n = counts.get(part.kind) ?? 0
      if (n || part.mesh.count) moved = true
      part.mesh.count = n
      part.mesh.instanceMatrix.needsUpdate = true
    }
    return moved
  }

  dispose(): void {
    for (const part of this.parts) part.mesh.geometry.dispose()
    this.material.dispose()
  }
}
