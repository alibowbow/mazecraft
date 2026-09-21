import * as THREE from 'three'
import type { FluidLayout, FluidWall } from './types'
import { SurfaceTrackball } from './camera3d'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { SculptedSurface } from './sculptedSurface'
import type { WaterAppearance } from './appearance'
import { DEFAULT_WATER_LOOK, getWaterTheme, normalizeWaterLook, WATER_LIGHTS, type WaterLook } from './lookdev'

// Particle centers stop at the solver bounds, but their optical footprints can
// extend .392 cells farther. Preserve the whole silhouette at the board edge.
export const SURFACE_FIELD_PADDING = 0.42

/** Join exact collinear physical rectangles, keeping all openings unchanged. */
function continuousWalls(input: readonly FluidWall[]): FluidWall[] {
  const runs = new Map<string, FluidWall[]>()
  for (const wall of input) {
    if (wall.kind === 'funnel') continue
    const horizontal = wall.x1 - wall.x0 >= wall.y1 - wall.y0
    const key = horizontal ? `h:${wall.y0}:${wall.y1}` : `v:${wall.x0}:${wall.x1}`
    const group = runs.get(key) ?? []
    group.push({ ...wall })
    runs.set(key, group)
  }
  const result: FluidWall[] = []
  for (const [key, run] of runs) {
    const start = key[0] === 'h' ? 'x0' : 'y0'
    const end = key[0] === 'h' ? 'x1' : 'y1'
    run.sort((a, b) => a[start] - b[start])
    let current = run[0]
    for (let i = 1; i < run.length; i++) {
      if (run[i][start] <= current[end] + 1e-7) current[end] = Math.max(current[end], run[i][end])
      else { result.push(current); current = run[i] }
    }
    result.push(current)
  }
  return result
}

/** Keep bevel width in world units even on long instanced wall runs. */
function fixedWidthBevel(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      #include <beginnormal_vertex>
      #ifdef USE_INSTANCING
        vec2 wallBevelScale = max(vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz)), vec2(0.001));
        objectNormal.xy *= wallBevelScale;
      #endif
    `).replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        transformed.xy = sign(position.xy) * (vec2(0.5) - (vec2(0.5) - abs(position.xy)) / max(vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz)), vec2(0.001)));
      #endif
    `)
  }
  material.customProgramCacheKey = () => 'water-studio-fixed-bevel-v1'
}

/**
 * A camera and physical board for the existing vertical free-surface solver.
 * The supplied texture is the continuous field over the padded layout bounds;
 * this class neither simulates water nor advances an animation clock.
 */
export class FreeSurfacePresentation3D {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  /** Accessory geometry is owned by its caller, even when added to this group. */
  readonly content = new THREE.Group()
  readonly target = new THREE.Vector3()
  readonly viewSize = new THREE.Vector2(1, 1)
  /** Constant fragment-to-eye direction of this orthographic board camera. */
  readonly viewDirection = new THREE.Vector3(0, 0, 1)

  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly instances: THREE.InstancedMesh[] = []
  private readonly centerX: number
  private readonly centerY: number
  private readonly boardWidth: number
  private readonly boardHeight: number
  private readonly distance: number
  private readonly screenOffset = new THREE.Vector3()
  private readonly wallTop = new THREE.MeshPhysicalMaterial({ clearcoat: 0.38, clearcoatRoughness: 0.28 })
  private readonly wallSide = new THREE.MeshPhysicalMaterial({ clearcoat: 0.22, clearcoatRoughness: 0.32 })
  private readonly groundMaterial = new THREE.MeshBasicMaterial({ toneMapped: false })
  private readonly sculpted: SculptedSurface
  private readonly environment: THREE.WebGLRenderTarget | null
  private readonly renderer?: THREE.WebGLRenderer
  private readonly ambient = new THREE.HemisphereLight()
  private readonly key = new THREE.DirectionalLight()
  private readonly fill = new THREE.DirectionalLight()
  private readonly wallMesh: THREE.InstancedMesh
  private readonly walls: FluidLayout['walls']
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
  private disposed = false

