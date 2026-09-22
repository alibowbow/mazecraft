import * as THREE from 'three'
import type { FluidLayout } from './types'
import { SurfaceTrackball } from './camera3d'
import { ceramicWallGeometry } from './ceramicWalls'
import { applyCeramicGlaze } from './ceramicGlaze'
import { createTerraceElevation, createTerraceUniforms, splitTerraceGeometry, terraceElevationSlopeAt, type TerraceElevationProfile } from './terraceElevation'
import { StudioStage, createAtelierEnvironment } from './studioStage'
import { SculptedSurface } from './sculptedSurface'
import type { BasinSnapshot } from './basinSimulation'
import { BasinFixtures } from './basinFixtures'
import type { WaterAppearance } from './appearance'
import { DEFAULT_WATER_LOOK, getWaterTheme, normalizeWaterLook, WATER_LIGHTS, type WaterLook } from './lookdev'

// Particle centers stop at the solver bounds, but their optical footprints can
// extend .392 cells farther. Preserve the whole silhouette at the board edge.
export const SURFACE_FIELD_PADDING = 0.42

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

  constructor(layout: FluidLayout, texture: THREE.Texture, renderer?: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.environment = null
    if (renderer) {
      this.environment = createAtelierEnvironment(renderer)
      this.scene.environment = this.environment.texture
      this.scene.environmentIntensity = 0.55
    }
    this.boardWidth = layout.maxX - layout.minX + 2 * SURFACE_FIELD_PADDING
    this.boardHeight = layout.maxY - layout.minY + 2 * SURFACE_FIELD_PADDING
    const activeColumns = Array.from(layout.activeCells, (active, i) => active ? i % layout.cols : -1).filter(col => col >= 0)
    const left = Math.min(...activeColumns), right = Math.max(...activeColumns) + 1
    this.sculptureWidth = right - left + 0.7
    this.sculptureHeight = layout.bottomY - layout.topY + 1.7
    this.centerX = (left + right) * 0.5
    this.centerY = -(layout.topY + layout.bottomY) * 0.5 + 0.25
    this.distance = Math.hypot(this.boardWidth, this.boardHeight) * 1.6 + 4
    this.content.name = 'free-surface-3d-board'
    this.scene.add(this.content)

    this.sculpted = new SculptedSurface(layout, texture, new THREE.Vector4(
      layout.minX - SURFACE_FIELD_PADDING, -layout.maxY - SURFACE_FIELD_PADDING,
      this.boardWidth, this.boardHeight,
    ))
    this.content.add(this.sculpted.body, this.sculpted.foundation, this.sculpted.water)

    // Union the entire network before rounding it: each T/L/cross junction is
    // part of one ceramic surface, with no intersecting boxes or cap seams.
    const terrace = this.terrace = createTerraceElevation(layout)
    const sourceWallGeometry = ceramicWallGeometry(layout.walls)
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
    this.content.add(this.fixtures.group)
    this.stage = new StudioStage(this.centerX, this.centerY, this.sculptureWidth, this.sculptureHeight)
    this.scene.add(this.stage.group)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    const extent = Math.max(this.boardWidth, this.boardHeight) * 0.7
    Object.assign(this.key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.1, far: 100 })
    this.key.shadow.camera.updateProjectionMatrix()
    this.key.shadow.bias = -0.00012; this.key.shadow.normalBias = 0.025
    this.key.shadow.radius = 5
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
    this.look = normalizeWaterLook(next, this.look)
    const palette = getWaterTheme(this.look.theme)
    const lighting = WATER_LIGHTS[this.look.light]
    this.scene.background = new THREE.Color(palette.background)
    this.wallTop.color.set(palette.wall)
    this.wallSide.color.set(palette.wallSide)
    this.wallTop.roughness = palette.roughness
    this.wallTop.metalness = palette.metalness
    this.wallSide.roughness = Math.min(0.85, palette.roughness + 0.04)
    this.wallSide.metalness = palette.metalness * 0.5
    const mineral = this.look.theme === 'terrace' || this.look.theme === 'basalt'
    this.wallTop.clearcoat = mineral ? 0.08 : 1
    this.wallSide.clearcoat = mineral ? 0.08 : 0.9
    this.wallTop.clearcoatRoughness = 0.10
    this.wallSide.clearcoatRoughness = 0.13
    this.wallTop.envMapIntensity = 1.1
    this.wallSide.envMapIntensity = 0.95
    this.sculpted.setLook(this.look)
    this.stage.material.color.set(palette.background)
    this.key.shadow.needsUpdate = true
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true
    this.ambient.color.set(lighting.sky)
    this.ambient.groundColor.set(lighting.ground)
    this.ambient.intensity = lighting.ambient * 0.23
    this.key.color.set(lighting.color)
    this.key.intensity = lighting.intensity * 0.95
    const lightDistance = Math.max(16, this.sculptureHeight * 1.4)
    this.key.position.set(this.centerX + lighting.direction[0] * lightDistance, this.centerY + lighting.direction[1] * lightDistance, lighting.direction[2] * lightDistance)
    this.fill.color.set(lighting.fill)
    this.fill.intensity = 0.22
    // Only uniforms change on look edits; geometry and the fluid field stay
    // untouched, including when the height slider moves continuously.
    this.wallUniforms.uCeramicHeight.value = this.look.wallHeight
    this.wallUniforms.uCeramicMineral.value = this.look.theme === 'terrace' || this.look.theme === 'basalt' ? 1.0 : 0.55
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
  // basin has its own raised copper supply and a real retaining outlet sill.
  addFunnel(_source: THREE.Group): void {}

  updateView(widthPx: number, heightPx: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    if (this.disposed) return
    const aspect = Math.max(1, widthPx) / Math.max(1, heightPx)
    // Keep the original front-view framing at every orbit angle. Refitting
    // rotated bounds on each touch made rotation unexpectedly zoom the board.
    // Corners can leave the viewport during free roll; zoom remains explicit.
    const width = this.sculptureWidth + 0.45
    const height = this.sculptureHeight + 0.45
    const depth = 1.65
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
    this.target.set(this.centerX, this.centerY, 0.44).add(this.screenOffset)
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
    this.sculpted.dispose(); this.fixtures.dispose(); this.stage.dispose(); this.environment?.dispose(); this.key.shadow.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    // The external field texture and accessories can also belong to the 2D
    // presentation. Only this class's own geometry and materials are disposed.
    this.content.clear()
    this.scene.clear()
  }
}
