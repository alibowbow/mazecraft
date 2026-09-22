import * as THREE from 'three'
import { StudioBotanicals } from './studioBotanicals'
import { studioHdri } from './cascadeMaterials'
import { STUDIO_BACKGROUND } from './lookdev'

/** Static studio assets are generated once; no image/network dependency. */
export class StudioStage {
  readonly group = new THREE.Group()
  readonly material: THREE.MeshBasicMaterial
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly botanicals: StudioBotanicals

  constructor(centerX: number, centerY: number, width: number, height: number, groundZ = -0.665) {
    // An untextured display-white sweep: object materials never tint it.
    this.material = new THREE.MeshBasicMaterial({ color: STUDIO_BACKGROUND, toneMapped: false })
    const geometry = new THREE.PlaneGeometry(width * 8, height * 8)
    const floor = new THREE.Mesh(geometry, this.material)
    floor.name = 'limestone-studio-ground'; floor.position.set(centerX,centerY,groundZ)
    this.group.add(floor); this.geometries.push(geometry); this.materials.push(this.material)
    const shadowMaterial = new THREE.ShadowMaterial({color:'#394654',opacity:0.60,depthWrite:false,toneMapped:false,shadowSide:THREE.BackSide})
    const receiver = new THREE.Mesh(geometry, shadowMaterial)
    receiver.name = 'studio-ground-shadow-receiver'
    receiver.position.set(centerX,centerY,groundZ + 0.001)
    receiver.receiveShadow = true
    this.group.add(receiver); this.materials.push(shadowMaterial)
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

/** Bright courtyard fill and window strips keep glaze luminous from every angle. */
export function createAtelierEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  return studioHdri(renderer)
}
