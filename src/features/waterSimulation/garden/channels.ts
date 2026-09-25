import * as THREE from 'three'
import type { GardenLayout } from './layout'
import { PROFILE_SAMPLES, transportEdges, type GardenState } from './simulation'
import { resample, tangents } from './geometry'
import { createChannelWaterMaterial, type ChannelUniforms, type GardenUniforms } from './materials'

/** Water inside every chute and noria trough, fed by the transit lines. */
export class GardenChannels {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  private readonly texture: THREE.DataTexture
  private readonly data: Uint16Array
  private readonly own: ChannelUniforms
  private readonly rows: number

  constructor(layout: GardenLayout, uniforms: GardenUniforms) {
    const edges = transportEdges(layout)
    this.rows = Math.max(1, edges.length)
    this.data = new Uint16Array(PROFILE_SAMPLES * this.rows)
    this.texture = new THREE.DataTexture(this.data, PROFILE_SAMPLES, this.rows, THREE.RedFormat, THREE.HalfFloatType)
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter
    this.texture.needsUpdate = true
    const positions: number[] = [], along: number[] = [], rows: number[] = [], sides: number[] = [], lengths: number[] = [], widths: number[] = []
    const index: number[] = []
    const across = [-1, -0.5, 0, 0.5, 1]
    edges.forEach((edge, row) => {
      const width = (edge.kind === 'lift' ? layout.lifts[edge.lift!].width * 0.9 : edge.width) * 0.96
      const points = resample(edge.path!, 0.08)
      const t = tangents(points)
      let length = 0
      const walked = points.map((p, i) => (length += i ? Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1], p[2] - points[i - 1][2]) : 0))
      const base = positions.length / 3
      points.forEach((p, i) => across.forEach(side => {
        positions.push(p[0] - t[i][1] * side * width / 2, p[1] + t[i][0] * side * width / 2, p[2])
        // Texel centres: sample 0 is the intake end, the last the outfall.
        along.push((0.5 + walked[i] / length * (PROFILE_SAMPLES - 1)) / PROFILE_SAMPLES)
        rows.push((row + 0.5) / this.rows); sides.push(side); lengths.push(length); widths.push(width)
      }))
      const n = across.length
      // A lift carries its water in buckets or screw pockets (devices.ts):
      // only its trough at the top runs as open channel.
      const top = Math.max(...points.map(p => p[2]))
      const first = edge.kind === 'lift' ? Math.max(0, points.findIndex(p => p[2] >= top - 0.3)) : 0
      for (let i = first; i + 1 < points.length; i++) for (let k = 0; k + 1 < n; k++) {
        const a = base + i * n + k, b = a + 1, c = a + n, d = c + 1
        index.push(a, c, b, b, c, d)
      }
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => i % 3 === 2 ? 1 : 0), 3))
    geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
    geometry.setAttribute('aRow', new THREE.Float32BufferAttribute(rows, 1))
    geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1))
    geometry.setAttribute('aLength', new THREE.Float32BufferAttribute(lengths, 1))
    geometry.setAttribute('aWidth', new THREE.Float32BufferAttribute(widths, 1))
    geometry.setIndex(index)
    geometry.computeBoundingSphere()
    const { material, uniforms: own } = createChannelWaterMaterial(uniforms, this.texture)
    this.own = own
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'garden-channel-water'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.visible = edges.length > 0
  }

  setTint(color: THREE.Color): void { this.own.uChannelTint.value.copy(color) }

  update(state: GardenState): void {
    const flow = state.channelFlow
    for (let i = 0; i < this.data.length && i < flow.length; i++) this.data[i] = THREE.DataUtils.toHalfFloat(Math.max(0, flow[i]))
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose()
  }
}
