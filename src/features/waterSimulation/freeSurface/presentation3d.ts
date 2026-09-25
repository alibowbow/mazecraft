import * as THREE from 'three'
import { StudioShadows, orientStudioEnvironment } from './studioLighting'
import type { FluidLayout } from './types'
import { SurfaceTrackball } from './camera3d'
import { ceramicBasinWallGeometry, ceramicWallGeometry } from './ceramicWalls'
import { applyCeramicGlaze } from './ceramicGlaze'
import { createTerraceElevation, createTerraceUniforms, splitTerraceGeometry, terraceElevationSlopeAt, type TerraceElevationProfile } from './terraceElevation'
import { StudioStage, createAtelierEnvironment } from './studioStage'
import { SculptedSurface } from './sculptedSurface'
import type { BasinSnapshot } from './basinSimulation'
import { BasinFixtures } from './basinFixtures'
import type { WaterAppearance } from './appearance'
import { DEFAULT_WATER_LOOK, getWaterTheme, normalizeWaterLook, STUDIO_HAZE, WATER_LIGHTS, type WaterLook } from './lookdev'

// Particle centers stop at the solver bounds, but their optical footprints can
// extend .392 cells farther. Preserve the whole silhouette at the board edge.
export const SURFACE_FIELD_PADDING = 0.42

/**
 * Default view of an upright maze (the 2D maze stood on its bottom edge, so
 * its water falls from the top down as in the 2D view): from the front,
 * a little above and to one side.
 */
