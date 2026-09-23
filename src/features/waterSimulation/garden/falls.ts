import * as THREE from 'three'
import type { GardenLayout } from './layout'
import type { GardenState } from './simulation'
import { criticalDepth } from './geometry'
import { createCurtainMaterial, createDropletMaterial, MAX_IMPACTS, type CurtainUniforms, type GardenUniforms } from './materials'

const G = 9.81
const crestZ0 = (crest: number, h: number, lower: number) => Math.max(crest + h * 0.85, lower) + 0.006
const DROPLETS_PER_IMPACT = 36

interface Curtain {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>
  uniforms: CurtainUniforms
  travel: number
}

export interface FallTarget {
  x: number
  y: number
  z: number
  radius: number
  strength: number
}

/**
 * Every visible sheet of water — source channel and fall, spout channels and
 * falls, and the nappe over each weir — is driven by the simulated discharge
 * through that exact opening. Impacts feed foam, rings and GPU spray.
 */
export class GardenFalls {
  readonly group = new THREE.Group()
  private readonly curtains: Curtain[] = []
  private readonly geometry = new THREE.PlaneGeometry(1, 1, 12, 40)
  private readonly droplets: THREE.InstancedMesh
  private readonly dropletGeometry: THREE.BufferGeometry
  private readonly dropletMaterial: THREE.MeshStandardMaterial
  private previousTime: number | null = null
  private readonly targets: FallTarget[] = []

