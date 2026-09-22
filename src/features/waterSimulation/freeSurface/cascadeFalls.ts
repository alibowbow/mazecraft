import * as THREE from 'three'
import { CASCADE_FLOORS, CASCADE_SPILLS, type CascadeState } from './cascadeTypes'

interface Curtain {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>
  uniforms: { uFallTravel: THREE.IUniform<number>; uFallStrength: THREE.IUniform<number> }
  travel: number
}

/** All visible falling water and splash motion share the hydraulic clock. */
export class CascadeFalls {
  readonly group = new THREE.Group()
  private readonly curtains: Curtain[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[][] = []
  private readonly particles: THREE.InstancedMesh
  private readonly particleState = new Float32Array(120 * 4)
  private readonly foamTexture: THREE.DataTexture
  private readonly sourceWater: THREE.Mesh
  private readonly fountainWater: THREE.Mesh
  private readonly receiverWater: THREE.Mesh
  private readonly fountainChannel: THREE.Mesh
  private readonly fountainJet: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>
  private readonly fountainUniforms: Curtain['uniforms']
  private fountainTravel = 0
  private previousTime: number | null = null
  private readonly transform = new THREE.Object3D()
  private readonly cameraQuaternion = new THREE.Quaternion()

  constructor(private readonly water: THREE.MeshPhysicalMaterial) {
    this.group.name = 'cascade-waterfalls-and-white-spray'
    const normalB = (water.userData.cascadeNormalMaps as THREE.Texture[] | undefined)?.[1] ?? water.normalMap
    const flowingMaterial = () => {
      const material = water.clone()
      material.side = THREE.DoubleSide; material.depthWrite = false
      material.thickness = 0.075; material.envMapIntensity = 1.15
      material.opacity = 0.96
      const uniforms = { uFallTravel: { value: 0 }, uFallStrength: { value: 1 } }
      material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms, { uFallNormalB: { value: normalB } })
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFallUv;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFallUv = uv;')
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
          varying vec2 vFallUv;
          uniform sampler2D uFallNormalB;
          uniform float uFallTravel;
          uniform float uFallStrength;
        `).replace('#include <normal_fragment_maps>', `
          vec2 fallingUv = vec2(vFallUv.x * 0.68, vFallUv.y * 0.56 + uFallTravel);
          vec3 a = texture2D(normalMap, fallingUv).xyz * 2.0 - 1.0;
          vec3 b = texture2D(uFallNormalB, fallingUv * vec2(-1.17, 0.81) + vec2(0.31, uFallTravel * 0.17)).xyz * 2.0 - 1.0;
          vec3 fallNormal = normalize(vec3((a.xy * 0.68 + b.xy * 0.32) * (0.19 + uFallStrength * 0.12), 1.0));
          normal = normalize(tbn * fallNormal);
        `)
      }
      material.customProgramCacheKey = () => 'cascade-downward-water-curtain-v1'
      this.materials.push(material)
      return { material, uniforms }
    }
    for (let i = 0; i < 5; i++) {
      const { material, uniforms } = flowingMaterial()
      const geometry = new THREE.PlaneGeometry(1, 1, 12, 28)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = i < 3 ? `conserved-cascade-fall-${i}` : i === 3 ? 'upper-ivory-spout-water' : 'central-fountain-return'
      mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 3
      this.curtains.push({ mesh, uniforms, travel: 0 })
      this.group.add(mesh); this.geometries.push(geometry)
    }
    const addPool = (name: string, x: number, y: number, z: number, radiusX: number, radiusY: number) => {
      const geometry = new THREE.CircleGeometry(1, 64)
      const mesh = new THREE.Mesh(geometry, water)
      mesh.name = name; mesh.position.set(x, y, z); mesh.scale.set(radiusX, radiusY, 1); mesh.renderOrder = 2
      this.group.add(mesh); this.geometries.push(geometry)
      return mesh
    }
    this.sourceWater = addPool('upper-fountain-reservoir-water', 0, 3.65, 3.13, 0.36, 0.33)
    this.fountainWater = addPool('central-fountain-cup-water', 0, 0, 2.06, 0.22, 0.22)
    this.receiverWater = addPool('lower-receiving-trough-water', 0, -5.15, -0.42, 1.18, 0.58)
    const channelGeometry = new THREE.PlaneGeometry(0.14, 0.47)
    this.fountainChannel = new THREE.Mesh(channelGeometry, water)
    this.fountainChannel.position.set(0, -0.425, 2.065)
    this.fountainChannel.name = 'central-fountain-return-channel'; this.fountainChannel.renderOrder = 2
    this.group.add(this.fountainChannel); this.geometries.push(channelGeometry)
    const jet = flowingMaterial()
    this.fountainUniforms = jet.uniforms
    const jetGeometry = new THREE.CylinderGeometry(0.023, 0.035, 1, 16, 16, true)
    this.fountainJet = new THREE.Mesh(jetGeometry, jet.material)
    this.fountainJet.rotation.x = Math.PI / 2
    this.fountainJet.name = 'central-recirculating-fountain-jet'
    this.fountainJet.renderOrder = 3
    this.group.add(this.fountainJet); this.geometries.push(jetGeometry)

    const size = 32, alpha = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const distance = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1)
      const value = Math.round((1 - THREE.MathUtils.smoothstep(distance, 0.32, 1)) * 255), index = (y * size + x) * 4
      // Three samples alphaMap's green channel, so use a grayscale RGBA map.
      alpha[index] = alpha[index + 1] = alpha[index + 2] = value
      alpha[index + 3] = 255
    }
    this.foamTexture = new THREE.DataTexture(alpha, size, size, THREE.RGBAFormat)
    this.foamTexture.needsUpdate = true
    const foam = new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: this.foamTexture, transparent: true, opacity: 0.86, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })
    const sprayGeometry = new THREE.PlaneGeometry(1, 1)
    this.particles = new THREE.InstancedMesh(sprayGeometry, foam, 120)
    this.particles.name = 'white-cascade-impact-spray'; this.particles.frustumCulled = false; this.particles.renderOrder = 5
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.particles.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldQuaternion(this.cameraQuaternion)
      this.writeParticles()
    }
    this.group.add(this.particles); this.geometries.push(sprayGeometry); this.materials.push(foam)
    for (let impact = 0; impact < 6; impact++) {
      const rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = []
      for (let i = 0; i < 2; i++) {
        const geometry = new THREE.RingGeometry(0.94, 1, 48)
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
        const ring = new THREE.Mesh(geometry, material)
        ring.renderOrder = 4; ring.visible = false
        this.group.add(ring); this.geometries.push(geometry); this.materials.push(material); rings.push(ring)
      }
      this.rings.push(rings)
    }
  }

  private writeParticles(): void {
    for (let i = 0; i < 120; i++) {
      const offset = i * 4
      this.transform.position.fromArray(this.particleState, offset)
      this.transform.quaternion.copy(this.cameraQuaternion)
      this.transform.scale.setScalar(this.particleState[offset + 3])
      this.transform.updateMatrix()
      this.particles.setMatrixAt(i, this.transform.matrix)
    }
    this.particles.instanceMatrix.needsUpdate = true
  }

  private impact(index: number, x: number, y: number, z: number, rate: number, width: number, time: number): void {
    const strength = THREE.MathUtils.clamp(rate / 0.13, 0, 1), enabled = rate > 0.00001
    this.rings[index].forEach((ring, i) => {
      const phase = (time * 0.78 + i * 0.5) % 1
      ring.visible = enabled
      ring.position.set(x, y, z + 0.012)
      ring.scale.set(0.11 + phase * width * 0.62, 0.08 + phase * 0.26, 1)
      ring.material.opacity = (1 - phase) * strength * 0.36
    })
    for (let i = 0; i < 20; i++) {
      const phase = (time * (0.82 + (i % 4) * 0.09) + i * 0.618) % 1
      const angle = i * 2.39996, spread = 0.06 + phase * (0.08 + width * 0.16)
      const offset = (index * 20 + i) * 4
      this.particleState[offset] = x + Math.cos(angle) * spread * (0.7 + width * 0.55)
      this.particleState[offset + 1] = y + Math.sin(angle) * spread * 0.7
      this.particleState[offset + 2] = z + 0.016 + Math.sin(phase * Math.PI) * (0.035 + strength * 0.16) * (0.4 + i % 5 * 0.12)
      this.particleState[offset + 3] = enabled ? (0.018 + (i % 3) * 0.008) * strength * Math.sin(phase * Math.PI) : 0
    }
  }

  private curtain(index: number, x: number, startY: number, endY: number, top: number, bottom: number, width: number, rate: number, dt: number, time: number): void {
    const curtain = this.curtains[index]
    curtain.mesh.visible = rate > 0.00001 && top > bottom + 0.01
    if (!curtain.mesh.visible) return
    const energy = THREE.MathUtils.clamp(rate / 0.14, 0, 1)
    curtain.travel += dt * (0.28 + Math.sqrt(Math.max(0, rate)) * 0.95)
    curtain.uniforms.uFallTravel.value = curtain.travel
    curtain.uniforms.uFallStrength.value = energy
    const positions = curtain.mesh.geometry.getAttribute('position'), uv = curtain.mesh.geometry.getAttribute('uv')
    for (let i = 0; i < positions.count; i++) {
      const t = 1 - uv.getY(i), across = uv.getX(i) - 0.5
      const edge = Math.sin(t * 11 - time * 3.7 + across * 8) * 0.008 * energy
      positions.setXYZ(i, x + across * width * (1 - t * 0.10) + edge,
        THREE.MathUtils.lerp(startY, endY, t),
        THREE.MathUtils.lerp(top, bottom + 0.014, t * t))
    }
    positions.needsUpdate = true; curtain.mesh.geometry.computeVertexNormals()
  }

  update(state: CascadeState): void {
    let dt = this.previousTime === null ? 0 : Math.max(0, state.time - this.previousTime)
    if (this.previousTime !== null && state.time < this.previousTime) {
      this.curtains.forEach(curtain => { curtain.travel = 0 }); this.fountainTravel = 0; dt = 0
    }
    this.previousTime = state.time
    const levels = CASCADE_FLOORS.map((floor, index) => floor + state.depths[index])
    for (let index = 0; index < 3; index++) {
      const spill = CASCADE_SPILLS[index], bottom = index === 2 ? -0.42 : levels[index + 1]
      const width = spill.width * THREE.MathUtils.clamp(0.35 + Math.sqrt(state.discharge[index] / 0.12) * 0.65, 0.35, 1)
      this.curtain(index, spill.x, spill.y + 0.075, spill.landingY, levels[index], bottom, width, state.discharge[index], dt, state.time)
      this.impact(index, spill.x, spill.landingY, bottom, state.discharge[index], width, state.time)
    }
    this.curtain(3, 0, 3.10, 2.72, 3.12, levels[0], 0.25, state.sourceRate, dt, state.time)
    this.impact(3, 0, 2.72, levels[0], state.sourceRate, 0.28, state.time)
    const pumpRate = state.depths[1] > 0.05 ? Math.min(0.09, state.sourceRate * 0.55) : 0
    this.curtain(4, 0, -0.66, -0.97, 2.065, levels[1], 0.15, pumpRate, dt, state.time)
    this.impact(4, 0, -0.97, levels[1], pumpRate, 0.20, state.time)
    this.impact(5, 0, 0, 2.06, pumpRate * 0.75, 0.19, state.time)
    this.fountainJet.visible = pumpRate > 0.00001
    this.fountainChannel.visible = this.fountainJet.visible
    const jetHeight = 0.25 + Math.sqrt(pumpRate) * 0.95
    this.fountainJet.scale.set(1, jetHeight, 1)
    this.fountainJet.position.set(0, 0, 2.06 + jetHeight / 2)
    this.fountainTravel -= dt * (0.26 + Math.sqrt(pumpRate) * 0.8)
    this.fountainUniforms.uFallTravel.value = this.fountainTravel
    this.fountainUniforms.uFallStrength.value = Math.min(1, pumpRate / 0.07)
    this.sourceWater.visible = true
    this.fountainWater.visible = state.depths[1] > 0.005
    this.receiverWater.visible = state.depths[2] > 0.005
    for (const curtain of this.curtains) {
      curtain.mesh.material.color.copy(this.water.color)
      curtain.mesh.material.attenuationColor.copy(this.water.attenuationColor)
      curtain.mesh.material.attenuationDistance = this.water.attenuationDistance
    }
    this.fountainJet.material.color.copy(this.water.color)
    this.fountainJet.material.attenuationColor.copy(this.water.attenuationColor)
    this.fountainJet.material.attenuationDistance = this.water.attenuationDistance
    this.writeParticles()
  }

  // Spill lips and fountain bowls have fixed elevations; only the surrounding
  // retaining walls respond to the wall-height control.
  setWallHeight(_multiplier: number): void {}

  dispose(): void {
    this.foamTexture.dispose(); this.particles.dispose()
    this.geometries.forEach(geometry => geometry.dispose())
    this.materials.forEach(material => material.dispose())
    this.group.clear()
  }
}
