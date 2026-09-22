import * as THREE from 'three'
import type { FluidLayout } from './types'
import type { BasinSnapshot } from './basinSimulation'
import type { CascadeSnapshot, CascadeState } from './cascadeTypes'
import { CascadeGeometry } from './cascadeGeometry'
import { createCascadeMaterials } from './cascadeMaterials'
import { CascadeFalls } from './cascadeFalls'
import { StudioStage } from './studioStage'
import { DEFAULT_WATER_LOOK, getWaterTheme, normalizeWaterLook, type WaterLook } from './lookdev'
import type { WaterAppearance } from './appearance'

/** An authored, three-level porcelain fountain, separate from the grid editor. */
export class CascadePresentation3D {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80)
  readonly target = new THREE.Vector3(0, -0.1, 1)
  readonly viewSize = new THREE.Vector2(1, 1)
  readonly viewDirection = new THREE.Vector3(0, 0, 1)
  readonly content = new THREE.Group()
  private readonly materials: ReturnType<typeof createCascadeMaterials>
  private readonly sculpture: CascadeGeometry
  private readonly falls: CascadeFalls
  private readonly stage: StudioStage
  private readonly water: THREE.Mesh[] = []
  private readonly ambient = new THREE.AmbientLight('#fff8ed', 0.30)
  private readonly sun = new THREE.DirectionalLight('#fff1d8', 2.1)
  private readonly bounce = new THREE.DirectionalLight('#f1e7d7', 0.40)
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
  private state: CascadeState | null = null
  private style = 1
  private inflowEnabled = true
  private disposed = false

  constructor(_layout: FluidLayout, private readonly renderer: THREE.WebGLRenderer) {
    this.scene.name = 'mediterranean-porcelain-cascade'
    this.materials = createCascadeMaterials(renderer)
    this.scene.environment = this.materials.environment.texture
    this.scene.environmentIntensity = 0.85
    this.scene.background = new THREE.Color('#efe3d3')
    this.sculpture = new CascadeGeometry(this.materials.porcelain, this.materials.floors)
    this.content.add(this.sculpture.group)
    this.sculpture.surfaces.forEach((surface, index) => {
      const geometry = new THREE.ShapeGeometry(surface.shape, 64)
      const water = new THREE.Mesh(geometry, this.materials.water)
      water.name = `cascade-reservoir-water-${index}`
      water.position.z = surface.floor + 0.46
      water.renderOrder = index + 1
      // VSM also renders receiveShadow meshes into its depth pass. The clear
      // surface must not become an opaque shadow blocker over its own floor.
      water.receiveShadow = false
      this.water.push(water)
      this.content.add(water)
    })
    this.falls = new CascadeFalls(this.materials.water)
    this.content.add(this.falls.group)
    this.scene.add(this.content)
    this.stage = new StudioStage(0, -0.3, 9.7, 10)
    this.stage.material.color.set('#f0dfc9')
    this.stage.material.roughness = 0.88
    this.stage.material.shadowSide = THREE.BackSide
    this.scene.add(this.stage.group)

    this.sun.castShadow = true
    this.sun.position.set(-7, -4, 11)
    this.sun.target.position.set(0, 0, 0)
    this.sun.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sun.shadow.camera, { left: -8.5, right: 8.5, top: 8.5, bottom: -8.5, near: 0.5, far: 35 })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.sun.shadow.bias = -0.0003
    this.sun.shadow.normalBias = 0.035
    this.sun.shadow.radius = 4
    this.sun.shadow.blurSamples = 8
    this.sun.shadow.autoUpdate = false
    this.bounce.position.set(6, 2, 7)
    this.bounce.target.position.set(0, 0, 1)
    this.scene.add(this.ambient, this.sun, this.sun.target, this.bounce, this.bounce.target)
    this.setLook(this.look)
  }

  addFunnel(_group: THREE.Group): void {}

  setLook(next: Partial<WaterLook>): void {
    if (this.disposed) return
    this.look = normalizeWaterLook(next, this.look)
    const palette = getWaterTheme(this.look.theme)
    const porcelain = this.look.theme === 'porcelain'
    this.materials.porcelain.color.set(porcelain ? 0xf7f5f0 : palette.wall)
    this.materials.porcelain.roughness = porcelain ? 0.15 : palette.roughness
    this.materials.porcelain.clearcoat = 1
    this.materials.porcelain.clearcoatRoughness = 0.1
    for (const floor of this.materials.floors) floor.color.set(porcelain ? 0xf7f5f0 : palette.floor)
    this.sculpture.setWallHeight(this.look.wallHeight)
    this.falls.setWallHeight(this.look.wallHeight)
    if (this.look.light === 'golden') {
      this.sun.color.set('#ffdfb5'); this.sun.position.set(-8, -4, 7); this.sun.intensity = 2.25
      this.ambient.color.set('#fff1df')
    } else if (this.look.light === 'studio') {
      this.sun.color.set('#fffaff'); this.sun.position.set(-4, -5, 12); this.sun.intensity = 2.0
      this.ambient.color.set('#eef6ff')
    } else {
      this.sun.color.set('#fff1d8'); this.sun.position.set(-7, -4, 11); this.sun.intensity = 2.1
      this.ambient.color.set('#fff8ed')
    }
    this.sun.shadow.needsUpdate = true
    this.renderer.shadowMap.needsUpdate = true
  }

  setAppearance(appearance: WaterAppearance): void {
    this.materials.setAppearance(appearance)
    if (this.state) this.falls.update(this.inflowEnabled ? this.state : { ...this.state, sourceRate: 0 })
  }
  setInflow(enabled: boolean): void {
    this.inflowEnabled = enabled
    if (this.state) this.falls.update(enabled ? this.state : { ...this.state, sourceRate: 0 })
  }
  setBasinSnapshot(snapshot: BasinSnapshot): void {
    if (this.disposed || !('cascade' in snapshot)) return
    this.state = (snapshot as CascadeSnapshot).cascade
    this.water.forEach((water, i) => {
      water.position.z = this.sculpture.surfaces[i].floor + this.state!.depths[i]
      water.visible = this.state!.depths[i] > 0.002
    })
    this.materials.update(this.state, this.style)
    this.falls.update(this.inflowEnabled ? this.state : { ...this.state, sourceRate: 0 })
  }
  updateWater(_time: number, style: number): void {
    this.style = style
    if (this.state) this.materials.update(this.state, style)
  }

  updateView(width: number, height: number, zoom: number, panX: number, panY: number, orientation: THREE.Quaternion): void {
    if (this.disposed) return
    const aspect = Math.max(1, width) / Math.max(1, height)
    const viewHeight = Math.max(12.3, 14.3 / aspect) / Math.max(0.1, zoom)
    this.viewSize.set(viewHeight * aspect, viewHeight)
    const offset = new THREE.Vector3(panX, panY, 0).applyQuaternion(orientation)
    this.target.set(0, -0.7, 1.1).add(offset)
    this.viewDirection.set(0, 0, 1).applyQuaternion(orientation)
    this.camera.left = -this.viewSize.x / 2; this.camera.right = this.viewSize.x / 2
    this.camera.top = viewHeight / 2; this.camera.bottom = -viewHeight / 2
    this.camera.position.copy(this.target).addScaledVector(this.viewDirection, 25)
    this.camera.quaternion.copy(orientation)
    this.camera.up.set(0, 1, 0).applyQuaternion(orientation)
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const water of this.water) water.geometry.dispose()
    this.sculpture.dispose(); this.falls.dispose(); this.stage.dispose(); this.materials.dispose()
    this.sun.shadow.dispose()
    this.scene.clear()
  }
}