export const UPRIGHT_VIEW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.32)
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 - 0.2))
/** The upright board stands on a plinth this high above the sand (m). */
const PLINTH = 0.35

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
  /** The same direction in the board's own frame (the flow shader's frame). */
  readonly boardViewDirection = new THREE.Vector3(0, 0, 1)
  /** Upright boards: world centre of the board. */
  private readonly boardCentre = new THREE.Vector3()

  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly centerX: number
  private readonly centerY: number
  private readonly boardWidth: number
  private readonly boardHeight: number
  private readonly sculptureWidth: number
  private readonly sculptureHeight: number
  private readonly distance: number
  private readonly screenOffset = new THREE.Vector3()
  private readonly wallTop = new THREE.MeshPhysicalMaterial({ clearcoat: 0.8, clearcoatRoughness: 0.16 })
  private readonly wallSide = new THREE.MeshPhysicalMaterial({ clearcoat: 0.7, clearcoatRoughness: 0.18 })
  private readonly shadows = new StudioShadows()
  private readonly stage: StudioStage
  private readonly sculpted: SculptedSurface
  private readonly environment: THREE.WebGLRenderTarget | null
  private readonly renderer?: THREE.WebGLRenderer
  private readonly ambient = new THREE.HemisphereLight()
  private readonly key = new THREE.DirectionalLight()
  private readonly fill = new THREE.DirectionalLight()
  private readonly wallMesh: THREE.Mesh
  private readonly wallUniforms: Record<string, THREE.IUniform>
  private readonly terrace: TerraceElevationProfile
  private readonly fixtures: BasinFixtures
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
  private disposed = false

  constructor(layout: FluidLayout, texture: THREE.Texture, renderer?: THREE.WebGLRenderer, private readonly extrudedFlow = false) {
    this.renderer = renderer
    this.environment = null
    if (renderer) {
      this.environment = createAtelierEnvironment(renderer)
      this.scene.environment = this.environment.texture
      this.scene.environmentIntensity = 0.8
    }
    this.boardWidth = layout.maxX - layout.minX + 2 * SURFACE_FIELD_PADDING
    this.boardHeight = layout.maxY - layout.minY + 2 * SURFACE_FIELD_PADDING
    const activeColumns = Array.from(layout.activeCells, (active, i) => active ? i % layout.cols : -1).filter(col => col >= 0)
    const left = Math.min(...activeColumns), right = Math.max(...activeColumns) + 1
    this.sculptureWidth = right - left + 0.7
    this.sculptureHeight = extrudedFlow ? this.boardHeight : layout.bottomY - layout.topY + 1.7
    this.centerX = (left + right) * 0.5
    this.centerY = extrudedFlow ? -(layout.minY + layout.maxY) * 0.5 : -(layout.topY + layout.bottomY) * 0.5 + 0.25
    this.distance = Math.hypot(this.boardWidth, this.boardHeight) * 1.6 + 4
    this.content.name = 'free-surface-3d-board'
    this.scene.add(this.content)
    if (extrudedFlow) {
      // Stand the board up: its y (maze up) becomes world height and its
      // walls face the viewer along -y. It rests on a plinth on the sand.
      this.content.rotation.x = Math.PI / 2
      this.content.position.z = layout.maxY + SURFACE_FIELD_PADDING + PLINTH
      this.boardCentre.set(this.centerX, 0, this.content.position.z + this.centerY)
    }

    this.sculpted = new SculptedSurface(layout, texture, new THREE.Vector4(
      layout.minX - SURFACE_FIELD_PADDING, -layout.maxY - SURFACE_FIELD_PADDING,
      this.boardWidth, this.boardHeight,
    ))
    this.content.add(this.sculpted.body, this.sculpted.foundation, this.sculpted.water)

    // Union the entire network before rounding it: each T/L/cross junction is
    // part of one ceramic surface, with no intersecting boxes or cap seams.
    const terrace = this.terrace = createTerraceElevation(layout)
    const sourceWallGeometry = extrudedFlow ? ceramicWallGeometry(layout.walls.filter(wall => wall.kind !== 'funnel')) : ceramicBasinWallGeometry(layout)
    const wallGeometry = splitTerraceGeometry(sourceWallGeometry, terrace)
    sourceWallGeometry.dispose()
    const wallPositions = wallGeometry.getAttribute('position')
    const wallSlopes = new Float32Array(wallPositions.count)
    for (let i = 0; i < wallPositions.count; i += 3) {
      const y = (wallPositions.getY(i) + wallPositions.getY(i + 1) + wallPositions.getY(i + 2)) / 3
      wallSlopes.fill(terraceElevationSlopeAt(terrace, y), i, i + 3)
    }
    wallGeometry.setAttribute('aCeramicSlope', new THREE.BufferAttribute(wallSlopes, 1))
    this.wallUniforms = {
      ...createTerraceUniforms(terrace),
      uCeramicHeight: { value: this.look.wallHeight },
      uCeramicMineral: { value: 0.55 },
    }
    applyCeramicGlaze(this.wallTop, this.wallUniforms)
    applyCeramicGlaze(this.wallSide, this.wallUniforms)
    const wallMesh = this.wallMesh = new THREE.Mesh(wallGeometry, [this.wallTop, this.wallSide])
    wallMesh.name = 'extruded-maze-walls'
    wallMesh.position.z = 0.014
    wallMesh.castShadow = true; wallMesh.receiveShadow = true
    // The shader raises the static network onto its terraces. Keep it visible
    // throughout free orbit even though CPU bounds describe the unraised mesh.
    wallMesh.frustumCulled = false
    const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    applyCeramicGlaze(depthMaterial, this.wallUniforms, false)
    wallMesh.customDepthMaterial = depthMaterial
    this.content.add(wallMesh)
    this.geometries.push(wallGeometry)
    this.materials.push(this.wallTop, this.wallSide, depthMaterial)

    this.fixtures = new BasinFixtures(layout)
    if (!extrudedFlow) this.content.add(this.fixtures.group)
    this.stage = extrudedFlow
      ? new StudioStage(this.centerX, -1.6, this.boardWidth, 5, 0)
      : new StudioStage(this.centerX, this.centerY, this.sculptureWidth, this.sculptureHeight)
    if (extrudedFlow) this.addPlinth(layout)
    this.scene.add(this.stage.group)
    this.ambient.position.set(0, 0, 1)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.bias = -0.00015; this.key.shadow.normalBias = 0.018
    this.key.shadow.radius = 2.5
    this.key.shadow.autoUpdate = false

    const aim = extrudedFlow ? this.boardCentre : new THREE.Vector3(this.centerX, this.centerY, 0)
    this.key.target.position.copy(aim)
    this.fill.position.copy(aim).add(extrudedFlow ? new THREE.Vector3(6, -5, 2) : new THREE.Vector3(6, -2, 5))
    this.fill.target.position.copy(aim)
    this.scene.add(this.ambient, this.key, this.key.target, this.fill, this.fill.target)
    if (this.environment) this.scene.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material instanceof THREE.MeshStandardMaterial) material.envMap = this.environment!.texture
      }
    })
    this.shadows.apply(this.scene)
    this.setLook(this.look)
    this.updateView(1, 1, 1, 0, 0, extrudedFlow ? UPRIGHT_VIEW : new SurfaceTrackball().orientation)
  }

  /** A glazed plinth, posts and catch basin under the upright board, and a thin glass front. */
  private addPlinth(layout: FluidLayout): void {
    const parts: THREE.BufferGeometry[] = []
    const base = new THREE.BoxGeometry(this.boardWidth + 0.5, 1.1, PLINTH)
    base.translate(this.centerX, 0.05, PLINTH / 2)
    parts.push(base)
    // Two posts carry the board over the catch basin its outlet pours into.
    const bottom = this.content.position.z - layout.bottomY
    const left = layout.minX - SURFACE_FIELD_PADDING + 0.15, right = layout.maxX + SURFACE_FIELD_PADDING - 0.15
    for (const x of [left, right]) {
      const post = new THREE.BoxGeometry(0.3, 0.5, bottom - PLINTH + 0.2)
      post.translate(x, -0.1, PLINTH + (bottom - PLINTH + 0.2) / 2 - 0.1)
      parts.push(post)
    }
    // Catch basin: an open box around the outlet's stream.
    const rim = 0.08, width = 1.6, depth = 0.9, height = 0.45, cx = layout.outletX
    for (const [sx, sy, px, py] of [[width, rim, cx, -depth / 2], [width, rim, cx, depth / 2], [rim, depth, cx - width / 2, 0], [rim, depth, cx + width / 2, 0]] as const) {
      const wall = new THREE.BoxGeometry(sx, sy, height)
      wall.translate(px, py - 0.1, PLINTH + height / 2)
      parts.push(wall)
    }
    for (const part of parts) {
      const mesh = new THREE.Mesh(part, this.wallSide)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.name = 'upright-board-stand'
      this.scene.add(mesh); this.geometries.push(part)
    }
    const glass = new THREE.PlaneGeometry(this.boardWidth, this.boardHeight)
    glass.rotateX(Math.PI / 2)
    glass.translate(this.boardCentre.x, -0.62, this.boardCentre.z)
    const pane = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.08, envMapIntensity: 1.2, depthWrite: false, side: THREE.DoubleSide })
    const glassMesh = new THREE.Mesh(glass, pane)
    glassMesh.name = 'upright-board-glass'
    glassMesh.renderOrder = 5
    this.scene.add(glassMesh); this.geometries.push(glass); this.materials.push(pane)
  }

  /** A raised-wall view of the existing 2D water, including its real funnel.
   * This plane uses the same compositor and particle field as the flat view. */
  setFlowMaterial(material: THREE.ShaderMaterial, layout: FluidLayout): void {
    if (!this.extrudedFlow) return
    this.sculpted.water.visible = false
    const geometry = new THREE.PlaneGeometry(this.boardWidth, this.boardHeight)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'same-particle-water-in-3d'
    mesh.position.set((layout.minX + layout.maxX) / 2, -(layout.minY + layout.maxY) / 2, 0.23)
    mesh.renderOrder = 2
    this.content.add(mesh); this.geometries.push(geometry)
  }

  setLook(next: Partial<WaterLook>): void {
    if (this.disposed) return
    this.look = normalizeWaterLook(next, this.look)
    const palette = getWaterTheme(this.look.theme)
    const lighting = WATER_LIGHTS[this.look.light]
    this.scene.background = new THREE.Color(STUDIO_HAZE)
    this.wallTop.color.set(this.look.wallColor ?? palette.wall)
    this.wallSide.color.set(this.look.wallColor ?? palette.wallSide)
    this.wallTop.roughness = palette.roughness
    this.wallTop.metalness = palette.metalness
    this.wallSide.roughness = Math.min(0.85, palette.roughness + 0.04)
    this.wallSide.metalness = palette.metalness * 0.5
    const mineral = palette.roughness >= 0.5
    this.wallTop.clearcoat = mineral ? 0.08 : 1
    this.wallSide.clearcoat = mineral ? 0.08 : 0.9
    this.wallTop.clearcoatRoughness = 0.10
    this.wallSide.clearcoatRoughness = 0.13
    this.wallTop.envMapIntensity = 1.15
    this.wallSide.envMapIntensity = 1.15
    this.sculpted.setLook(this.look)
    this.fixtures.setWallHeight(this.look.wallHeight)
    this.key.shadow.needsUpdate = true
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true
    this.ambient.color.set(lighting.sky)
    this.ambient.groundColor.set(lighting.ground)
    this.ambient.intensity = lighting.ambient * 0.25
    this.key.color.set(lighting.color)
    this.key.intensity = lighting.intensity * 1.25
    const lightDistance = Math.max(16, this.sculptureHeight * 1.4)
    const [lx, ly, lz] = lighting.direction
    // Upright: the board's "towards the viewer" (z) is the world's -y.
    if (this.extrudedFlow) this.key.position.copy(this.boardCentre).add(new THREE.Vector3(lx, -lz, Math.abs(ly) + 0.6).normalize().multiplyScalar(lightDistance))
    else this.key.position.set(this.centerX + lx * lightDistance, this.centerY + ly * lightDistance, lz * lightDistance)
    this.fill.color.set(lighting.fill)
    this.fill.intensity = 0.22
    this.fitShadowCamera()
    this.shadows.update(this.key)
    orientStudioEnvironment(this.scene, lighting.direction)
    // Only uniforms change on look edits; geometry and the fluid field stay
    // untouched, including when the height slider moves continuously.
    this.wallUniforms.uCeramicHeight.value = this.look.wallHeight
    this.wallUniforms.uCeramicMineral.value = mineral ? 1.0 : 0
  }

  private fitShadowCamera(): void {
    // Fit the sculpture and its border plants in light space. The solver's
    // distant particle capture area wastes shadow texels on empty ground.
    // Include the highest wall/nozzle setting so a height edit stays stable.
    this.key.updateMatrixWorld()
    this.key.target.updateMatrixWorld()
    this.key.shadow.updateMatrices(this.key)
    const camera = this.key.shadow.camera
    const bounds = new THREE.Box3()
    const point = new THREE.Vector3()
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-0.72, 3.2]) {
      if (this.extrudedFlow) point.set(this.centerX + x * (this.boardWidth * 0.5 + 1.1), y < 0 ? -3.5 : 1, z < 0 ? 0 : this.boardCentre.z * 2 + 0.5)
      else point.set(this.centerX + x * (this.sculptureWidth * 0.5 + 1.1), this.centerY + y * (this.sculptureHeight * 0.5 + 0.7), z)
      bounds.expandByPoint(point.applyMatrix4(camera.matrixWorldInverse))
    }
    Object.assign(camera, {
      left: bounds.min.x - 0.6, right: bounds.max.x + 0.6,
      bottom: bounds.min.y - 0.6, top: bounds.max.y + 0.6,
      near: Math.max(0.1, -bounds.max.z - 1), far: -bounds.min.z + 2,
    })
    camera.updateProjectionMatrix()
  }

  setAppearance(appearance: WaterAppearance): void { this.sculpted.setAppearance(appearance); this.fixtures.setAppearance(appearance) }
  setInflow(enabled: boolean): void { this.fixtures.setInflow(enabled) }
  setBasinSnapshot(snapshot: BasinSnapshot): void {
    if (this.disposed) return
    this.sculpted.setBasinSnapshot(snapshot)
    this.fixtures.update(snapshot)
  }
  updateWater(time: number, style: number): void { this.sculpted.update(time, style) }
  // The 2D funnel remains owned by the particle renderer. The horizontal
  // basin has its own raised porcelain channel and a real retaining outlet sill.
  addFunnel(source: THREE.Group): void { if (this.extrudedFlow) this.content.add(source) }

  updateView(widthPx: number, heightPx: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    if (this.disposed) return
    const aspect = Math.max(1, widthPx) / Math.max(1, heightPx)
    // Keep the original front-view framing at every orbit angle. Refitting
    // rotated bounds on each touch made rotation unexpectedly zoom the board.
    // Corners can leave the viewport during free roll; zoom remains explicit.
    const width = (this.extrudedFlow ? this.boardWidth : this.sculptureWidth) + 0.45
    const height = this.sculptureHeight + 1.10
    const depth = 2.65
    const basis = new THREE.Matrix4().makeRotationFromQuaternion((this.extrudedFlow ? UPRIGHT_VIEW.clone() : new SurfaceTrackball().orientation).invert()).elements
    // World extents: the upright board is tall in z and shallow in y.
    const [ex, ey, ez] = this.extrudedFlow ? [width, depth, height] : [width, height, depth]
    const frontWidth = Math.abs(basis[0]) * ex + Math.abs(basis[4]) * ey + Math.abs(basis[8]) * ez
    const frontHeight = Math.abs(basis[1]) * ex + Math.abs(basis[5]) * ey + Math.abs(basis[9]) * ez
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
    if (this.extrudedFlow) this.target.copy(this.boardCentre).add(new THREE.Vector3(0, -0.3, -0.2)).add(this.screenOffset)
    else this.target.set(this.centerX, this.centerY + 0.25, 0.75).add(this.screenOffset)
    this.viewDirection.set(0, 0, 1).applyQuaternion(orientation)
    this.boardViewDirection.copy(this.viewDirection).applyQuaternion(this.content.quaternion.clone().invert())
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
    this.sculpted.dispose(); this.fixtures.dispose(); this.stage.dispose(); this.environment?.dispose(); this.key.shadow.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    // The external field texture and accessories can also belong to the 2D
    // presentation. Only this class's own geometry and materials are disposed.
    this.content.clear()
    this.scene.clear()
  }
}
