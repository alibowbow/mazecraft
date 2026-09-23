import * as THREE from 'three'
import { SurfaceTrackball } from '../freeSurface/camera3d'
import { StudioShadows } from '../freeSurface/studioLighting'
import type { BasinSnapshot } from '../freeSurface/basinSimulation'
import type { WaterAppearance } from '../freeSurface/appearance'
import { DEFAULT_WATER_LOOK, normalizeWaterLook, WATER_LIGHTS, type WaterLook, type WaterTheme } from '../freeSurface/lookdev'
import type { GardenId } from './designs'
import { gardenLayout, type GardenLayout } from './layout'
import { FAR, gardenField } from './flowField'
import { buildGardenSolids } from './geometry'
import { createCeramicMaterial, createGardenUniforms, createGroundMaterial, createWallDepthMaterial, createWaterMaterial, type GardenUniforms } from './materials'
import { GardenFalls } from './falls'
import { GardenPlants } from './plants'
import { GardenDevices } from './devices'
import { GardenChannels } from './channels'
import { createGardenSky } from './environment'
import { PROFILE_SAMPLES, transportEdges, type GardenSnapshot } from './simulation'
import { resample } from './geometry'

interface Glaze { glaze: string; bed: string; roughness: number; clearcoat: number; clearcoatRoughness: number; sheen: number }

/** Glaze recipes per collection colour: real ceramic tones, not flat plastic. */
export const GARDEN_GLAZES: Record<WaterTheme, Glaze> = {
  porcelain: { glaze: '#efe8dc', bed: '#f3eee4', roughness: 0.44, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.12 },
  glacier: { glaze: '#a9d0e2', bed: '#e3f1f6', roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.03, sheen: 0.15 },
  terrace: { glaze: '#c6724e', bed: '#e8c3a6', roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.4, sheen: 0.35 },
  sage: { glaze: '#98c2a3', bed: '#e7f1e8', roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.2 },
  basalt: { glaze: '#34528f', bed: '#dde5f2', roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.04, sheen: 0.12 },
}

const LIGHTING = {
  daylight: { background: '#efe5d6', ground: '#d9c3a3', intensity: 4.2, sky: 1.0, warmth: 0.2, exposure: 1.0 },
  golden: { background: '#f0dcc4', ground: '#d8bc97', intensity: 3.8, sky: 0.95, warmth: 0.85, exposure: 1.02 },
  studio: { background: '#ebe8e3', ground: '#d6cec2', intensity: 3.2, sky: 1.15, warmth: 0.0, exposure: 1.0 },
} as const

/**
 * An authored water garden: glazed ceramic labyrinth basins, pools at their
 * simulated levels, falls and spray driven by the simulated discharge, sand
 * ground with dappled shade, planting, and a daylight sky for reflections.
 */
