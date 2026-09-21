import * as THREE from 'three'

/** Static studio assets are generated once; no image/network dependency. */
export class StudioStage {
  readonly group = new THREE.Group()
  readonly material: THREE.MeshStandardMaterial
  private readonly textures: THREE.Texture[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []

  constructor(centerX: number, centerY: number, width: number, height: number) {
    const textureSize = 512
    const color = new Uint8Array(textureSize * textureSize * 4)
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
      const stone = noise(x / 75, y / 75) * 11 + noise(x / 21, y / 21) * 5 + hash(x, y) * 7
      color[i] = color[i + 1] = color[i + 2] = Math.round(231 + stone)
      color[i + 3] = 255
    }
    const grain = new THREE.DataTexture(color, textureSize, textureSize)
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping
    grain.minFilter = THREE.LinearMipmapLinearFilter; grain.magFilter = THREE.LinearFilter
    grain.generateMipmaps = true; grain.repeat.set(8, 8); grain.needsUpdate = true
    grain.colorSpace = THREE.SRGBColorSpace
    this.textures.push(grain)
    this.material = new THREE.MeshStandardMaterial({color:'#edd0b8',map:grain,roughness:0.93,metalness:0,bumpMap:grain,bumpScale:0.024})
    const geometry = new THREE.PlaneGeometry(width * 8, height * 8)
    const floor = new THREE.Mesh(geometry, this.material)
    floor.name = 'limestone-studio-ground'; floor.position.set(centerX,centerY,-0.71); floor.receiveShadow = true
    this.group.add(floor); this.geometries.push(geometry); this.materials.push(this.material)

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
        const shadowMaterial=new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false,opacity:.46,toneMapped:false})
        const shadowGeometry=new THREE.PlaneGeometry(width*2.45,height*2.45)
        const shadow=new THREE.Mesh(shadowGeometry,shadowMaterial)
        shadow.position.set(centerX-width*.1,centerY+height*.03,-.705)
        shadow.name='soft-botanical-shadows'
        this.group.add(shadow);this.geometries.push(shadowGeometry);this.materials.push(shadowMaterial)
      }
    }
  }
  dispose() {
    for(const item of [...this.textures,...this.geometries,...this.materials]) item.dispose()
    this.group.clear()
  }
}

/** Broad photographic softboxes give curved glaze and water readable reflections. */
export function createAtelierEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const environment = new THREE.Scene()
  environment.background = new THREE.Color('#a7a098')
  const panels: THREE.Mesh[]=[]
  const panel=(w:number,h:number,position:THREE.Vector3,color:string,intensity:number)=>{
    const material=new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(intensity),side:THREE.DoubleSide})
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),material)
    mesh.position.copy(position);mesh.lookAt(0,0,0);environment.add(mesh);panels.push(mesh)
  }
  panel(10,7,new THREE.Vector3(-5,3,8),'#fff1df',4.2)
  panel(3,8,new THREE.Vector3(6,-2,4),'#d9efff',1.8)
  panel(12,3,new THREE.Vector3(1,8,6),'#ffffff',2.3)
  const pmrem=new THREE.PMREMGenerator(renderer)
  const target=pmrem.fromScene(environment,.055,.1,100)
  pmrem.dispose()
  for(const mesh of panels){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose()}
  return target
}
