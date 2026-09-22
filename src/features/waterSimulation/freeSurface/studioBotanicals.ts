import * as THREE from 'three'

interface BotanicalInstance {
  position: THREE.Vector3
  rotation: THREE.Quaternion
  scale: THREE.Vector3
  color: THREE.Color
}

/** A folded lanceolate blade: its midrib catches light without a leaf texture. */
function leafGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = []
  const rows = 7
  for (let row = 0; row <= rows; row++) {
    const t = row / rows
    const width = Math.max(0.002, Math.sin(Math.PI * t) ** 0.8 * 0.17)
    for (let side = -1; side <= 1; side++) {
      positions.push(side * width, t, Math.sin(Math.PI * t) * (side === 0 ? 0.037 : -0.005) + t * t * 0.075)
    }
  }
  for (let row = 0; row < rows; row++) for (let side = 0; side < 2; side++) {
    const a = row * 3 + side, b = a + 3
    indices.push(a, a + 1, b, a + 1, b + 1, b)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices); geometry.computeVertexNormals()
  return geometry
}

/** Low, irregular limestone pebbles have flat contact rather than floating tips. */
function stoneGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 14, 9)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const contour = 1 + Math.sin(x * 3.9 + y * 2.4) * 0.09 + Math.cos(y * 5.3 - z * 2) * 0.055
    position.setXYZ(i, x * contour, y * contour, Math.max(-0.4, z * 0.62 * contour))
  }
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Four static instanced surfaces, outside the board footprint. These are real
 * 3D leaves/stems/stones; the studio's cached light map owns their shadows.
 */
export class StudioBotanicals {
  readonly group = new THREE.Group()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly meshes: THREE.InstancedMesh[] = []

