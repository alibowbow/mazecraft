import * as THREE from 'three'
import { RaisedInlet } from './raisedInlet'
import type { FluidLayout } from './types'
import { BASIN_FLOOR_Z, BASIN_OUTLET_SILL_DEPTH, type BasinSnapshot } from './basinSimulation'
import type { WaterAppearance } from './appearance'

/** The supply and outlet show the same rates and levels as the basin solver. */
export class BasinFixtures {
  readonly group = new THREE.Group()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly inlet: RaisedInlet
  private readonly spill: THREE.Mesh
  private readonly inletCell: number
  private readonly outletCell: number
  private readonly outletY: number
  private readonly outletX: number
  private readonly waterMaterial: THREE.MeshPhysicalMaterial
  private inflowEnabled = true
  private snapshot: BasinSnapshot | null = null

  constructor(layout: FluidLayout) {
    this.group.name = 'basin-supply-and-outlet'
    this.outletY = -layout.bottomY
    this.outletX = layout.outletX
    this.inletCell = layout.topY * layout.cols + Math.floor(layout.inletX)
    this.outletCell = (layout.bottomY - 1) * layout.cols + Math.floor(layout.outletX)
    const copper = new THREE.MeshPhysicalMaterial({ color: '#ba7856', metalness: 0.76, roughness: 0.24, clearcoat: 0.4, envMapIntensity: 0.9 })
    const ceramic = new THREE.MeshPhysicalMaterial({ color: '#f3e7d3', roughness: 0.20, clearcoat: 0.9, clearcoatRoughness: 0.12 })
    const liquid = this.waterMaterial = new THREE.MeshPhysicalMaterial({ color: '#c3efea', transmission: 0.9, thickness: 0.12, roughness: 0.10, ior: 1.333, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })
    const foam = new THREE.MeshBasicMaterial({ color: '#e1f8f0', transparent: true, opacity: 0.28, depthWrite: false })
    this.materials.push(copper, ceramic, liquid, foam)
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.Mesh(geometry, material)
      this.geometries.push(geometry); this.group.add(mesh)
      mesh.castShadow = material !== liquid && material !== foam
      mesh.receiveShadow = material !== liquid && material !== foam
      return mesh
    }
    const x = layout.inletX, y = -layout.topY
    this.inlet = new RaisedInlet(0.72, 1.35, 1.82, -0.65)
    this.inlet.group.position.set(x, y - 0.25, 0)
    this.group.add(this.inlet.group)
    // This real ceramic sill retains .24 cells of water above the flat floor.
    const sill = add(new THREE.BoxGeometry(0.82, 0.22, BASIN_OUTLET_SILL_DEPTH - 0.025), ceramic)
    sill.position.set(layout.outletX, this.outletY, BASIN_FLOOR_Z + (BASIN_OUTLET_SILL_DEPTH - 0.025) / 2)
    const lip = add(new THREE.BoxGeometry(0.82, 0.20, 0.025), copper)
    lip.position.set(layout.outletX, this.outletY - 0.05, BASIN_FLOOR_Z + BASIN_OUTLET_SILL_DEPTH - 0.0125)
    // The small receiving runnel belongs below the only outlet, not to a stack
    // of fake terraces. It is dry when the hydraulic outlet rate is zero.
    const tray = add(new THREE.BoxGeometry(1.12, 0.98, 0.10), ceramic)
    tray.position.set(layout.outletX, this.outletY - 0.48, -0.60)
    this.spill = add(new THREE.PlaneGeometry(0.65, 1, 12, 20), liquid)
    this.spill.visible = false
    this.spill.name = 'hydraulic-outlet-sheet'
  }

  update(snapshot: BasinSnapshot): void {
    this.snapshot = snapshot
    const inletLevel = BASIN_FLOOR_Z + (snapshot.depth[this.inletCell] ?? 0)
    const source = snapshot.sourceRate
    this.inlet.update(snapshot.diagnostics.time, this.inflowEnabled ? source : 0, inletLevel)
    const flow = snapshot.diagnostics.outletRate
    this.spill.visible = flow > 0.00001
    if (this.spill.visible) {
      const level = Math.max(BASIN_FLOOR_Z + BASIN_OUTLET_SILL_DEPTH + 0.004, BASIN_FLOOR_Z + snapshot.depth[this.outletCell])
      const positions = this.spill.geometry.getAttribute('position')
      const uv = this.spill.geometry.getAttribute('uv')
      const width = Math.min(0.70, 0.2 + Math.sqrt(flow) * 1.6)
      for (let i = 0; i < positions.count; i++) {
        const t = 1 - uv.getY(i), across = uv.getX(i) - 0.5
        const ripple = Math.sin(across * 42 + snapshot.diagnostics.time * 4) * 0.007
        // Overlap the in-basin water before crossing the lip. The basin field
        // ends at outletY, so starting outside it would leave a dry air gap.
        positions.setXYZ(i, this.outletX + across * width,
          this.outletY + 0.08 - t * 0.71,
          level - (level + 0.53) * t * t + ripple * t)
      }
      positions.needsUpdate = true
      this.spill.geometry.computeVertexNormals()
      this.spill.frustumCulled = false
    }
  }

  setAppearance(appearance: WaterAppearance): void {
    this.waterMaterial.color.set(appearance.color ?? '#ffffff').lerp(new THREE.Color('#ffffff'), 0.45)
    this.inlet.setAppearance(new THREE.Color(appearance.color ?? '#ffffff'))
  }

  setWallHeight(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return
    this.inlet.setWallHeight(multiplier)
    if (this.snapshot) this.update(this.snapshot)
  }

  setInflow(enabled: boolean): void {
    this.inflowEnabled = enabled
    if (this.snapshot) this.update(this.snapshot)
  }

  dispose(): void {
    this.inlet.dispose()
    this.geometries.forEach(geometry => geometry.dispose())
    this.materials.forEach(material => material.dispose())
    this.group.clear()
  }
}
