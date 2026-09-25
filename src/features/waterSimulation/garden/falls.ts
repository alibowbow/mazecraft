import * as THREE from 'three'
import type { GardenLayout } from './layout'
import type { GardenState } from './simulation'
import { criticalDepth, sourceMouth } from './geometry'
import { TIPPER_ARM, TIPPER_RADIUS, tipperPoint } from './mechanics'
import { noriaPour } from './devices'
import { PROFILE_SAMPLES, transportEdges } from './simulation'
import { createCurtainMaterial, createDropletMaterial, MAX_IMPACTS, type CurtainUniforms, type GardenUniforms } from './materials'

const G = 9.81
/**
 * Water in an open channel never stands above its walls: the same cap the
 * channel water shader uses, so every fall leaves from the water's surface.
 */
const OPEN_DEPTH = 0.13
const openDepth = (q: number, width: number) => Math.min(OPEN_DEPTH, criticalDepth(q, width))
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
    // Two curtains for the source, two per spout, one per weir, one per tipper.
    // Chutes and norias: intake (or bucket dump) plus outfall; siphons: outfall.
    const count = 2 + layout.tippers.length + layout.edges.reduce((sum, edge) => sum + (edge.kind === 'chute' || edge.kind === 'lift' ? 2 : edge.kind === 'siphon' ? 1 : 0), 0) + layout.edges.reduce((sum, edge) => sum + (edge.kind === 'spout' ? 2 : edge.kind === 'sill' ? 1 : 0), 0)
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
    width: number, flare: number, strength: number, aeration: number, speed: number, dt: number, thickness = 0.02): void {
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
    // Lip thickness and speed: the sheet thins as it accelerates (q = h·v).
    u.uThickness.value = THREE.MathUtils.clamp(thickness, 0.004, 0.045); u.uSpeed.value = Math.max(0.2, speed)
    curtain.travel += dt * (0.5 + speed * 1.4)
    u.uTravel.value = curtain.travel
  }

  /** A free fall from a lip at `z` with horizontal speed `v` onto `level`. */
  private fall(index: number, x: number, y: number, z: number, direction: readonly [number, number], level: number,
    q: number, width: number, aeration: number, dt: number, flare = 0.18): void {
    const drop = Math.max(0, z - level)
    const depth = Math.max(0.01, openDepth(q, width))
    const velocity = THREE.MathUtils.clamp(q / (width * depth), 0.25, 2.2)
    const time = Math.sqrt(2 * drop / G)
    const reach = velocity * time
    const strength = THREE.MathUtils.smoothstep(q, 0, 0.012)
    this.sheet(index, new THREE.Vector3(x, y, z), direction, reach, drop, width * 0.96, flare, strength, aeration, velocity, dt, depth)
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
    const h0 = openDepth(q0, source.width)
    // The water leaves the brass pipe mouth, drops into the channel and runs to the lip.
    const mouth = sourceMouth(layout)
    const channelStart = new THREE.Vector3(mouth.x, mouth.y, mouth.z - 0.02)
    const channelLength = Math.hypot(source.lip[0] - channelStart.x, source.lip[1] - channelStart.y)
    this.sheet(index++, channelStart, source.direction, channelLength, channelStart.z - (source.lipZ + h0), Math.min(source.width * 0.98, 0.16 + h0), 0.8, THREE.MathUtils.smoothstep(q0, 0, 0.012), 0.12, 0.6, dt, h0)
    this.fall(index++, source.lip[0], source.lip[1], source.lipZ + h0 * 0.85, source.direction, level(source.pool), q0, source.width, 0.45, dt)
    for (const edge of layout.edges) {
      const q = state.discharge[edge.index]
      if (edge.kind === 'spout') {
        const flow = Math.max(0, q)
        const h = openDepth(flow, edge.width)
        const at = edge.points[0], end = edge.lipEnd!
        const upstream = level(edge.a)
        // Draw-down over the crest into the cantilevered channel.
        const strength = THREE.MathUtils.smoothstep(flow, 0, 0.012)
        this.sheet(index++, new THREE.Vector3(at[0], at[1], upstream - 0.004), edge.normal, Math.hypot(end[0] - at[0], end[1] - at[1]),
          Math.max(0, upstream - (edge.crest + h)), edge.width * 0.98, 0, strength, 0.1, 0.8, dt, h)
        if (edge.chain) {
          // Down a rain chain: a thin, aerated trickle from cup to cup.
          const [lx, ly] = [end[0] + edge.normal[0] * 0.05, end[1] + edge.normal[1] * 0.05]
          const drop = Math.max(0, edge.crest - level(edge.b))
          this.sheet(index++, new THREE.Vector3(lx, ly, edge.crest - 0.02), edge.normal, 0.001, drop, 0.07, 0, strength, 0.85, 0.5, dt, 0.02)
          if (strength > 0.01) this.targets.push({ x: lx, y: ly, z: level(edge.b), radius: 0.12, strength: strength * 0.4 })
          continue
        }
        // A jet over a tipper lands in its raised mouth; once the tube has
        // swung down it falls straight through to the pool.
        let landing = level(edge.b)
        if (edge.tipper !== undefined) {
          const tipper = layout.tippers[edge.tipper], angle = state.tipperAngles[edge.tipper]
          if (angle > 0) landing = Math.max(landing, tipperPoint(tipper, -TIPPER_ARM * 0.8, angle)[2] + TIPPER_RADIUS * 0.4)
        }
        // A falling sheet only contracts a little on its way into the tube's
        // mouth; the rest of it splashes past the rim.
        const gather = edge.tipper !== undefined ? Math.max(-0.35, TIPPER_RADIUS * 2.2 / edge.width - 1) : 0.18
        this.fall(index++, end[0], end[1], edge.crest + h * 0.9, edge.normal, landing, flow, edge.width, edge.tipper !== undefined ? 0.2 : 0.5, dt, gather)
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
        const strength = THREE.MathUtils.smoothstep(flow, 0, 0.006) * THREE.MathUtils.smoothstep(drop, 0.005, 0.03)
        // The nappe leaves from the crest itself (dry weir top), so it never
        // intersects the rippling pool surfaces on either side.
        const crestZ = Math.max(edge.crest + h * 0.85, lowerLevel) + 0.006
        const start = new THREE.Vector3(mid[0], mid[1], crestZ)
        this.sheet(index++, start, direction, reach, Math.max(0, crestZ - lowerLevel + 0.02), edge.width * 0.98, 0.04, strength, THREE.MathUtils.clamp(drop * 1.5, 0, 0.35), velocity, dt, h)
        if (strength > 0.01 && drop > 0.03) {
          this.targets.push({ x: start.x + direction[0] * reach, y: start.y + direction[1] * reach, z: lowerLevel, radius: edge.width * 0.5, strength: Math.min(1, strength * (0.3 + drop * 1.5)) })
        }
      }
    }
    // Each tipper's surge pours from its mouth, back under the spout.
    for (const tipper of layout.tippers) {
      const i = tipper.index, pour = state.tipperPours[i], angle = state.tipperAngles[i]
      const [x, y, z] = tipperPoint(tipper, -TIPPER_ARM, angle, -TIPPER_RADIUS * 0.6)
      const strength = THREE.MathUtils.smoothstep(pour, 0, 0.008)
      const back: [number, number] = [-tipper.direction[0], -tipper.direction[1]]
      const lower = level(tipper.pool)
      const drop = Math.max(0, z - lower)
      const reach = 0.04 + Math.min(0.9, pour / (TIPPER_RADIUS * 2 * 0.06)) * 0.02
      this.sheet(index++, new THREE.Vector3(x, y, z), back, reach, drop, TIPPER_RADIUS * 1.7, 0.9, strength, 0.55, 1.2, dt, TIPPER_RADIUS * 0.4)
      if (strength > 0.01) this.targets.push({ x: x + back[0] * reach, y: y + back[1] * reach, z: lower, radius: 0.32, strength: Math.min(1, strength * (0.5 + drop)) })
    }
    // Chutes, noria troughs and siphons.
    transportEdges(layout).forEach((edge, row) => {
      const path = edge.path!, first = path[0], last = path[path.length - 1], before = path[path.length - 2]
      const arriving = Math.max(0, state.channelFlow[row * PROFILE_SAMPLES + PROFILE_SAMPLES - 1])
      const width = edge.kind === 'lift' ? layout.lifts[edge.lift!].width * 0.9 : edge.width
      if (edge.kind === 'chute') {
        const q = Math.max(0, state.discharge[edge.index]), at = edge.points[0], upstream = level(edge.a)
        const h = openDepth(q, width)
        this.sheet(index++, new THREE.Vector3(at[0], at[1], upstream - 0.004), edge.normal, Math.hypot(first[0] - at[0], first[1] - at[1]),
          Math.max(0, upstream - (edge.crest + h)), width * 0.98, 0, THREE.MathUtils.smoothstep(q, 0, 0.012), 0.1, 0.8, dt, h)
      } else {
        // Pots turning over the top of the wheel pour straight down into the
        // trough that runs beneath their path.
        const lift = layout.lifts[edge.lift!], load = Math.max(0, state.liftLoads[edge.lift!])
        const pour = noriaPour(lift)
        const back: [number, number] = [-lift.direction[0], -lift.direction[1]]
        this.sheet(index++, new THREE.Vector3(pour.x, pour.y, pour.z), back, 0.06, Math.max(0, pour.z - first[2] - 0.02),
          0.2, 0.35, THREE.MathUtils.smoothstep(load, 0, 0.02), 0.35, 1.0, dt, 0.04)
        if (load > 0.005) this.targets.push({ x: pour.x, y: pour.y, z: first[2] + 0.02, radius: 0.18, strength: Math.min(1, load * 20) })
      }
      const dx = last[0] - before[0], dy = last[1] - before[1], l = Math.hypot(dx, dy) || 1
      // Leaving the open end the stream pulls in from the walls and aerates.
      this.fall(index++, last[0], last[1], last[2] + openDepth(arriving, width) * 0.9, [dx / l, dy / l], level(edge.b), arriving, width * 0.8, 0.65, dt, -0.22)
    })
    for (const siphon of layout.siphons) {
      const edge = layout.edges[siphon.edge], q = Math.max(0, state.discharge[edge.index])
      const mouth = siphon.path[siphon.path.length - 1]
      // A full-bore jet straight down out of the pipe mouth.
      this.sheet(index++, new THREE.Vector3(mouth[0], mouth[1], mouth[2]), edge.normal, 0.02, Math.max(0, mouth[2] - level(edge.b)),
        siphon.diameter * 0.6, 0.5, THREE.MathUtils.smoothstep(q, 0, 0.02), 0.7, 1.6, dt, siphon.diameter * 0.35)
      if (q > 0.01) this.targets.push({ x: mouth[0], y: mouth[1], z: level(edge.b), radius: siphon.diameter * 1.4, strength: Math.min(1, q * 5) })
    }
    const drain = layout.edges.find(edge => edge.kind === 'drain')
    if (drain) {
      const rate = Math.max(0, state.discharge[drain.index])
      this.uniforms.uDrain.value.set(drain.points[0][0], drain.points[0][1], level(drain.a), THREE.MathUtils.smoothstep(rate, 0, 0.03))
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
