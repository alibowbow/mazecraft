import * as THREE from 'three'
import type { FluidLayout } from './types'
import { BASIN_FLOOR_Z, BASIN_OUTLET_SILL_DEPTH, type BasinSnapshot } from './basinSimulation'
import type { WaterAppearance } from './appearance'

/** The supply and outlet show the same rates and levels as the basin solver. */
export class BasinFixtures {
  readonly group = new THREE.Group()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly supplyCurve: THREE.CatmullRomCurve3
  private readonly supply: THREE.Mesh
  private readonly nozzle: THREE.Mesh
  private readonly opening: THREE.Mesh
  private readonly jet: THREE.Mesh
  private readonly spill: THREE.Mesh
  private readonly ripples: THREE.Mesh[] = []
  private readonly inletCell: number
  private readonly outletCell: number
  private readonly inletY: number
  private readonly outletY: number
  private readonly outletX: number
  private readonly waterMaterial: THREE.MeshPhysicalMaterial
  private inflowEnabled = true
  private supplyLift = 0
  private snapshot: BasinSnapshot | null = null

  constructor(layout: FluidLayout) {
    this.group.name = 'basin-supply-and-outlet'
    this.inletY = -layout.topY - 0.30
    this.outletY = -layout.bottomY
    this.outletX = layout.outletX
    this.inletCell = layout.topY * layout.cols + Math.floor(layout.inletX)
    this.outletCell = (layout.bottomY - 1) * layout.cols + Math.floor(layout.outletX)
    const copper = new THREE.MeshPhysicalMaterial({ color: '#ba7856', metalness: 0.76, roughness: 0.24, clearcoat: 0.4, envMapIntensity: 0.9 })
    const ceramic = new THREE.MeshPhysicalMaterial({ color: '#f3e7d3', roughness: 0.20, clearcoat: 0.9, clearcoatRoughness: 0.12 })
    const dark = new THREE.MeshStandardMaterial({ color: '#594538', roughness: 0.42, metalness: 0.5 })
    const liquid = this.waterMaterial = new THREE.MeshPhysicalMaterial({ color: '#c3efea', transmission: 0.9, thickness: 0.12, roughness: 0.10, ior: 1.333, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })
    const foam = new THREE.MeshBasicMaterial({ color: '#e1f8f0', transparent: true, opacity: 0.28, depthWrite: false })
    this.materials.push(copper, ceramic, dark, liquid, foam)
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.Mesh(geometry, material)
      this.geometries.push(geometry); this.group.add(mesh)
      mesh.castShadow = material !== liquid && material !== foam
      mesh.receiveShadow = material !== liquid && material !== foam
      return mesh
    }
    const x = layout.inletX, y = -layout.topY
    // A small cast pedestal seats the supply beside the rim, not across it.
    const foot = add(new THREE.CylinderGeometry(0.23, 0.27, 0.30, 28), ceramic)
    foot.rotation.x = Math.PI / 2; foot.position.set(x, y + 0.56, -0.44)
    foot.name = 'basin-supply-foot'
    const supply = this.supplyCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, y + 0.56, -0.32),
      new THREE.Vector3(x, y + 0.56, 0.95),
      new THREE.Vector3(x, y + 0.40, 1.37),
      new THREE.Vector3(x, y + 0.04, 1.43),
      new THREE.Vector3(x, this.inletY, 1.24),
    ])
    this.supply = add(new THREE.TubeGeometry(supply, 36, 0.085, 12, false), copper)
    this.supply.name = 'basin-supply-pipe'
    const nozzle = this.nozzle = add(new THREE.CylinderGeometry(0.10, 0.10, 0.13, 24, 1, true), copper)
    nozzle.rotation.x = Math.PI / 2; nozzle.position.set(x, this.inletY, 1.20)
    nozzle.name = 'basin-supply-nozzle'
    const opening = this.opening = add(new THREE.CircleGeometry(0.071, 24), dark)
    opening.rotation.x = Math.PI; opening.position.set(x, this.inletY, 1.134)
    opening.name = 'basin-supply-opening'
    this.jet = add(new THREE.CylinderGeometry(0.049, 0.066, 1, 16, 8, true), liquid)
    this.jet.rotation.x = Math.PI / 2
    this.jet.name = 'supply-glint'
    this.jet.visible = false
    for (let i = 0; i < 3; i++) {
      const ring = add(new THREE.RingGeometry(0.16 + i * 0.09, 0.170 + i * 0.09, 48), foam)
      ring.position.set(x, this.inletY, 0.34)
      this.ripples.push(ring)
    }
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
    this.jet.visible = this.inflowEnabled && source > 0.000001
    const fallHeight = Math.max(0.01, this.opening.position.z - inletLevel)
    const jetWidth = Math.min(1.8, 0.6 + Math.sqrt(source) * 2)
    this.jet.scale.set(jetWidth, fallHeight, jetWidth)
    // Supply position is captured from the ripple center; it never follows
    // particle jitter or screen coordinates when the camera moves.
    this.jet.position.set(this.ripples[0].position.x, this.inletY, inletLevel + fallHeight / 2)
    for (let i = 0; i < this.ripples.length; i++) {
      const ring = this.ripples[i]
      ring.visible = this.jet.visible && inletLevel > -0.07
      ring.position.z = inletLevel + 0.009
      const phase = (snapshot.diagnostics.time * 0.50 + i / 3) % 1
      ring.scale.setScalar(0.65 + phase * 0.6)
    }
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
    this.waterMaterial.color.set(appearance.color ?? '#ffffff').lerp(new THREE.Color('#ffffff'), 0.78)
  }

  setWallHeight(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return
    const lift = 1.05 * Math.max(0, Math.min(1.75, multiplier) - 1)
    if (lift === this.supplyLift) return
    this.supplyLift = lift
    // Raise the arch and nozzle together, keeping the pedestal connection
    // planted and the tube circular even at the tallest supported rim.
    const heights = [-0.32, 0.95, 1.37, 1.43, 1.24]
    this.supplyCurve.points.forEach((point, i) => { point.z = heights[i] + (i ? lift : 0) })
    this.supplyCurve.updateArcLengths()
    const previous = this.supply.geometry
    const geometry = new THREE.TubeGeometry(this.supplyCurve, 36, 0.085, 12, false)
    this.supply.geometry = geometry
    this.geometries[this.geometries.indexOf(previous)] = geometry
    previous.dispose()
    this.nozzle.position.z = 1.20 + lift
    this.opening.position.z = 1.134 + lift
    if (this.snapshot) this.update(this.snapshot)
  }

  setInflow(enabled: boolean): void {
    this.inflowEnabled = enabled
    if (this.snapshot) this.update(this.snapshot)
  }

  dispose(): void {
    this.geometries.forEach(geometry => geometry.dispose())
    this.materials.forEach(material => material.dispose())
    this.group.clear()
  }
}
