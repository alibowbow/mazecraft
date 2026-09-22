import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

/** Z-up porcelain inlet. Its open channel, spill lip and falling sheet meet
 * at the same coordinates; all motion uses the accepted hydraulic clock. */
export class RaisedInlet {
  readonly group = new THREE.Group()
  readonly fall: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>
  readonly channel: THREE.Mesh
  readonly waterMaterial: THREE.MeshPhysicalMaterial
  readonly lipZ: number
  private readonly solids = new THREE.Group()
  private readonly support: THREE.Mesh
  private readonly spray: THREE.InstancedMesh
  private readonly rings: THREE.Mesh[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly time = { value: 0 }
  private lift = 0

  constructor(readonly width: number, readonly length: number, lipZ: number, private readonly groundZ: number) {
    this.lipZ = lipZ
    this.group.name = 'raised-porcelain-inlet'
    this.group.add(this.solids)
    const porcelain = new THREE.MeshPhysicalMaterial({ color: 0xf7f5f0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.1, shadowSide: THREE.BackSide })
    this.waterMaterial = new THREE.MeshPhysicalMaterial({ color: 0x38b6d3, roughness: 0.08, transmission: 0.92, ior: 1.333, thickness: 0.065, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.8 })
    this.waterMaterial.onBeforeCompile = shader => {
      shader.uniforms.uInletTime = this.time
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vInletUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInletUv = uv;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vInletUv; uniform float uInletTime;')
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          float a = sin(vInletUv.x * 37.0 + vInletUv.y * 8.0 + uInletTime * 5.0);
          float b = sin(vInletUv.x * 73.0 - vInletUv.y * 15.0 - uInletTime * 7.0);
          normal = normalize(normal + vec3(a * 0.10, b * 0.055, 0.0));
        `)
    }
    this.waterMaterial.customProgramCacheKey = () => 'flowing-raised-inlet-v1'
    const foam = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false })
    this.materials.push(porcelain, this.waterMaterial, foam)
    const block = (w: number, d: number, h: number, x: number, y: number, z: number, name: string) => {
      const shape = new THREE.Shape().moveTo(-w / 2, -d / 2).lineTo(w / 2, -d / 2).lineTo(w / 2, d / 2).lineTo(-w / 2, d / 2).closePath()
      const bevel = Math.min(0.065, w * 0.23, d * 0.23, h * 0.23)
      const original = new THREE.ExtrudeGeometry(shape, { depth: h - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 8, curveSegments: 12 })
      original.translate(0, 0, bevel); original.deleteAttribute('normal'); original.deleteAttribute('uv')
      const geometry = mergeVertices(original, 1e-5); original.dispose(); geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(geometry, porcelain)
      mesh.position.set(x, y, z); mesh.name = name; mesh.castShadow = mesh.receiveShadow = true
      this.solids.add(mesh); this.geometries.push(geometry)
      return mesh
    }
    // The support stands behind the basin. No solid pedestal occupies its water.
    this.support = block(width + 0.24, length * 0.34, lipZ - groundZ - 0.20, 0, length * 0.81, groundZ, 'inlet-rear-pier')
    block(width + 0.28, length, 0.18, 0, length / 2, lipZ - 0.22, 'inlet-channel-bed')
    for (const side of [-1, 1]) block(0.14, length, 0.47, side * (width / 2 + 0.08), length / 2, lipZ - 0.12, 'inlet-channel-side')
    block(width + 0.26, 0.14, 0.47, 0, length, lipZ - 0.12, 'inlet-channel-back')
    const channelGeometry = new THREE.PlaneGeometry(width, length, 6, 24)
    this.channel = new THREE.Mesh(channelGeometry, this.waterMaterial)
    this.channel.name = 'inlet-moving-channel-water'; this.channel.position.set(0, length / 2, lipZ)
    this.group.add(this.channel); this.geometries.push(channelGeometry)
    const sheet = new THREE.PlaneGeometry(width, 1, 24, 36)
    this.fall = new THREE.Mesh(sheet, this.waterMaterial)
    this.fall.name = 'inlet-falling-water'; this.fall.frustumCulled = false; this.fall.renderOrder = 3
    this.group.add(this.fall); this.geometries.push(sheet)
    const droplet = new THREE.SphereGeometry(0.025, 6, 4)
    this.spray = new THREE.InstancedMesh(droplet, foam, 40)
    this.spray.name = 'inlet-white-impact-spray'; this.spray.frustumCulled = false
    this.group.add(this.spray); this.geometries.push(droplet)
    for (let i = 0; i < 3; i++) {
      const geometry = new THREE.RingGeometry(0.94, 1, 48)
      const material = foam.clone(); this.materials.push(material)
      const ring = new THREE.Mesh(geometry, material)
      this.rings.push(ring); this.group.add(ring); this.geometries.push(geometry)
    }
  }

  setWallHeight(multiplier: number): void {
    this.lift = Math.max(0, THREE.MathUtils.clamp(multiplier, 0.55, 1.75) - 1) * 1.05
    for (const mesh of this.solids.children) if (mesh !== this.support) mesh.position.z += this.lift - (this.solids.userData.lift ?? 0)
    this.solids.userData.lift = this.lift
    this.support.scale.z = (this.lipZ + this.lift - this.groundZ - 0.20) / (this.lipZ - this.groundZ - 0.20)
    this.channel.position.z = this.lipZ + this.lift
  }

  update(time: number, rate: number, receivingZ: number): void {
    this.time.value = time
    const enabled = rate > 0.000001
    this.fall.visible = this.spray.visible = enabled
    const top = this.lipZ + this.lift, drop = Math.max(0.01, top - receivingZ)
    const reach = Math.min(0.38, Math.sqrt(drop) * 0.24)
    const strength = THREE.MathUtils.clamp(Math.sqrt(rate / 0.14), 0, 1)
    const positions = this.fall.geometry.getAttribute('position'), uv = this.fall.geometry.getAttribute('uv')
    for (let i = 0; i < positions.count; i++) {
      const t = 1 - uv.getY(i), across = uv.getX(i) - 0.5
      positions.setXYZ(i, across * this.width * (0.65 + strength * 0.35) * (1 - t * 0.09),
        -reach * t, top - drop * t * t + Math.sin(across * 38 - time * 8 + t * 9) * 0.006 * t)
    }
    positions.needsUpdate = true; this.fall.geometry.computeVertexNormals()
    const transform = new THREE.Object3D()
    for (let i = 0; i < 40; i++) {
      const phase = (time * (0.9 + i % 4 * 0.12) + i * 0.618) % 1
      const across = Math.sin(i * 2.4) * this.width * 0.46
      transform.position.set(across, -reach + Math.cos(i * 2.4) * phase * 0.16, receivingZ + Math.sin(phase * Math.PI) * (0.10 + i % 5 * 0.025))
      transform.scale.setScalar(Math.sin(phase * Math.PI) * strength * (0.5 + i % 3 * 0.25))
      transform.updateMatrix(); this.spray.setMatrixAt(i, transform.matrix)
    }
    this.spray.instanceMatrix.needsUpdate = true
    this.rings.forEach((ring, i) => {
      const phase = (time * 0.65 + i / 3) % 1
      ring.visible = enabled; ring.position.set(0, -reach, receivingZ + 0.012)
      ring.scale.set(this.width * (0.3 + phase * 0.65), 0.06 + phase * 0.28, 1)
      ;(ring.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.5 * strength
    })
  }

  setAppearance(color: THREE.Color): void { this.waterMaterial.color.copy(color).lerp(new THREE.Color(0xffffff), 0.3) }

  dispose(): void {
    this.spray.dispose(); this.geometries.forEach(item => item.dispose()); this.materials.forEach(item => item.dispose()); this.group.clear()
  }
}