  constructor(private readonly layout: GardenLayout, private readonly uniforms: GardenUniforms) {
    this.group.name = 'garden-falls'
    // Two curtains for the source, two per spout, one per weir.
    const count = 2 + layout.edges.reduce((sum, edge) => sum + (edge.kind === 'spout' ? 2 : edge.kind === 'sill' ? 1 : 0), 0)
    for (let i = 0; i < count; i++) {
      const { material, uniforms: own } = createCurtainMaterial(uniforms)
      const mesh = new THREE.Mesh(this.geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      mesh.visible = false
      this.group.add(mesh)
      this.curtains.push({ mesh, uniforms: own, travel: 0 })
    }
    this.dropletGeometry = new THREE.IcosahedronGeometry(1, 1)
    const slots = new Float32Array(MAX_IMPACTS * DROPLETS_PER_IMPACT), seeds = new Float32Array(MAX_IMPACTS * DROPLETS_PER_IMPACT * 3)
    let state = 11
    const random = () => { const n = Math.sin(state++ * 91.7) * 43758.5453; return n - Math.floor(n) }
    for (let i = 0; i < slots.length; i++) {
      slots[i] = Math.floor(i / DROPLETS_PER_IMPACT)
      seeds[i * 3] = random(); seeds[i * 3 + 1] = random(); seeds[i * 3 + 2] = random()
    }
    this.dropletGeometry.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slots, 1))
    this.dropletGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3))
    this.dropletMaterial = createDropletMaterial(uniforms)
    this.droplets = new THREE.InstancedMesh(this.dropletGeometry, this.dropletMaterial, slots.length)
    this.droplets.frustumCulled = false
    this.droplets.renderOrder = 6
    this.droplets.name = 'garden-spray'
    this.group.add(this.droplets)
  }

  private sheet(index: number, start: THREE.Vector3, direction: readonly [number, number], reach: number, drop: number,
    width: number, flare: number, strength: number, aeration: number, speed: number, dt: number): void {
    const curtain = this.curtains[index]
    const visible = strength > 0.002 && reach + drop > 0.01
    curtain.mesh.visible = visible
    if (!visible) return
    const u = curtain.uniforms
    u.uStart.value.copy(start)
    u.uDirection.value.set(direction[0], direction[1])
    u.uReach.value = reach; u.uDrop.value = Math.max(0, drop)
    u.uWidth.value = width; u.uFlare.value = flare
    u.uStrength.value = strength; u.uAeration.value = aeration
    curtain.travel += dt * (0.5 + speed * 1.4)
    u.uTravel.value = curtain.travel
  }

  /** A free fall from a lip at `z` with horizontal speed `v` onto `level`. */
  private fall(index: number, x: number, y: number, z: number, direction: readonly [number, number], level: number,
    q: number, width: number, aeration: number, dt: number): void {
    const drop = Math.max(0, z - level)
    const depth = Math.max(0.01, criticalDepth(q, width))
    const velocity = THREE.MathUtils.clamp(q / (width * depth), 0.25, 2.2)
    const time = Math.sqrt(2 * drop / G)
    const reach = velocity * time
    const strength = THREE.MathUtils.smoothstep(q, 0, 0.012)
    this.sheet(index, new THREE.Vector3(x, y, z), direction, reach, drop, width * 0.96, 0.18, strength, aeration, velocity, dt)
    if (strength > 0.002 && drop > 0.03) {
      this.targets.push({ x: x + direction[0] * reach, y: y + direction[1] * reach, z: level, radius: width * 0.55, strength: Math.min(1, strength * (0.35 + drop)) })
    }
  }

  /** Glassy parts of every sheet take on the pool's tint. */
  setTint(color: THREE.Color): void {
    for (const curtain of this.curtains) curtain.uniforms.uCurtainTint.value.copy(color)
  }

  update(state: GardenState, inflow: boolean): void {
    let dt = this.previousTime === null ? 0 : state.time - this.previousTime
    if (dt < 0) { dt = 0; for (const curtain of this.curtains) curtain.travel = 0 }
    this.previousTime = state.time
    this.targets.length = 0
    const { layout } = this
    const level = (pool: number) => state.levels[pool]
    let index = 0
    // Source channel and its fall into the first pool.
    const { source } = layout
    const q0 = inflow ? state.sourceRate : 0
    const h0 = criticalDepth(q0, source.width)
    const channelStart = new THREE.Vector3(source.tower[0] + source.direction[0] * 0.2, source.tower[1] + source.direction[1] * 0.2, source.lipZ + h0)
    const channelLength = Math.hypot(source.lip[0] - channelStart.x, source.lip[1] - channelStart.y)
    this.sheet(index++, channelStart, source.direction, channelLength, 0, source.width * 0.98, 0, THREE.MathUtils.smoothstep(q0, 0, 0.012), 0.12, 0.6, dt)
    this.fall(index++, source.lip[0], source.lip[1], source.lipZ + h0 * 0.85, source.direction, level(source.pool), q0, source.width, 0.45, dt)
    for (const edge of layout.edges) {
      const q = state.discharge[edge.index]
      if (edge.kind === 'spout') {
        const flow = Math.max(0, q)
        const h = criticalDepth(flow, edge.width)
        const at = edge.points[0], end = edge.lipEnd!
        const upstream = level(edge.a)
        // Draw-down over the crest into the cantilevered channel.
        const strength = THREE.MathUtils.smoothstep(flow, 0, 0.012)
        this.sheet(index++, new THREE.Vector3(at[0], at[1], upstream - 0.004), edge.normal, Math.hypot(end[0] - at[0], end[1] - at[1]),
          Math.max(0, upstream - (edge.crest + h)), edge.width * 0.98, 0, strength, 0.1, 0.8, dt)
        this.fall(index++, end[0], end[1], edge.crest + h * 0.9, edge.normal, level(edge.b), flow, edge.width, 0.5, dt)
      } else if (edge.kind === 'sill') {
        const forward = q >= 0
        const up = forward ? edge.a : edge.b, down = forward ? edge.b : edge.a
        const direction: [number, number] = forward ? [edge.normal[0], edge.normal[1]] : [-edge.normal[0], -edge.normal[1]]
        const first = edge.points[0], last = edge.points[edge.points.length - 1]
        const mid: [number, number] = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2]
        const flow = Math.abs(q)
        const upperLevel = level(up), lowerLevel = level(down)
        const drop = upperLevel - lowerLevel
        const h = criticalDepth(flow, edge.width)
        const velocity = THREE.MathUtils.clamp(flow / (edge.width * Math.max(0.01, h)), 0.2, 1.8)
        const fallTime = Math.sqrt(2 * Math.max(0, drop) / G)
        const reach = 0.1 + velocity * Math.sqrt(2 * Math.max(0, crestZ0(edge.crest, h, lowerLevel) - lowerLevel) / G)
        const strength = THREE.MathUtils.smoothstep(flow, 0, 0.01) * THREE.MathUtils.smoothstep(drop, 0.005, 0.03)
        // The nappe leaves from the crest itself (dry weir top), so it never
        // intersects the rippling pool surfaces on either side.
        const crestZ = Math.max(edge.crest + h * 0.85, lowerLevel) + 0.006
        const start = new THREE.Vector3(mid[0], mid[1], crestZ)
        this.sheet(index++, start, direction, reach, Math.max(0, crestZ - lowerLevel + 0.02), edge.width * 0.98, 0.04, strength, THREE.MathUtils.clamp(drop * 1.5, 0, 0.35), velocity, dt)
        if (strength > 0.01 && drop > 0.03) {
          this.targets.push({ x: start.x + direction[0] * reach, y: start.y + direction[1] * reach, z: lowerLevel, radius: edge.width * 0.5, strength: Math.min(1, strength * (0.3 + drop * 1.5)) })
        }
      }
    }
    const impacts = this.uniforms.uImpacts.value, heights = this.uniforms.uImpactZ.value
    const count = Math.min(MAX_IMPACTS, this.targets.length)
    for (let i = 0; i < MAX_IMPACTS; i++) {
      const target = this.targets[i]
      if (i < count && target) { impacts[i].set(target.x, target.y, target.radius, target.strength); heights[i] = target.z }
      else { impacts[i].set(0, 0, 0.1, 0); heights[i] = -10 }
    }
    this.uniforms.uImpactCount.value = count
  }

  dispose(): void {
    this.geometry.dispose()
    for (const curtain of this.curtains) curtain.mesh.material.dispose()
    this.dropletGeometry.dispose(); this.dropletMaterial.dispose(); this.droplets.dispose()
    this.group.clear()
  }
}