  constructor(layout: FluidLayout, texture: THREE.Texture, renderer?: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.environment = null
    if (renderer) {
      const room = new RoomEnvironment()
      const pmrem = new THREE.PMREMGenerator(renderer)
      this.environment = pmrem.fromScene(room, 0.04)
      this.scene.environment = this.environment.texture
      this.scene.environmentIntensity = 0.48
      room.dispose(); pmrem.dispose()
    }
    this.boardWidth = layout.maxX - layout.minX + 2 * SURFACE_FIELD_PADDING
    this.boardHeight = layout.maxY - layout.minY + 2 * SURFACE_FIELD_PADDING
    this.centerX = (layout.minX + layout.maxX) * 0.5
    this.centerY = -(layout.minY + layout.maxY) * 0.5
    this.distance = Math.hypot(this.boardWidth, this.boardHeight) * 1.6 + 4
    this.content.name = 'free-surface-3d-board'
    this.scene.add(this.content)

    this.sculpted = new SculptedSurface(layout, texture, new THREE.Vector4(
      layout.minX - SURFACE_FIELD_PADDING, -layout.maxY - SURFACE_FIELD_PADDING,
      this.boardWidth, this.boardHeight,
    ))
    this.content.add(this.sculpted.body, this.sculpted.foundation, this.sculpted.water)

    // One reusable beveled unit box, with exact [-.5, .5] x/y and [0, 1] z
    // bounds. Instancing keeps even the largest maze at a constant draw count.
    const roundedWall = new RoundedBoxGeometry(1, 1, 1, 3, 0.042)
    const faceVertices = roundedWall.attributes.position.count / 6
    roundedWall.clearGroups()
    roundedWall.addGroup(0, faceVertices * 4, 1)
    roundedWall.addGroup(faceVertices * 4, faceVertices * 2, 0)
    roundedWall.translate(0, 0, 0.5)
    const wallGeometry = mergeVertices(roundedWall)
    roundedWall.dispose()
    fixedWidthBevel(this.wallTop)
    fixedWidthBevel(this.wallSide)
    const walls = continuousWalls(layout.walls)
    this.walls = walls
    const wallMesh = this.wallMesh = new THREE.InstancedMesh(wallGeometry, [this.wallTop, this.wallSide], walls.length)
    wallMesh.name = 'extruded-maze-walls'
    wallMesh.castShadow = true; wallMesh.receiveShadow = true
    const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    fixedWidthBevel(depthMaterial)
    wallMesh.customDepthMaterial = depthMaterial
    this.materials.push(depthMaterial)
    this.content.add(wallMesh)
    this.instances.push(wallMesh)
    this.geometries.push(wallGeometry)
    this.materials.push(this.wallTop, this.wallSide)

    const groundGeometry = new THREE.PlaneGeometry(this.boardWidth * 12, this.boardHeight * 12)
    const ground = new THREE.Mesh(groundGeometry, this.groundMaterial)
    ground.position.set(this.centerX, this.centerY, -0.70)
    const groundShadowMaterial = new THREE.ShadowMaterial({ opacity: 0.18 })
    const groundShadow = new THREE.Mesh(groundGeometry, groundShadowMaterial)
    groundShadow.position.copy(ground.position); groundShadow.position.z += 0.002
    groundShadow.receiveShadow = true
    this.scene.add(groundShadow); this.materials.push(groundShadowMaterial)
    ground.name = 'matte-studio-ground'
    this.scene.add(ground)
    this.geometries.push(groundGeometry); this.materials.push(this.groundMaterial)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(1024, 1024)
    const extent = Math.max(this.boardWidth, this.boardHeight) * 0.7
    Object.assign(this.key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.1, far: 100 })
    this.key.shadow.camera.updateProjectionMatrix()
    this.key.shadow.bias = -0.00012; this.key.shadow.normalBias = 0.025
    this.key.shadow.radius = 4
    this.key.shadow.blurSamples = 8
    this.key.shadow.autoUpdate = false