  constructor(centerX: number, centerY: number, width: number, height: number) {
    this.group.name = 'studio-border-botanicals'
    const leaves: BotanicalInstance[] = [], needles: BotanicalInstance[] = [], stems: BotanicalInstance[] = [], stones: BotanicalInstance[] = []
    const up = new THREE.Vector3(0, 1, 0)
    const hash = (seed: number) => { const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n) }
    const scale = THREE.MathUtils.clamp(Math.min(width, height) / 10, 0.72, 1.18)
    const stemColor = new THREE.Color('#766c4e'), oliveColor = new THREE.Color('#718052'), rosemaryColor = new THREE.Color('#788b68')
    const segment = (from: THREE.Vector3, to: THREE.Vector3, radius: number) => {
      const direction = to.clone().sub(from)
      stems.push({ position: from.clone().add(to).multiplyScalar(0.5), rotation: new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize()), scale: new THREE.Vector3(radius, direction.length(), radius), color: stemColor })
    }
    const leaf = (target: BotanicalInstance[], from: THREE.Vector3, direction: THREE.Vector3, length: number, breadth: number, seed: number, color: THREE.Color) => {
      const rotation = new THREE.Quaternion().setFromUnitVectors(up, direction.normalize())
      rotation.multiply(new THREE.Quaternion().setFromAxisAngle(up, (hash(seed + 17) - 0.5) * 1.15))
      target.push({ position: from, rotation, scale: new THREE.Vector3(breadth / 0.34, length, length), color: color.clone().multiplyScalar(0.88 + hash(seed) * 0.24) })
    }
    // World X positions stay beyond the broadest board bounds. Stems lean
    // outward, so camera-facing foliage cannot grow into a maze channel.
    const clusters = [
      { x: centerX - width * 0.5 - 0.28 * scale, y: centerY - height * 0.21, direction: -1, kind: 'rosemary' },
      { x: centerX + width * 0.5 + 0.22 * scale, y: centerY + height * 0.12, direction: 1, kind: 'olive' },
    ] as const
    for (const [clusterIndex, cluster] of clusters.entries()) {
      const root = new THREE.Vector3(cluster.x, cluster.y, -0.705)
      const seed = 71 + clusterIndex * 173
      for (let i = 0; i < (clusterIndex ? 3 : 5); i++) {
        const angle = i * 2.399 + seed
        const radius = i ? (0.2 + hash(seed + i) * 0.35) * scale : 0
        const sx = (0.26 + hash(seed + i * 3) * 0.19) * scale
        const sy = (0.2 + hash(seed + i * 5) * 0.12) * scale
        const sz = (0.18 + hash(seed + i * 7) * 0.1) * scale
        stones.push({
          position: new THREE.Vector3(root.x + Math.cos(angle) * radius * 0.6, root.y + Math.sin(angle) * radius, -0.705 + sz * 0.4),
          rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
          scale: new THREE.Vector3(sx, sy, sz), color: new THREE.Color(i % 3 === 0 ? '#bab6a0' : i % 3 === 1 ? '#c9c0a6' : '#a8aa94'),
        })
      }
      if (cluster.kind === 'rosemary') {
        for (let stalk = 0; stalk < 8; stalk++) {
          const angle = stalk * 2.399, tall = (0.58 + hash(seed + stalk) * 0.66) * scale
          const start = root.clone().add(new THREE.Vector3(Math.cos(angle) * 0.12 * scale, Math.sin(angle) * 0.18 * scale, 0.07 * scale))
          let before = start
          for (let tier = 1; tier <= 7; tier++) {
            const t = tier / 7
            const node = start.clone().add(new THREE.Vector3(cluster.direction * t * t * 0.18 * scale + Math.cos(angle) * t * 0.15 * scale, Math.sin(angle) * t * 0.34 * scale, tall * t))
            segment(before, node, (0.013 - t * 0.005) * scale)
            for (let side = 0; side < 3; side++) {
              const azimuth = angle + tier * 0.37 + side * Math.PI * 2 / 3
              leaf(needles, node.clone(), new THREE.Vector3(Math.cos(azimuth) * 0.7, Math.sin(azimuth) * 0.7, 0.5), (0.13 + hash(seed + tier + stalk * 7) * 0.055) * scale, 0.029 * scale, seed + tier * 5 + side + stalk, rosemaryColor)
            }
            before = node
          }
        }
      } else {
        for (let branch = 0; branch < 4; branch++) {
          const angle = -0.85 + branch * 0.6, tall = (0.91 + hash(seed + branch) * 0.55) * scale
          let before = root.clone().add(new THREE.Vector3(0, 0, 0.1 * scale))
          for (let tier = 1; tier <= 7; tier++) {
            const t = tier / 7
            const node = root.clone().add(new THREE.Vector3((0.18 + branch * 0.065) * t * scale, Math.sin(angle) * t * 0.67 * scale, 0.1 * scale + tall * t - t * t * 0.18 * scale))
            segment(before, node, (0.019 - t * 0.009) * scale)
            if (tier > 1) for (const side of [-1, 1]) {
              const azimuth = angle + side * 1.08 + tier * 0.13
              leaf(leaves, node.clone(), new THREE.Vector3(Math.cos(azimuth) * 0.78, Math.sin(azimuth) * 0.78, 0.22 + hash(tier + branch) * 0.32), (0.24 + hash(seed + tier * 3 + branch) * 0.12) * scale, (0.065 + hash(seed + tier) * 0.015) * scale, seed + tier + branch * 8 + side, oliveColor)
            }
            before = node
          }
        }
      }
    }
    const blade = leafGeometry(), twig = new THREE.CylinderGeometry(0.72, 1, 1, 6, 1), pebble = stoneGeometry()
    this.geometries.push(blade, twig, pebble)
    const leafMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, side: THREE.DoubleSide, envMapIntensity: 0.45 })
    leafMaterial.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBotanicalPosition;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBotanicalPosition = position;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBotanicalPosition;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat vein = 1.0 - smoothstep(0.004, 0.014, abs(vBotanicalPosition.x));\ndiffuseColor.rgb *= 1.0 + vein * 0.075;')
    }
    leafMaterial.customProgramCacheKey = () => 'studio-folded-botanical-leaf-v1'
    const stemMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.94 })
    const stoneMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, envMapIntensity: 0.3 })
    stoneMaterial.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPebblePosition;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPebblePosition = position;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPebblePosition;')
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float mineral = sin(dot(vPebblePosition, vec3(7.3, 4.1, 5.7))) * sin(dot(vPebblePosition, vec3(3.2, -6.9, 4.6)));
          float grain = fract(sin(dot(floor(vPebblePosition * 75.0), vec3(12.9898, 78.233, 45.16))) * 43758.5453);
          diffuseColor.rgb *= 0.97 + mineral * 0.07 + grain * 0.06;
        `)
    }
    stoneMaterial.customProgramCacheKey = () => 'studio-matte-limestone-pebble-v1'
    this.materials.push(leafMaterial, stemMaterial, stoneMaterial)
    const assemble = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, instances: BotanicalInstance[]) => {
      const mesh = new THREE.InstancedMesh(geometry, material, instances.length)
      mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true
      const matrix = new THREE.Matrix4()
      instances.forEach((instance, i) => { matrix.compose(instance.position, instance.rotation, instance.scale); mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, instance.color) })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere(); this.group.add(mesh); this.meshes.push(mesh)
    }
    assemble('olive-lanceolate-leaves', blade, leafMaterial, leaves)
    assemble('rosemary-needle-leaves', blade, leafMaterial, needles)
    assemble('botanical-woody-stems', twig, stemMaterial, stems)
    assemble('border-limestone-pebbles', pebble, stoneMaterial, stones)
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.group.clear()
  }
}
