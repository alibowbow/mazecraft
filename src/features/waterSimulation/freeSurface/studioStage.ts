import * as THREE from 'three'
import { StudioBotanicals } from './studioBotanicals'

/** Static studio assets are generated once; no image/network dependency. */
export class StudioStage {
  readonly group = new THREE.Group()
  readonly material: THREE.MeshStandardMaterial
  private readonly textures: THREE.Texture[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly botanicals: StudioBotanicals

  constructor(centerX: number, centerY: number, width: number, height: number) {
    const textureSize = 512
    const color = new Uint8Array(textureSize * textureSize * 4)
    const relief = new Uint8Array(textureSize * textureSize)
    const hash = (x: number, y: number) => {
      const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
      return value - Math.floor(value)
    }
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y)
      const a = x - ix, b = y - iy, u = a * a * (3 - 2 * a), v = b * b * (3 - 2 * b)
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), u), THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), u), v)
    }
    for (let y = 0; y < textureSize; y++) for (let x = 0; x < textureSize; x++) {
      const i = (y * textureSize + x) * 4
      const cloud = noise(x / 92, y / 92), aggregate = noise(x / 19, y / 19)
      const grain = hash(x, y)
      const pore = Math.max(0, (hash(Math.floor(x / 3), Math.floor(y / 3)) - 0.96) / 0.04)
      const stone = 234 + cloud * 9 + aggregate * 6 + grain * 5 - pore * 15
      color[i] = color[i + 1] = color[i + 2] = Math.round(stone)
      color[i + 3] = 255
      relief[y * textureSize + x] = Math.round(105 + aggregate * 18 + grain * 26 - pore * 34)
    }
    const grain = new THREE.DataTexture(color, textureSize, textureSize)
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping
    grain.minFilter = THREE.LinearMipmapLinearFilter; grain.magFilter = THREE.LinearFilter
    grain.generateMipmaps = true; grain.repeat.set(width * 8 / 5.5, height * 8 / 5.5); grain.needsUpdate = true
    grain.colorSpace = THREE.SRGBColorSpace
    const bump = new THREE.DataTexture(relief, textureSize, textureSize, THREE.RedFormat)
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping
    bump.minFilter = THREE.LinearMipmapLinearFilter; bump.magFilter = THREE.LinearFilter
    bump.generateMipmaps = true; bump.repeat.copy(grain.repeat); bump.needsUpdate = true
    this.textures.push(grain, bump)
    this.material = new THREE.MeshStandardMaterial({color:'#edd0b8',map:grain,roughness:0.94,metalness:0,bumpMap:bump,bumpScale:0.009,envMapIntensity:0.32})
    const geometry = new THREE.PlaneGeometry(width * 8, height * 8)
    const floor = new THREE.Mesh(geometry, this.material)
    floor.name = 'limestone-studio-ground'; floor.position.set(centerX,centerY,-0.71); floor.receiveShadow = true
    this.group.add(floor); this.geometries.push(geometry); this.materials.push(this.material)
    this.botanicals = new StudioBotanicals(centerX, centerY, width, height)
    this.group.add(this.botanicals.group)

    // Soft out-of-frame foliage casts an editorial daylight pattern on the
    // tabletop. This is a baked shadow decal, never placed over the sculpture.
    if (typeof document !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined') {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.filter = 'blur(7px)'
        ctx.shadowColor = 'rgba(39,31,22,0.15)'; ctx.shadowBlur = 13
        ctx.strokeStyle = 'rgba(39,31,22,0.12)'; ctx.fillStyle = 'rgba(39,31,22,0.19)'
        ctx.lineCap = 'round'
        const branch = (x: number,y: number,angle: number,length: number,depth: number,seed: number) => {
          const xx=x+Math.cos(angle)*length, yy=y+Math.sin(angle)*length
          ctx.lineWidth=Math.max(2,depth*1.8); ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo((x+xx)/2+12,(y+yy)/2,xx,yy);ctx.stroke()
          for(let i=1;i<=5;i++) {
            const t=i/6, side=i%2?1:-1, a=angle+side*.85
            const lx=x+(xx-x)*t,ly=y+(yy-y)*t
            ctx.save();ctx.translate(lx,ly);ctx.rotate(a);ctx.beginPath();ctx.ellipse(18,0,22+hash(seed,i)*12,6+hash(i,seed)*4,0,0,Math.PI*2);ctx.fill();ctx.restore()
          }
          if(depth>0){branch(xx,yy,angle-.56,length*.72,depth-1,seed+3);branch(xx,yy,angle+.47,length*.68,depth-1,seed+7)}
        }
        branch(1000,110,2.64,270,3,17)
        branch(50,1030,-1.02,235,2,31)
        const shadowTexture=new THREE.CanvasTexture(canvas)
        this.textures.push(shadowTexture)
        const shadowMaterial=new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false,opacity:.24,toneMapped:false})
        const shadowGeometry=new THREE.PlaneGeometry(width*2.45,height*2.45)
        const shadow=new THREE.Mesh(shadowGeometry,shadowMaterial)
        shadow.position.set(centerX-width*.1,centerY+height*.03,-.705)
        shadow.name='soft-botanical-shadows'
        this.group.add(shadow);this.geometries.push(shadowGeometry);this.materials.push(shadowMaterial)
      }
    }
  }
  dispose() {
    this.botanicals.dispose()
    for(const item of [...this.textures,...this.geometries,...this.materials]) item.dispose()
    this.group.clear()
  }
}

/** Bright courtyard fill and window strips keep glaze luminous from every angle. */
export function createAtelierEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const environment = new THREE.Scene()
  environment.background = new THREE.Color('#b9cbd4')
  const panels: THREE.Mesh[]=[]
  const panel=(w:number,h:number,position:THREE.Vector3,color:string,intensity:number)=>{
    const material=new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(intensity),side:THREE.DoubleSide})
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),material)
    mesh.position.copy(position);mesh.lookAt(0,0,0);environment.add(mesh);panels.push(mesh)
  }
  panel(9,6,new THREE.Vector3(-5,3,8),'#fff1df',1.4)
  // The strip borders the default mirror direction. Small real surface
  // slopes catch its bright edge without whitening the entire flat basin.
  // Keep it in front of the broad softbox at the same angular size: an
  // environment capture also depth-tests these panels against one another.
  panel(.432,4.5,new THREE.Vector3(-4.005,4.59,7.2),'#fffaf1',8)
  panel(3,7,new THREE.Vector3(6,-2,4),'#e7f1f5',0.85)
  panel(10,2.4,new THREE.Vector3(1,8,6),'#ffffff',1.2)
  panel(.4,5,new THREE.Vector3(5,-4,6),'#ffffff',3.8)
  const pmrem=new THREE.PMREMGenerator(renderer)
  const target=pmrem.fromScene(environment,.055,.1,100)
  pmrem.dispose()
  for(const mesh of panels){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose()}
  return target
}
