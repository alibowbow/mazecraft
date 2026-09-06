import * as THREE from 'three'
import type { FluidLayout } from './types'

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
  private readonly instances: THREE.InstancedMesh[] = []
  private readonly centerX: number
  private readonly centerY: number
  private readonly boardWidth: number
  private readonly boardHeight: number
  private readonly distance: number
  private disposed = false

  constructor(layout: FluidLayout, texture: THREE.Texture) {
    this.boardWidth = layout.maxX - layout.minX + 2 * SURFACE_FIELD_PADDING
    this.boardHeight = layout.maxY - layout.minY + 2 * SURFACE_FIELD_PADDING
    this.centerX = (layout.minX + layout.maxX) * 0.5
    this.centerY = -(layout.minY + layout.maxY) * 0.5
    this.distance = Math.hypot(this.boardWidth, this.boardHeight) * 1.6 + 4
    this.content.name = 'free-surface-3d-board'
    this.scene.add(this.content)

    // Bottom-left UV is (minX - padding, -maxY - padding). Keeping exactly the
    // compositor's extents avoids shifting water relative to collision walls.
    const fieldGeometry = new THREE.PlaneGeometry(this.boardWidth, this.boardHeight)
    const fieldMaterial = new THREE.ShaderMaterial({
      uniforms: { uField: { value: texture } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uField;
        varying vec2 vUv;
        void main() {
          // The compositor already supplies display RGB, including transmission
          // through the water. Do not apply lighting or sRGB conversion twice.
          gl_FragColor = texture2D(uField, vUv);
        }
      `,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    })
    const field = new THREE.Mesh(fieldGeometry, fieldMaterial)
    field.name = 'continuous-free-surface'
    field.position.set(this.centerX, this.centerY, 0)
    this.content.add(field)
    this.geometries.push(fieldGeometry)
    this.materials.push(fieldMaterial)

    // One reusable beveled unit box, with exact [-.5, .5] x/y and [0, 1] z
    // bounds. Instancing keeps even the largest maze at a constant draw count.
    const section = new THREE.Shape()
    section.moveTo(-0.5, -0.5)
    section.lineTo(0.5, -0.5)
    section.lineTo(0.5, 0.5)
    section.lineTo(-0.5, 0.5)
    section.closePath()
    const wallGeometry = new THREE.ExtrudeGeometry(section, {
      depth: 0.84,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.04,
      bevelThickness: 0.08,
      curveSegments: 1,
    })
    wallGeometry.scale(1 / 1.08, 1 / 1.08, 1)
    wallGeometry.translate(0, 0, 0.08)
    const wallTop = new THREE.MeshStandardMaterial({
      color: '#304b54', roughness: 0.39, metalness: 0.16,
    })
    const wallSide = new THREE.MeshStandardMaterial({
      color: '#1d343e', roughness: 0.53, metalness: 0.08,
    })
    const walls = layout.walls.filter(wall => !('kind' in wall && wall.kind === 'funnel'))
    const wallMesh = new THREE.InstancedMesh(wallGeometry, [wallTop, wallSide], walls.length)
    const matrix = new THREE.Matrix4()
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i]
      matrix.makeScale(wall.x1 - wall.x0, wall.y1 - wall.y0, 0.30)
      matrix.setPosition((wall.x0 + wall.x1) * 0.5, -(wall.y0 + wall.y1) * 0.5, 0.018)
      wallMesh.setMatrixAt(i, matrix)
    }
    wallMesh.name = 'extruded-maze-walls'
    wallMesh.instanceMatrix.needsUpdate = true
    wallMesh.computeBoundingSphere()
    this.content.add(wallMesh)
    this.instances.push(wallMesh)
    this.geometries.push(wallGeometry)
    this.materials.push(wallTop, wallSide)

    const slabGeometry = new THREE.BoxGeometry(this.boardWidth + 0.09, this.boardHeight + 0.09, 0.22)
    const slabMaterial = new THREE.MeshStandardMaterial({
      color: '#d8dfdb', roughness: 0.68, metalness: 0.03,
    })
    const slab = new THREE.Mesh(slabGeometry, slabMaterial)
    slab.name = 'maze-board-thickness'
    slab.position.set(this.centerX, this.centerY, -0.121)
    this.content.add(slab)
    this.geometries.push(slabGeometry)
    this.materials.push(slabMaterial)

    const ambient = new THREE.HemisphereLight('#e9f6ff', '#738080', 2.1)
    const key = new THREE.DirectionalLight('#fff9eb', 2.5)
    key.position.set(this.centerX - 5, this.centerY + 8, 12)
    key.target.position.set(this.centerX, this.centerY, 0)
    const fill = new THREE.DirectionalLight('#b8ddf4', 0.7)
    fill.position.set(this.centerX + 6, this.centerY - 2, 5)
    fill.target.position.set(this.centerX, this.centerY, 0)
    this.scene.add(ambient, key, key.target, fill, fill.target)
    this.updateView(1, 1, 1, 0, 0, 0.18, 0.20)
  }

  updateView(widthPx: number, heightPx: number, zoom: number, panX: number, panY: number, yaw: number, pitch: number): void {
    if (this.disposed) return
    const aspect = Math.max(1, widthPx) / Math.max(1, heightPx)
    const angleX = THREE.MathUtils.clamp(yaw, -1.1, 1.1)
    const angleY = THREE.MathUtils.clamp(pitch, -0.95, 0.95)
    const sy = Math.sin(angleX), cy = Math.cos(angleX)
    const sp = Math.sin(angleY), cp = Math.cos(angleY)

    // Fit the rotated 3D bounds, including the slab and front accessories. A
    // fixed screen-space fit would crop the board when the camera is orbited.
    const width = this.boardWidth + 0.60
    const height = this.boardHeight + 0.60
    const depth = 0.75
    const projectedWidth = Math.abs(cy) * width + Math.abs(sy) * depth
    const projectedHeight = Math.abs(sp * sy) * width + Math.abs(cp) * height + Math.abs(sp * cy) * depth
    const viewHeight = Math.max(projectedHeight, projectedWidth / aspect) / Math.max(0.1, zoom)
    const viewWidth = viewHeight * aspect
    this.viewSize.set(viewWidth, viewHeight)
    this.camera.left = -viewWidth * 0.5
    this.camera.right = viewWidth * 0.5
    this.camera.top = viewHeight * 0.5
    this.camera.bottom = -viewHeight * 0.5
    this.camera.near = 0.01
    this.camera.far = this.distance * 3
    this.target.set(this.centerX + panX, this.centerY + panY, 0.04)
    this.camera.position.set(
      this.target.x + sy * cp * this.distance,
      this.target.y + sp * this.distance,
      this.target.z + cy * cp * this.distance,
    )
    this.camera.lookAt(this.target)
    this.viewDirection.subVectors(this.camera.position, this.target).normalize()
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const mesh of this.instances) mesh.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    // The external field texture and accessories can also belong to the 2D
    // presentation. Only this class's own geometry and materials are disposed.
    this.content.clear()
    this.scene.clear()
  }
}