    this.key.target.position.set(this.centerX, this.centerY, 0)
    this.fill.position.set(this.centerX + 6, this.centerY - 2, 5)
    this.fill.target.position.set(this.centerX, this.centerY, 0)
    this.scene.add(this.ambient, this.key, this.key.target, this.fill, this.fill.target)
    this.setLook(this.look)
    this.updateView(1, 1, 1, 0, 0, new SurfaceTrackball().orientation)
  }

  setLook(next: Partial<WaterLook>): void {
    if (this.disposed) return
    const previousHeight = this.look.wallHeight
    this.look = normalizeWaterLook(next, this.look)
    const palette = getWaterTheme(this.look.theme)
    const lighting = WATER_LIGHTS[this.look.light]
    this.scene.background = new THREE.Color(palette.background)
    this.wallTop.color.set(palette.wall)
    this.wallSide.color.set(palette.wallSide)
    this.wallTop.roughness = palette.roughness
    this.wallTop.metalness = palette.metalness
    this.wallSide.roughness = Math.min(0.85, palette.roughness + 0.14)
    this.wallSide.metalness = palette.metalness * 0.5
    this.wallTop.clearcoat = this.look.theme === 'glacier' ? 0.7 : this.look.theme === 'terrace' ? 0.05 : 0.38
    this.sculpted.setLook(this.look)
    this.groundMaterial.color.set(palette.background)
    this.key.shadow.needsUpdate = true
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true
    this.ambient.color.set(lighting.sky)
    this.ambient.groundColor.set(lighting.ground)
    this.ambient.intensity = lighting.ambient * 0.20
    this.key.color.set(lighting.color)
    this.key.intensity = lighting.intensity * 1.15
    this.key.position.set(this.centerX + lighting.direction[0] * 12, this.centerY + lighting.direction[1] * 12, lighting.direction[2] * Math.max(18, this.boardHeight))
    this.fill.color.set(lighting.fill)
    this.fill.intensity = 0.22
    // Matrix writes happen on explicit edits only. No allocations or wall
    // geometry rebuilding are added to the animation/simulation frame.
    if (previousHeight !== this.look.wallHeight || !this.wallMesh.boundingSphere) {
      const matrix = new THREE.Matrix4()
      for (let i = 0; i < this.walls.length; i++) {
        const wall = this.walls[i]
        matrix.makeScale(wall.x1 - wall.x0, wall.y1 - wall.y0, 0.48 * this.look.wallHeight)
        matrix.setPosition((wall.x0 + wall.x1) * 0.5, -(wall.y0 + wall.y1) * 0.5, 0.014)
        this.wallMesh.setMatrixAt(i, matrix)
      }
      this.wallMesh.instanceMatrix.needsUpdate = true
      this.wallMesh.computeBoundingSphere()
    }
  }

  setAppearance(appearance: WaterAppearance): void { this.sculpted.setAppearance(appearance) }
  updateWater(time: number, style: number): void { this.sculpted.update(time, style) }
  addFunnel(source: THREE.Group): void {
    const funnel = source.clone(true)
    funnel.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const convert = (original: THREE.Material) => {
        const basic = original as THREE.MeshBasicMaterial
        const material = new THREE.MeshPhysicalMaterial({ color: basic.color, roughness: 0.24, metalness: basic.transparent ? 0 : 0.45,
          transparent: basic.transparent, opacity: basic.opacity, depthWrite: basic.depthWrite, side: basic.side, clearcoat: 0.6, envMapIntensity: 1.0 })
        this.materials.push(material); return material
      }
      object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material)
      object.castShadow = !Array.isArray(object.material) && !object.material.transparent
    })
    this.content.add(funnel)
  }

  updateView(widthPx: number, heightPx: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    if (this.disposed) return
    const aspect = Math.max(1, widthPx) / Math.max(1, heightPx)
    // Keep the original front-view framing at every orbit angle. Refitting
    // rotated bounds on each touch made rotation unexpectedly zoom the board.
    // Corners can leave the viewport during free roll; zoom remains explicit.
    const width = this.boardWidth + 0.60
    const height = this.boardHeight + 0.60
    const depth = 0.75
    const basis = new THREE.Matrix4().makeRotationFromQuaternion(new SurfaceTrackball().orientation.invert()).elements
    const frontWidth = Math.abs(basis[0]) * width + Math.abs(basis[4]) * height + Math.abs(basis[8]) * depth
    const frontHeight = Math.abs(basis[1]) * width + Math.abs(basis[5]) * height + Math.abs(basis[9]) * depth
    const viewHeight = Math.max(frontHeight, frontWidth / aspect) / Math.max(0.1, zoom)
    const viewWidth = viewHeight * aspect
    this.viewSize.set(viewWidth, viewHeight)
    this.camera.left = -viewWidth * 0.5
    this.camera.right = viewWidth * 0.5
    this.camera.top = viewHeight * 0.5
    this.camera.bottom = -viewHeight * 0.5
    this.camera.near = 0.01
    this.camera.far = this.distance * 3
    this.screenOffset.set(panX, panY, 0).applyQuaternion(orientation)
    this.target.set(this.centerX, this.centerY, 0.04).add(this.screenOffset)
    this.viewDirection.set(0, 0, 1).applyQuaternion(orientation)
    // A single sheet has no volume back face. DoubleSide makes Three rebuild
    // the transmission buffer twice; select the visible side for free orbit.
    const waterSide = this.viewDirection.z >= 0 ? THREE.FrontSide : THREE.BackSide
    if (this.sculpted.waterMaterial.side !== waterSide) {
      this.sculpted.waterMaterial.side = waterSide
      this.sculpted.waterMaterial.needsUpdate = true
    }
    this.camera.position.copy(this.target).addScaledVector(this.viewDirection, this.distance)
    this.camera.quaternion.copy(orientation)
    this.camera.up.set(0, 1, 0).applyQuaternion(orientation)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sculpted.dispose(); this.environment?.dispose(); this.key.shadow.dispose()
    for (const mesh of this.instances) mesh.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    // The external field texture and accessories can also belong to the 2D
    // presentation. Only this class's own geometry and materials are disposed.
    this.content.clear()
    this.scene.clear()
  }
}
