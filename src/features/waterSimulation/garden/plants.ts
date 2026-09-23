import * as THREE from 'three'
import type { PlantKind } from './designs'

interface Instance { matrix: THREE.Matrix4; color: THREE.Color }

function hash(seed: number): number {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return n - Math.floor(n)
}

/** A slightly folded, curved blade; its length runs along +Y. */
function bladeGeometry(rows = 8, width = 0.17, fold = 0.035, curl = 0.08): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = []
  for (let row = 0; row <= rows; row++) {
    const t = row / rows
    const w = Math.max(0.003, Math.sin(Math.PI * Math.min(1, t * 1.08)) ** 0.75 * width)
    for (let side = -1; side <= 1; side++) {
      positions.push(side * w, t, (side === 0 ? fold : -fold * 0.2) * Math.sin(Math.PI * t) + t * t * curl)
    }
  }
  for (let row = 0; row < rows; row++) for (let side = 0; side < 2; side++) {
    const a = row * 3 + side, b = a + 3
    indices.push(a, a + 1, b, a + 1, b + 1, b)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function pebbleGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 3)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const contour = 1 + Math.sin(x * 3.1 + y * 2.2) * 0.08 + Math.cos(y * 4.3 - z * 2.7) * 0.05 + Math.sin(z * 6.1 + x) * 0.025
    position.setXYZ(i, x * contour, y * contour, Math.max(-0.35, z * 0.6 * contour))
  }
  geometry.computeVertexNormals()
  return geometry
}

const UP = new THREE.Vector3(0, 1, 0)

/**
 * Instanced garden planting: olive sprays, rosemary, ferns and river stones.
 * Leaves are real double-sided blades that cast shadows; a soft back-light
 * term lets sunlight glow through them.
 */
export class GardenPlants {
  readonly group = new THREE.Group()
  private readonly leaves: Instance[] = []
  private readonly needles: Instance[] = []
  private readonly fronds: Instance[] = []
  private readonly stems: Instance[] = []
  private readonly stones: Instance[] = []
  private readonly disposables: { dispose(): void }[] = []
  private readonly quaternion = new THREE.Quaternion()
  private readonly twist = new THREE.Quaternion()

  constructor() { this.group.name = 'garden-planting' }

  private put(target: Instance[], position: THREE.Vector3, direction: THREE.Vector3, roll: number, scale: THREE.Vector3, color: THREE.Color) {
    this.quaternion.setFromUnitVectors(UP, direction.clone().normalize())
    this.twist.setFromAxisAngle(UP, roll)
    this.quaternion.multiply(this.twist)
    target.push({ matrix: new THREE.Matrix4().compose(position, this.quaternion, scale), color })
  }

  private stem(from: THREE.Vector3, to: THREE.Vector3, radius: number) {
    const direction = to.clone().sub(from)
    this.put(this.stems, from.clone().add(to).multiplyScalar(0.5), direction, 0, new THREE.Vector3(radius, direction.length(), radius), new THREE.Color('#6d5f45'))
  }

