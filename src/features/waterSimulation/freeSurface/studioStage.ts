import * as THREE from 'three'
import { StudioBotanicals } from './studioBotanicals'
import { createGardenSky } from '../garden/environment'
import { STUDIO_SAND } from './lookdev'

/** Static studio assets are generated once; no image/network dependency. */
export class StudioStage {
  readonly group = new THREE.Group()
  readonly material: THREE.MeshStandardMaterial
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly botanicals: StudioBotanicals

  constructor(centerX: number, centerY: number, width: number, height: number, groundZ = -0.665) {
    // Warm, lit sand that receives real shadows, matching the water gardens.
    this.material = new THREE.MeshStandardMaterial({ color: STUDIO_SAND, roughness: 0.93, envMapIntensity: 0.6 })
    const geometry = new THREE.PlaneGeometry(width * 8, height * 8)
    const floor = new THREE.Mesh(geometry, this.material)
    floor.name = 'sand-studio-ground'; floor.position.set(centerX, centerY, groundZ)
    floor.receiveShadow = true
    this.group.add(floor); this.geometries.push(geometry); this.materials.push(this.material)
    this.botanicals = new StudioBotanicals(centerX, centerY, width, height)
    this.botanicals.group.position.z = groundZ + 0.705
    this.group.add(this.botanicals.group)
  }
  dispose() {
    this.botanicals.dispose()
    for(const item of [...this.geometries,...this.materials]) item.dispose()
    this.group.clear()
  }
}

/** The same daylight courtyard sky the water gardens reflect. */
export function createAtelierEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  return createGardenSky(renderer, { sun: [-0.72, 0.30, 1.35], sunColor: new THREE.Color(0xfff4e2), warmth: 0.2 })
}