export class GardenPresentation3D {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120)
  readonly target = new THREE.Vector3()
  readonly viewSize = new THREE.Vector2(1, 1)
  readonly viewDirection = new THREE.Vector3(0, 0, 1)
  readonly content = new THREE.Group()
  readonly toneMapping = THREE.NeutralToneMapping
  exposure = 1.0
  readonly layout: GardenLayout
  private readonly uniforms: GardenUniforms
  private readonly wallMaterial: THREE.MeshPhysicalMaterial
  private readonly bedMaterial: THREE.MeshPhysicalMaterial
  private readonly trimMaterial: THREE.MeshPhysicalMaterial
  private readonly waterMaterial: THREE.MeshPhysicalMaterial
  private readonly groundMaterial: THREE.MeshStandardMaterial
  private readonly groundBackground: THREE.IUniform<THREE.Color>
  private readonly soilMaterial = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 })
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly falls: GardenFalls
  private readonly plants: GardenPlants
  private readonly devices: GardenDevices
  private readonly channels: GardenChannels
  private shadowFrame = 0
  private readonly sun = new THREE.DirectionalLight(0xfff4e2, 3)
  private readonly sky = new THREE.HemisphereLight(0xdfeeff, 0xd9c6a8, 0.0)
  private readonly shadows = new StudioShadows()
  private readonly center: THREE.Vector3
  private readonly extent: THREE.Vector3
  private environment: THREE.WebGLRenderTarget | null = null
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
  private lightKey = ''
  private inflow = true
  private state: GardenSnapshot['garden'] | null = null
  /** Camera that travels with the water: smoothed focus and framing height. */
  private follow = false
  private readonly focus = new THREE.Vector3()
  /** Where the tracking camera is gliding to. */
  private readonly desired = new THREE.Vector3()
  private focusHeight = 0
  private focusTime: number | null = null
  private view: { width: number; height: number; zoom: number; panX: number; panY: number; orientation: THREE.Quaternion } | null = null
  /** Per pool: bed cells sorted by wetting key, to find the tip of a front. */
  private readonly frontCells: { keys: Float32Array; points: Float32Array }[]
  private readonly channelPaths: [number, number, number][][]
  /** When each pool / channel first took water, to follow the newest arrival. */
  private readonly started: Float64Array
  private disposed = false

  constructor(id: GardenId, private readonly renderer: THREE.WebGLRenderer) {
    const layout = this.layout = gardenLayout(id)
    this.scene.name = `water-garden-${id}`
    this.uniforms = createGardenUniforms(gardenField(layout))
    layout.pools.forEach((pool, i) => { this.uniforms.uFloors.value[i] = pool.floor })
    const { bounds } = layout
    this.center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, layout.height * 0.35)
    this.extent = new THREE.Vector3(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, layout.height)
    const plan = gardenField(layout)
    const perPool: { key: number; x: number; y: number }[][] = layout.pools.map(() => [])
    for (let i = 0; i < plan.entry.length; i++) {
      const key = plan.entry[i], owner = plan.data[i * 4 + 3] - 1
      if (owner < 0 || key >= FAR || i % 2) continue
      const cx = i % plan.width, cy = Math.floor(i / plan.width)
      perPool[owner]?.push({ key, x: plan.bounds[0] + (cx + 0.5) * plan.cell, y: plan.bounds[1] + (cy + 0.5) * plan.cell })
    }
    this.frontCells = perPool.map(list => {
      list.sort((a, b) => a.key - b.key)
      return { keys: Float32Array.from(list, cell => cell.key), points: Float32Array.from(list.flatMap(cell => [cell.x, cell.y])) }
    })
    this.channelPaths = transportEdges(layout).map(edge => resample(edge.path!, 0.1).map(p => [p[0], p[1], p[2]] as [number, number, number]))
    this.started = new Float64Array(layout.pools.length + this.channelPaths.length).fill(-1)

    this.wallMaterial = createCeramicMaterial(this.uniforms, 'wall')
    this.bedMaterial = createCeramicMaterial(this.uniforms, 'bed')
    this.trimMaterial = createCeramicMaterial(this.uniforms, 'trim')
    this.waterMaterial = createWaterMaterial(this.uniforms)
    const radius = Math.max(this.extent.x, this.extent.y) * 0.5
    const ground = createGroundMaterial(this.uniforms, new THREE.Vector2(this.center.x, this.center.y), radius + 1.5)
    this.groundMaterial = ground.material
    this.groundBackground = ground.background
    const wallDepth = createWallDepthMaterial(this.uniforms)
    this.materials.push(this.wallMaterial, this.bedMaterial, this.trimMaterial, this.waterMaterial, this.groundMaterial, this.soilMaterial, wallDepth)

    const solids = buildGardenSolids(layout)
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string, cast = true) => {
      const result = new THREE.Mesh(geometry, material)
      result.name = name; result.castShadow = cast; result.receiveShadow = true
      this.geometries.push(geometry)
      this.content.add(result)
      return result
    }
    const walls = mesh(solids.walls, this.wallMaterial, 'garden-glazed-walls')
    walls.customDepthMaterial = wallDepth
    walls.frustumCulled = false
    mesh(solids.beds, this.bedMaterial, 'garden-glazed-beds', false)
    mesh(solids.trim, this.trimMaterial, 'garden-spouts-and-tower')
    if (solids.planterSoil) mesh(solids.planterSoil, this.soilMaterial, 'garden-planter-soil', false)
    const brass = new THREE.MeshPhysicalMaterial({ color: 0xc08a4e, metalness: 1, roughness: 0.28, clearcoat: 0.3, envMapIntensity: 1.2 })
    const opening = new THREE.MeshBasicMaterial({ color: 0x0b1416, side: THREE.DoubleSide })
    this.materials.push(brass, opening)
    mesh(solids.brass, brass, 'garden-brass-pipe-and-drains')
    mesh(solids.openings, opening, 'garden-pipe-bore-and-drain-holes', false)
    const water = mesh(solids.water, this.waterMaterial, 'garden-pool-water', false)
    water.receiveShadow = false
    water.frustumCulled = false
    water.renderOrder = 2

    const groundGeometry = new THREE.PlaneGeometry(radius * 8 + 20, radius * 8 + 20)
    const groundMesh = new THREE.Mesh(groundGeometry, this.groundMaterial)
    groundMesh.name = 'garden-sand-ground'
    groundMesh.position.set(this.center.x, this.center.y, 0)
    groundMesh.receiveShadow = true
    this.geometries.push(groundGeometry)
    this.scene.add(groundMesh)

    this.devices = new GardenDevices(layout, this.trimMaterial, brass)
    this.content.add(this.devices.group)
    this.channels = new GardenChannels(layout, this.uniforms)
    this.content.add(this.channels.mesh)
    this.falls = new GardenFalls(layout, this.uniforms)
    this.content.add(this.falls.group)
    this.plants = new GardenPlants()
    const field = this.uniforms.uGardenField.value.image as { data: Uint8Array; width: number; height: number }
    const clearance = (x: number, y: number) => {
      const [x0, y0, w, h] = this.uniforms.uGardenBounds.value.toArray()
      const cx = Math.floor((x - x0) / w * field.width), cy = Math.floor((y - y0) / h * field.height)
      if (cx < 0 || cy < 0 || cx >= field.width || cy >= field.height) return 2
      const b = field.data[(cy * field.width + cx) * 4 + 2] / 255
      return b >= 0.5 ? (b - 0.5) * 4 : 0
    }
    layout.design.plants.forEach((plant, i) => {
      // Keep planting clear of every basin, spout and receiving trough.
      let [x, y] = plant.at
      const dx = x - this.center.x, dy = y - this.center.y, length = Math.hypot(dx, dy) || 1
      for (let step = 0; step < 40 && clearance(x, y) < 0.35 + (plant.kind === 'stones' ? 0.1 : 0.25) * plant.scale; step++) {
        x += dx / length * 0.15; y += dy / length * 0.15
      }
      this.plants.add(plant.kind, x, y, plant.z ?? 0, plant.scale, 17 + i * 31)
    })
    for (const vessel of layout.vessels) vessel.spec.planters.forEach((at, i) => this.plants.add('rosemary', at[0], at[1], vessel.top - 0.04, 0.55, 5 + i * 13))
    this.plants.build()
    this.content.add(this.plants.group)
    this.scene.add(this.content)

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.00025
    this.sun.shadow.normalBias = 0.03
    this.sun.shadow.autoUpdate = false
    this.scene.add(this.sun, this.sun.target, this.sky)
    this.shadows.apply(this.scene)
    this.setLook(this.look)
    this.updateView(1, 1, 1, 0, 0, new SurfaceTrackball().orientation)
  }

  addFunnel(_group: THREE.Group): void {}

  /**
   * Compile every shader up front, in parallel where the driver allows, so
   * the first frame and the first falls never stall the page. Hidden parts
   * (falls, spray, bucket water) are shown just long enough to be compiled.
   */
  async warmUp(): Promise<void> {
    const renderer = this.renderer
    const hidden: THREE.Object3D[] = []
    this.scene.traverse(object => { if (!object.visible) { hidden.push(object); object.visible = true } })
    const shadows = renderer.shadowMap.enabled, toneMapping = renderer.toneMapping
    renderer.shadowMap.enabled = true
    renderer.toneMapping = this.toneMapping
    let pending: Promise<unknown>
    try { pending = renderer.compileAsync(this.scene, this.camera) } finally {
      renderer.shadowMap.enabled = shadows
      renderer.toneMapping = toneMapping
      for (const object of hidden) object.visible = false
    }
    await pending
  }

  setLook(next: Partial<WaterLook>): void {
    if (this.disposed) return
    this.look = normalizeWaterLook(next, this.look)
    const glaze = GARDEN_GLAZES[this.look.theme] ?? GARDEN_GLAZES.porcelain
    for (const material of [this.wallMaterial, this.trimMaterial]) {
      material.color.set(this.look.wallColor ?? glaze.glaze)
      material.roughness = glaze.roughness
      material.clearcoat = glaze.clearcoat
      material.clearcoatRoughness = glaze.clearcoatRoughness
      material.sheen = glaze.sheen
    }
    this.bedMaterial.color.set(glaze.bed)
    this.bedMaterial.roughness = Math.min(0.7, glaze.roughness + 0.08)
    this.bedMaterial.clearcoat = glaze.clearcoat * 0.55
    this.uniforms.uWallScale.value = 1 + Math.max(0, this.look.wallHeight - 1) * 0.8
    const light = WATER_LIGHTS[this.look.light], mood = LIGHTING[this.look.light]
    const direction = new THREE.Vector3(...light.direction).normalize()
    this.sun.color.set(light.color)
    this.sun.intensity = mood.intensity
    this.sun.position.copy(this.center).addScaledVector(direction, 30)
    this.sun.target.position.copy(this.center)
    this.sun.target.updateMatrixWorld()
    this.sky.color.set(light.sky); this.sky.groundColor.set(mood.ground)
    this.uniforms.uSunDirection.value.copy(direction)
    this.exposure = mood.exposure
    this.groundMaterial.color.set(mood.ground)
    this.groundBackground.value.set(mood.background).convertLinearToSRGB()
    this.scene.background = new THREE.Color(mood.background)
    this.scene.environmentIntensity = mood.sky
    const key = this.look.light
    if (key !== this.lightKey) {
      this.lightKey = key
      this.environment?.dispose()
      this.environment = createGardenSky(this.renderer, { sun: [direction.x, direction.y, direction.z], sunColor: new THREE.Color(light.color), warmth: mood.warmth })
      this.scene.environment = this.environment.texture
    }
    this.fitShadow()
    this.shadows.update(this.sun)
    this.sun.shadow.needsUpdate = true
    this.renderer.shadowMap.needsUpdate = true
  }

  private fitShadow(): void {
    this.sun.updateMatrixWorld()
    this.sun.shadow.updateMatrices(this.sun)
    const camera = this.sun.shadow.camera
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    const { bounds } = this.layout
    for (const x of [bounds.minX - 2.6, bounds.maxX + 2.6]) for (const y of [bounds.minY - 2.6, bounds.maxY + 2.6]) for (const z of [0, this.layout.height + 1.6]) {
      box.expandByPoint(point.set(x, y, z).applyMatrix4(camera.matrixWorldInverse))
    }
    Object.assign(camera, { left: box.min.x, right: box.max.x, bottom: box.min.y, top: box.max.y, near: Math.max(0.1, -box.max.z - 1), far: -box.min.z + 1 })
    camera.updateProjectionMatrix()
  }

  setAppearance(appearance: WaterAppearance): void {
    const opacity = THREE.MathUtils.clamp(Number.isFinite(appearance.opacity) ? appearance.opacity : 0.72, 0.1, 0.9)
    const water = this.waterMaterial
    if (!appearance.color) {
      water.attenuationColor.set('#e4f4f1')
      water.attenuationDistance = 2.2 + (1 - opacity) * 3
    } else if (appearance.profile === 'aqua') {
      water.attenuationColor.set('#23bccb')
      water.attenuationDistance = 0.36 + (1 - opacity) * 0.8
    } else {
      water.attenuationColor.set(appearance.color).lerp(new THREE.Color(0xffffff), 0.18)
      water.attenuationDistance = 0.3 + (1 - opacity) * 1.1
    }
    // Thin sheets transmit most light: a pale version of the pool colour.
    this.falls.setTint(water.attenuationColor.clone().lerp(new THREE.Color(0xffffff), 0.55))
    this.channels.setTint(water.attenuationColor.clone().lerp(new THREE.Color(0xffffff), 0.4))
  }

  setInflow(enabled: boolean): void {
    this.inflow = enabled
    if (this.state) this.falls.update(this.state, enabled)
  }

  setBasinSnapshot(snapshot: BasinSnapshot): void {
    if (this.disposed || !('garden' in snapshot)) return
    const state = this.state = (snapshot as GardenSnapshot).garden
    const levels = this.uniforms.uLevels.value, flow = this.uniforms.uPoolFlow.value, fronts = this.uniforms.uFront.value
    this.layout.pools.forEach((pool, i) => {
      levels[i] = state.levels[i]
      fronts[i] = state.fronts[i] >= FAR ? 1e5 : state.fronts[i]
      const depth = Math.max(0.05, state.levels[i] - pool.floor)
      // Mean channel speed: through-flow over a typical channel section.
      flow[i] = THREE.MathUtils.clamp(state.throughflow[i] / (0.8 * depth) * 1.6, 0, 0.9)
    })
    // One eased current for the whole garden: the route field already calms
    // side bays, and ripples keep one speed across every step.
    let sum = 0, wet = 0
    this.layout.pools.forEach((_, i) => { if (state.fronts[i] >= 0) { sum += flow[i]; wet++ } })
    const mean = wet ? sum / wet : 0
    this.uniforms.uFlowMean.value += (mean - this.uniforms.uFlowMean.value) * 0.05
    this.uniforms.uGardenTime.value = state.time
    this.trackWater(state)
    this.falls.update(state, this.inflow)
    this.devices.update(state)
    this.channels.update(state)
    // Moving machinery casts moving shadows: refresh them at a gentle rate.
    if (this.devices.moved && ++this.shadowFrame % 3 === 0) {
      this.sun.shadow.needsUpdate = true
      this.renderer.shadowMap.needsUpdate = true
    }
  }

  updateWater(time: number, style: number): void {
    this.uniforms.uGardenStyle.value = style
    if (!this.state) this.uniforms.uGardenTime.value = time
  }

  /** Follow the water (on by default): the camera travels with the newest arrival. */
  setFollow(enabled: boolean): void {
    // Tracking starts from the garden's centre and closes in on the water.
    if (enabled && !this.follow) { this.focus.copy(this.center); this.desired.copy(this.center) }
    this.follow = enabled
    this.focusHeight = enabled ? 1 : 0
    this.applyView()
  }

  /**
   * The newest stretch of the course the water is working through: the tip
   * of a spreading front, or the head of water running down a channel.
   * Returns null once the whole course runs steadily.
   */
  private waterHead(state: GardenSnapshot['garden']): THREE.Vector3 | null {
    // The newest stretch the water has reached; once it runs steadily the
    // camera eases back out, even if older side bays are still wetting.
    let newest = -1, head: THREE.Vector3 | null = null
    const time = state.time
    this.layout.pools.forEach((pool, i) => {
      const front = state.fronts[i]
      if (front < 0) return
      if (this.started[i] < 0) this.started[i] = time
      if (this.started[i] < newest) return
      newest = this.started[i]
      head = null
      const cells = this.frontCells[i]
      if (front >= FAR || !cells.keys.length) return
      let low = 0, high = cells.keys.length - 1
      while (low < high) { const mid = (low + high + 1) >> 1; if (cells.keys[mid] <= front) low = mid; else high = mid - 1 }
      head = new THREE.Vector3(cells.points[low * 2], cells.points[low * 2 + 1], state.levels[i])
    })
    this.channelPaths.forEach((path, c) => {
      const slot = this.layout.pools.length + c
      let reach = -1
      for (let s = 0; s < PROFILE_SAMPLES; s++) if (state.channelFlow[c * PROFILE_SAMPLES + s] > 0.002) reach = s
      if (reach < 0) return
      if (this.started[slot] < 0) this.started[slot] = time
      if (this.started[slot] < newest) return
      newest = this.started[slot]
      head = null
      if (reach >= PROFILE_SAMPLES - 1) return
      const point = path[Math.round(reach / (PROFILE_SAMPLES - 1) * (path.length - 1))]
      head = new THREE.Vector3(point[0], point[1], point[2])
    })
    return head
  }

  private trackWater(state: GardenSnapshot['garden']): void {
    if (state.time < 1e-6 || (this.state && state.fronts.every(front => front < 0))) this.started.fill(-1)
    const now = performance.now() / 1000
    const dt = this.focusTime === null ? 0 : Math.min(0.25, Math.max(0, now - this.focusTime))
    this.focusTime = now
    if (!this.follow) { this.applyView(); return }
    const head = this.waterHead(state)
    if (head) {
      // Dead zone: the camera only moves once the water leaves the middle of
      // the frame, then glides just far enough to keep it there. Small jumps
      // of the wetting front never shake the view.
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)
      const offset = head.clone().sub(this.desired)
      const zoneX = this.viewSize.x * 0.22, zoneY = this.viewSize.y * 0.2
      const dx = offset.dot(right), dy = offset.dot(up)
      this.desired.addScaledVector(right, dx - THREE.MathUtils.clamp(dx, -zoneX, zoneX))
      this.desired.addScaledVector(up, dy - THREE.MathUtils.clamp(dy, -zoneY, zoneY))
    }
    this.focus.lerp(this.desired, 1 - Math.exp(-dt / 1.1))
    this.applyView()
  }

  private applyView(): void {
    if (!this.view) return
    const { width, height, zoom, panX, panY, orientation } = this.view
    this.frame(width, height, zoom, panX, panY, orientation)
  }

  updateView(width: number, height: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    this.view = { width, height, zoom, panX, panY, orientation: orientation.clone() }
    this.frame(width, height, zoom, panX, panY, orientation)
  }

  private frame(width: number, height: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    if (this.disposed) return
    const aspect = Math.max(1, width) / Math.max(1, height)
    // Frame the whole garden as seen from the default angle; the framing
    // stays fixed while the user orbits so rotation never rescales it.
    const basis = new THREE.Matrix4().makeRotationFromQuaternion(new SurfaceTrackball().orientation.invert()).elements
    const w = this.extent.x + 0.6, d = this.extent.y + 0.6, h = this.extent.z
    const frontWidth = Math.abs(basis[0]) * w + Math.abs(basis[4]) * d + Math.abs(basis[8]) * h
    const frontHeight = Math.abs(basis[1]) * w + Math.abs(basis[5]) * d + Math.abs(basis[9]) * h
    const overview = Math.max(frontHeight * 0.9, frontWidth * 0.94 / aspect)
    // Following: close in around the travelling water, then ease back out.
    const close = THREE.MathUtils.clamp(this.focusHeight, 0, 1)
    const near = Math.min(overview, Math.max(overview * 0.55, 6.5, 5.2 / aspect))
    const viewHeight = THREE.MathUtils.lerp(overview, near, close) / Math.max(0.1, zoom)
    this.viewSize.set(viewHeight * aspect, viewHeight)
    const offset = new THREE.Vector3(panX, panY, 0).applyQuaternion(orientation)
    this.target.copy(this.center).lerp(this.focus, close).add(offset)
    this.viewDirection.set(0, 0, 1).applyQuaternion(orientation)
    this.camera.left = -this.viewSize.x / 2; this.camera.right = this.viewSize.x / 2
    this.camera.top = viewHeight / 2; this.camera.bottom = -viewHeight / 2
    const distance = Math.hypot(this.extent.x, this.extent.y, this.extent.z) + 30
    this.camera.near = 0.1; this.camera.far = distance * 2.2
    this.camera.position.copy(this.target).addScaledVector(this.viewDirection, distance)
    this.camera.quaternion.copy(orientation)
    this.camera.up.set(0, 1, 0).applyQuaternion(orientation)
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.falls.dispose(); this.plants.dispose(); this.devices.dispose(); this.channels.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    for (const uniform of [this.uniforms.uGardenField, this.uniforms.uGardenEntry, this.uniforms.uRipplesA, this.uniforms.uRipplesB, this.uniforms.uLeafShade]) uniform.value.dispose()
    this.environment?.dispose()
    this.sun.shadow.dispose()
    this.scene.clear()
  }
}