  add(kind: PlantKind, x: number, y: number, z: number, scale: number, seed: number): void {
    const root = new THREE.Vector3(x, y, z)
    if (kind === 'stones') {
      for (let i = 0; i < 5; i++) {
        const angle = i * 2.4 + seed, radius = i ? (0.25 + hash(seed + i) * 0.35) * scale : 0
        const size = (0.16 + hash(seed + i * 3) * 0.22) * scale * (i ? 0.8 : 1.3)
        const position = new THREE.Vector3(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * 0.8, z + size * 0.25)
        const tone = 0.34 + hash(seed + i * 5) * 0.16
        this.stones.push({ matrix: new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
          new THREE.Vector3(size * (1.1 + hash(i) * 0.3), size * (0.8 + hash(i + 9) * 0.3), size)), color: new THREE.Color(tone, tone * 0.95, tone * 0.86) })
      }
      return
    }
    if (kind === 'olive') {
      const base = new THREE.Color('#7b8a5a')
      for (let branch = 0; branch < 7; branch++) {
        const azimuth = seed + branch * 0.9, tall = (0.9 + hash(seed + branch) * 0.6) * scale
        const lean = new THREE.Vector3(Math.cos(azimuth), Math.sin(azimuth), 0).multiplyScalar((0.35 + hash(branch + seed * 2) * 0.35) * scale)
        let before = root.clone()
        for (let node = 1; node <= 9; node++) {
          const t = node / 9
          const point = root.clone().addScaledVector(lean, t * t).add(new THREE.Vector3(0, 0, tall * t - t * t * 0.25 * scale))
          this.stem(before, point, (0.02 - t * 0.012) * scale)
          if (node > 2) for (let pair = 0; pair < 2; pair++) for (const side of [-1, 1]) {
            const a = azimuth + side * (0.9 + hash(node + pair + branch) * 0.5) + node * 0.4
            const direction = new THREE.Vector3(Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.15 + hash(node * 3 + side) * 0.5)
            const length = (0.2 + hash(seed + node * 7 + pair + branch * 3) * 0.09) * scale
            const tint = base.clone().offsetHSL((hash(node + branch * 11 + pair) - 0.5) * 0.03, (hash(node + side) - 0.5) * 0.1, (hash(branch + pair * 5 + node) - 0.5) * 0.12)
            this.put(this.leaves, before.clone().lerp(point, pair * 0.5), direction, hash(node + pair) * 2, new THREE.Vector3(length * 0.38, length, length), tint)
          }
          before = point
        }
      }
      return
    }
    if (kind === 'rosemary') {
      const base = new THREE.Color('#566e4b')
      for (let stalk = 0; stalk < 16; stalk++) {
        const azimuth = stalk * 2.399 + seed, tall = (0.45 + hash(seed + stalk) * 0.45) * scale
        const start = root.clone().add(new THREE.Vector3(Math.cos(azimuth) * 0.12 * scale, Math.sin(azimuth) * 0.12 * scale, 0))
        const lean = new THREE.Vector3(Math.cos(azimuth), Math.sin(azimuth), 0).multiplyScalar(0.18 * scale)
        let before = start
        for (let node = 1; node <= 10; node++) {
          const t = node / 10
          const point = start.clone().addScaledVector(lean, t * t).add(new THREE.Vector3(0, 0, tall * t))
          this.stem(before, point, (0.011 - t * 0.005) * scale)
          for (let k = 0; k < 4; k++) {
            const a = azimuth + node * 0.8 + k * Math.PI / 2
            const direction = new THREE.Vector3(Math.cos(a) * 0.75, Math.sin(a) * 0.75, 0.55)
            const tint = base.clone().offsetHSL(0, 0, (hash(stalk * 13 + node + k) - 0.5) * 0.1)
            this.put(this.needles, point.clone(), direction, a, new THREE.Vector3(0.026 * scale / 0.17, 0.12 * scale, 0.1 * scale), tint)
          }
          before = point
        }
      }
      return
    }
    // Fern: arching pinnate fronds.
    const base = new THREE.Color('#6a8f3c')
    for (let frond = 0; frond < 9; frond++) {
      const azimuth = frond * 0.7 + seed, length = (0.75 + hash(seed + frond) * 0.35) * scale
      const outward = new THREE.Vector3(Math.cos(azimuth), Math.sin(azimuth), 0)
      let before = root.clone()
      for (let node = 1; node <= 14; node++) {
        const t = node / 14
        const point = root.clone().addScaledVector(outward, length * t * 0.8).add(new THREE.Vector3(0, 0, length * (0.9 * t - 0.75 * t * t)))
        this.stem(before, point, 0.006 * scale)
        const tangent = point.clone().sub(before).normalize()
        const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 0, 1)).normalize()
        const leaflet = (0.17 * (1 - t * 0.7)) * scale
        for (const sign of [-1, 1]) {
          const direction = side.clone().multiplyScalar(sign).addScaledVector(tangent, 0.45)
          const tint = base.clone().offsetHSL(0, 0, (hash(frond * 17 + node + sign) - 0.5) * 0.1)
          this.put(this.fronds, point.clone(), direction, 0.3, new THREE.Vector3(leaflet * 0.35, leaflet, leaflet), tint)
        }
        before = point
      }
    }
  }

  build(): void {
    const blade = bladeGeometry(), needle = bladeGeometry(4, 0.17, 0.01, 0.02), leaflet = bladeGeometry(5, 0.2, 0.02, 0.04)
    const twig = new THREE.CylinderGeometry(0.7, 1, 1, 6, 1)
    const pebble = pebbleGeometry()
    const foliage = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.7 })
    foliage.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Sunlight transmitted through thin leaves.
        #if NUM_DIR_LIGHTS > 0
          float backLit = max(0.0, -dot(normal, directionalLights[0].direction));
          reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * backLit * 0.28;
        #endif`)
    }
    foliage.customProgramCacheKey = () => 'garden-foliage-v1'
    const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
    const stone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, envMapIntensity: 0.6 })
    stone.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vStone;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStone = position;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vStone;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float mineral = sin(dot(vStone, vec3(7.3, 4.1, 5.7))) * sin(dot(vStone, vec3(3.2, -6.9, 4.6)));
          float grain = fract(sin(dot(floor(vStone * 60.0), vec3(12.9898, 78.233, 45.16))) * 43758.5453);
          diffuseColor.rgb *= 0.9 + mineral * 0.1 + grain * 0.12;`)
    }
    stone.customProgramCacheKey = () => 'garden-stone-v1'
    this.disposables.push(blade, needle, leaflet, twig, pebble, foliage, bark, stone)
    const assemble = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, list: Instance[]) => {
      if (!list.length) return
      const mesh = new THREE.InstancedMesh(geometry, material, list.length)
      mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true
      list.forEach((instance, i) => { mesh.setMatrixAt(i, instance.matrix); mesh.setColorAt(i, instance.color) })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      this.group.add(mesh)
      this.disposables.push(mesh)
    }
    assemble('olive-leaves', blade, foliage, this.leaves)
    assemble('rosemary-needles', needle, foliage, this.needles)
    assemble('fern-leaflets', leaflet, foliage, this.fronds)
    assemble('woody-stems', twig, bark, this.stems)
    assemble('river-stones', pebble, stone, this.stones)
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose()
    this.group.clear()
  }
}
