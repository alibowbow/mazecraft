import * as THREE from 'three'
import type { FluidLayout, FluidWall } from './types'
import { INITIAL_SURFACE_PITCH, INITIAL_SURFACE_YAW, SurfaceTrackball } from './camera3d'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
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
function fixedWidthBevel(material: THREE.MeshPhysicalMaterial): void {
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
        transformed.xy = sign(position.xy) * (vec2(0.5) - (vec2(0.5) - abs(position.xy)) / wallBevelScale);
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
  private readonly slabMaterial = new THREE.MeshPhysicalMaterial({ clearcoat: 0.18, clearcoatRoughness: 0.38 })
  private readonly ambient = new THREE.HemisphereLight()
  private readonly key = new THREE.DirectionalLight()
  private readonly fill = new THREE.DirectionalLight()
  private readonly wallMesh: THREE.InstancedMesh
  private readonly walls: FluidLayout['walls']
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
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
      bevelSegments: 3,
      bevelSize: 0.018,
      bevelThickness: 0.08,
      curveSegments: 1,
    })
    wallGeometry.scale(1 / 1.036, 1 / 1.036, 1)
    wallGeometry.translate(0, 0, 0.08)
    fixedWidthBevel(this.wallTop)
    fixedWidthBevel(this.wallSide)
    const walls = continuousWalls(layout.walls)
    this.walls = walls
    const wallMesh = this.wallMesh = new THREE.InstancedMesh(wallGeometry, [this.wallTop, this.wallSide], walls.length)
    wallMesh.name = 'extruded-maze-walls'
    this.content.add(wallMesh)
    this.instances.push(wallMesh)
    this.geometries.push(wallGeometry)
    this.materials.push(this.wallTop, this.wallSide)

    const slabGeometry = new RoundedBoxGeometry(this.boardWidth + 0.26, this.boardHeight + 0.26, 0.32, 3, 0.11)
    const slab = new THREE.Mesh(slabGeometry, this.slabMaterial)
    slab.name = 'maze-board-thickness'
    slab.position.set(this.centerX, this.centerY, -0.166)
    this.content.add(slab)
    this.geometries.push(slabGeometry)
    this.materials.push(this.slabMaterial)

    // Static analytic contact shade costs one tiny plane and no shadow map or
    // reflection pass. It stays attached to the board through free orbiting.
    const shadeGeometry = new THREE.PlaneGeometry(this.boardWidth + 3.4, this.boardHeight + 3.4)
    const shadeMaterial = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(this.boardWidth, this.boardHeight) } },
      vertexShader: `varying vec2 vPoint; void main() { vPoint = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec2 uSize; varying vec2 vPoint; void main() {
        vec2 delta = max(abs(vPoint - vec2(0.13, -0.16)) - uSize * 0.5 + 0.08, 0.0);
        float shade = exp(-dot(delta, delta) * 4.0) * 0.17;
        gl_FragColor = vec4(0.34, 0.37, 0.34, shade);
      }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    })
    const shade = new THREE.Mesh(shadeGeometry, shadeMaterial)
    shade.position.set(this.centerX, this.centerY, -0.36)
    shade.name = 'board-contact-shade'
    this.content.add(shade)
    this.geometries.push(shadeGeometry)
    this.materials.push(shadeMaterial)

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
    this.slabMaterial.color.set(palette.slab)
    this.slabMaterial.roughness = Math.min(0.8, palette.roughness + 0.16)
    this.slabMaterial.metalness = palette.metalness * 0.5
    this.ambient.color.set(lighting.sky)
    this.ambient.groundColor.set(lighting.ground)
    this.ambient.intensity = lighting.ambient
    this.key.color.set(lighting.color)
    this.key.intensity = lighting.intensity
    this.key.position.set(this.centerX + lighting.direction[0] * 12, this.centerY + lighting.direction[1] * 12, lighting.direction[2] * 12)
    this.fill.color.set(lighting.fill)
    this.fill.intensity = 0.55
    // Matrix writes happen on explicit edits only. No allocations or wall
    // geometry rebuilding are added to the animation/simulation frame.
    if (previousHeight !== this.look.wallHeight || !this.wallMesh.boundingSphere) {
      const matrix = new THREE.Matrix4()
      for (let i = 0; i < this.walls.length; i++) {
        const wall = this.walls[i]
        matrix.makeScale(wall.x1 - wall.x0, wall.y1 - wall.y0, 0.42 * this.look.wallHeight)
        matrix.setPosition((wall.x0 + wall.x1) * 0.5, -(wall.y0 + wall.y1) * 0.5, 0.014)
        this.wallMesh.setMatrixAt(i, matrix)
      }
      this.wallMesh.instanceMatrix.needsUpdate = true
      this.wallMesh.computeBoundingSphere()
    }
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
    const sy = Math.sin(INITIAL_SURFACE_YAW), cy = Math.cos(INITIAL_SURFACE_YAW)
    const sp = Math.sin(INITIAL_SURFACE_PITCH), cp = Math.cos(INITIAL_SURFACE_PITCH)
    const frontWidth = cy * width + sy * depth
    const frontHeight = sp * sy * width + cp * height + sp * cy * depth
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
    this.camera.position.copy(this.target).addScaledVector(this.viewDirection, this.distance)
    this.camera.quaternion.copy(orientation)
    this.camera.up.set(0, 1, 0).applyQuaternion(orientation)
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
