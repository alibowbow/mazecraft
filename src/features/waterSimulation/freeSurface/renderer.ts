import * as THREE from 'three'
import type { FluidLayout, FluidSnapshot } from './types'
import { buildSolidMask, WATER_WALL_VISIBILITY } from './surfaceField'
import { FreeSurfacePresentation3D, SURFACE_FIELD_PADDING } from './presentation3d'
import { SurfaceTrackball } from './camera3d'
import { buildFunnelVisual } from './funnelVisual'
import { DEFAULT_WATER_APPEARANCE, type WaterAppearance } from './appearance'

type SurfaceStyle = 'calm' | 'natural' | 'dynamic'

const densityVertex = /* glsl */ `
  attribute vec2 center;
  attribute vec2 velocity;
  uniform float uRadius;
  uniform sampler2D uClearance;
  uniform vec4 uWallBounds;
  uniform float uClearanceScale;
  varying vec2 vLocal;
  varying vec2 vCenter;
  varying vec2 vPoint;
  varying float vSpeed;
  varying float vClearance;
  void main() {
    float speed = length(velocity);
    // Geometry represents occupied water, independent of velocity. Stretching
    // a falling particle in both directions inflated upstream water and joined
    // empty gaps. Retain the original smooth stationary kernel for every speed.
    // Keep front-face winding after converting downward-positive maze Y.
    vec2 offset = vec2(-position.x, position.y) * uRadius;
    vLocal = position.xy;
    vCenter = center;
    vPoint = center + offset;
    vSpeed = min(speed / 12.0, 1.0);
    vec2 wallUv = (center - uWallBounds.xy) / uWallBounds.zw;
    vClearance = 0.0;
    if (all(greaterThanEqual(wallUv, vec2(0.0))) && all(lessThanEqual(wallUv, vec2(1.0)))) {
      vClearance = texture2D(uClearance, wallUv).r * uClearanceScale;
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPoint.x, -vPoint.y, 0.0, 1.0);
  }
`

const densityFragment = /* glsl */ `
  ${WATER_WALL_VISIBILITY}
  varying vec2 vLocal;
  varying vec2 vCenter;
  varying vec2 vPoint;
  varying float vSpeed;
  varying float vClearance;
  void main() {
    float r2 = dot(vLocal, vLocal);
    if (r2 >= 1.0) discard;
    vec2 segment = vPoint - vCenter;
    // The cached lower bound proves the entire segment misses every solid.
    // Close to a wall, retain all eight original visibility samples.
    if (dot(segment, segment) >= vClearance * vClearance
      && clearSegment(vCenter, vPoint) < 0.5) discard;
    float kernel = pow(1.0 - r2, 3.0) * 0.34;
    gl_FragColor = vec4(kernel, kernel * vSpeed, 0.0, kernel);
  }
`

const waterVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.99, 1.0);
  }
`

const filterWeightsFragment = /* glsl */ `
  ${WATER_WALL_VISIBILITY}
  uniform vec2 uStep;
  uniform vec2 uCenter;
  uniform vec2 uViewSize;
  varying vec2 vUv;
  vec2 mazeAt(vec2 uv) {
    vec2 p = uCenter + (uv - 0.5) * uViewSize;
    return vec2(p.x, -p.y);
  }
  void main() {
    vec2 here = mazeAt(vUv);
    // RGBA stores the four binary open-neighbour predicates. A half-valued
    // alpha marks a solid centre; it cannot be confused with binary 0/1.
    if (wallAt(here) > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.5); return; }
    vec4 weights = vec4(0.0);
    for (int i = -2; i <= 2; i++) {
      if (i == 0) continue;
      float offset = abs(i) == 1 ? 1.384615 : 3.230769;
      vec2 uv = vUv + uStep * offset * sign(float(i));
      vec2 there = mazeAt(uv);
      // Each filter segment is at most .113 cells long, shorter than two walls.
      float open = (1.0 - wallAt(there)) * (1.0 - wallAt((here + there) * 0.5));
      weights[i < 0 ? i + 2 : i + 1] = open;
    }
    gl_FragColor = weights;
  }
`

const filterFragment = /* glsl */ `
  uniform sampler2D uInput;
  uniform sampler2D uWeights;
  uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    vec4 weights = texture2D(uWeights, vUv);
    if (weights.a > 0.25 && weights.a < 0.75) { gl_FragColor = vec4(0.0); return; }
    vec2 sum = texture2D(uInput, vUv).rg * 0.227027;
    float weight = 0.227027;
    for (int i = -2; i <= 2; i++) {
      if (i == 0) continue;
      float offset = abs(i) == 1 ? 1.384615 : 3.230769;
      float w = abs(i) == 1 ? 0.316216 : 0.070270;
      vec2 uv = vUv + uStep * offset * sign(float(i));
      float open = weights[i < 0 ? i + 2 : i + 1];
      sum += texture2D(uInput, uv).rg * w * open;
      weight += w * open;
    }
    vec2 field = sum / weight;
    gl_FragColor = vec4(field, smoothstep(0.095, 0.135, field.r), 1.0);
  }
`

const waterFragment = /* glsl */ `
  uniform sampler2D uDensity;
  uniform vec2 uTexel;
  uniform vec2 uCenter;
  uniform vec2 uViewSize;
  uniform vec2 uMazeSize;
  uniform float uStyle;
  uniform float uTime;
  uniform float uOpticalLod;
  uniform float uOpacity;
  uniform float uClearOptics;
  uniform float uPresentation3D;
  uniform float uRippleDetail;
  uniform vec3 uViewDirection;
  uniform vec3 uAbsorption;
  uniform vec3 uScatter;
  varying vec2 vUv;

  vec3 boardAt(vec2 maze) {
    // A quiet etched backing remains visible through the water. Refraction
    // samples this backing only, never geometry on the other side of a wall.
    vec2 cell = abs(fract(maze + 0.5) - 0.5);
    vec2 line = 1.0 - smoothstep(vec2(0.007), vec2(0.017), cell);
    float inside = step(0.0, maze.x) * step(maze.x, uMazeSize.x)
      * step(0.0, maze.y) * step(maze.y, uMazeSize.y);
    // Give clear water a softly shaded backing, with room for white glints.
    // Contrast belongs to the board and reflected light, never to water dye.
    vec3 color = mix(vec3(0.968, 0.971, 0.953), vec3(0.89, 0.902, 0.897), inside * uClearOptics);
    color -= max(line.x, line.y) * inside * mix(0.026, 0.065, uClearOptics);
    float dotMark = 1.0 - smoothstep(0.008, 0.020, length(fract(maze) - 0.5));
    color -= dotMark * inside * mix(0.045, 0.08, uClearOptics);
    return color;
  }
  float wetAt(vec2 uv) {
    return textureLod(uDensity, uv, uOpticalLod).b;
  }
  vec2 rippleSlope(vec2 point, float motion) {
    // Independent finite wave bands: analytic slopes need no displacement
    // texture, FFT or extra render pass. Derivative filtering removes detail
    // smaller than a screen pixel before it can shimmer on a distant board.
    float footprint = max(length(dFdx(point)), length(dFdy(point)));
    float detail = (1.0 - smoothstep(0.035, 0.13, footprint)) * uRippleDetail;
    vec2 broadA = vec2(0.38, -0.92);
    vec2 broadB = vec2(-0.81, -0.59);
    vec2 fineA = vec2(0.91, -0.41);
    vec2 fineB = vec2(-0.24, -0.97);
    vec2 slope = broadA * cos(dot(point, broadA) * 5.1 - uTime * 2.7) * 0.13;
    slope += broadB * cos(dot(point, broadB) * 8.7 - uTime * 3.9 + 1.8) * 0.085;
    slope += fineA * cos(dot(point, fineA) * 19.3 - uTime * 6.4 + 0.7) * 0.047 * detail;
    slope += fineB * cos(dot(point, fineB) * 33.7 - uTime * 9.1 + 2.4) * 0.024 * detail;
    // Measured speed controls agitation. Static pools receive no perpetual
    // invented current; every moving phase uses the accepted solver time.
    return slope * motion * (0.65 + uStyle * 0.65);
  }
  vec3 waterOptics3D(vec2 maze, vec3 normal, float thickness) {
    vec3 view = normalize(uViewDirection);
    float noV = max(0.06, dot(normal, view));
    float opticalPath = thickness / max(0.55, noV);
    vec3 transmission = exp(-uAbsorption * opticalPath);
    vec3 backing = boardAt(maze + normal.xy * vec2(0.10, -0.10));
    vec3 water = backing * transmission + uScatter * (1.0 - transmission);
    vec3 reflected = reflect(-view, normal);
    // A neutral studio environment suits a clear maze board. The user's dye
    // selection remains in transmission, never in a blanket white overlay.
    float environment = 0.28 + 0.54 * smoothstep(-0.65, 0.75, reflected.y);
    float fresnel = 0.02 + 0.98 * pow(1.0 - noV, 5.0);
    water = mix(water, vec3(environment), fresnel);
    vec3 light = normalize(vec3(-0.35, 0.45, 0.82));
    vec3 halfway = normalize(view + light);
    float noL = max(0.0, dot(normal, light));
    float noH = max(0.0, dot(normal, halfway));
    float voH = max(0.0, dot(view, halfway));
    float alpha = 0.055;
    float alpha2 = alpha * alpha;
    float denominator = noH * noH * (alpha2 - 1.0) + 1.0;
    float distribution = alpha2 / (3.14159265 * denominator * denominator);
    float visibility = 0.5 / max(0.01,
      noL * sqrt(noV * noV * (1.0 - alpha2) + alpha2)
      + noV * sqrt(noL * noL * (1.0 - alpha2) + alpha2));
    float sunFresnel = 0.02 + 0.98 * pow(1.0 - voH, 5.0);
    // Bound the narrow GGX glint to retain the refracted backing even when a
    // wave aligns with the light. This is an optical approximation, not foam.
    water += vec3(min(0.17, distribution * visibility * sunFresnel * noL * 0.32));
    return water;
  }
  void main() {
    vec2 world = uCenter + (vUv - 0.5) * uViewSize;
    vec2 maze = vec2(world.x, -world.y);
    float insideX = smoothstep(-0.04, 0.02, maze.x)
      * (1.0 - smoothstep(uMazeSize.x - 0.02, uMazeSize.x + 0.04, maze.x));
    float insideY = smoothstep(-0.04, 0.02, maze.y)
      * (1.0 - smoothstep(uMazeSize.y - 0.02, uMazeSize.y + 0.04, maze.y));
    float chamber = insideX * insideY;
    vec3 background = boardAt(maze);
    background += chamber * vec3(0.005, 0.008, 0.010);
    background -= dot(vUv - vec2(0.5, 0.55), vUv - vec2(0.5, 0.55)) * 0.025;

    vec2 field = texture2D(uDensity, vUv).rg;
    float density = field.r;
    float feather = max(fwidth(density) * 0.65, 0.006);
    float coverage = smoothstep(0.105 - feather, 0.105 + feather, density);
    if (coverage < 0.001) { gl_FragColor = vec4(background, 1.0); return; }

    // Shade the outside meniscus, never every particle's density peak.
    vec2 gradient = vec2(
      texture2D(uDensity, vUv + vec2(uTexel.x, 0.0)).r
        - texture2D(uDensity, vUv - vec2(uTexel.x, 0.0)).r,
      texture2D(uDensity, vUv + vec2(0.0, uTexel.y)).r
        - texture2D(uDensity, vUv - vec2(0.0, uTexel.y)).r
    );
    vec2 outward = -gradient / max(length(gradient), 0.0001);
    float distancePixels = (density - 0.105) / max(length(gradient) * 0.5, 0.0001);
    float rim = 1.0 - smoothstep(0.25, 1.6, distancePixels);
    float depthTone = clamp(maze.y / max(uMazeSize.y, 1.0), 0.0, 1.0);
    float speed = clamp(field.g / max(density, 0.001), 0.0, 1.0);

    // Optical thickness comes from the continuous silhouette, not raw density
    // peaks. Broad samples make a jet read as one curved ribbon of clear water.
    vec2 offset = vec2(0.15) / uViewSize;
    float left = wetAt(vUv - vec2(offset.x, 0.0));
    float right = wetAt(vUv + vec2(offset.x, 0.0));
    float down = wetAt(vUv - vec2(0.0, offset.y));
    float up = wetAt(vUv + vec2(0.0, offset.y));
    float core = wetAt(vUv);
    float thickness = 0.18 + core * 0.95 + depthTone * 0.20;
    vec3 normal = normalize(vec3(vec2(left - right, down - up) * 1.35, 1.0));
    float motion = smoothstep(0.025, 0.3, speed);
    vec3 water;
    if (uPresentation3D > 0.5) {
      vec2 slope = rippleSlope(world, motion) * (1.0 - rim * 0.6);
      normal = normalize(vec3(normal.xy / max(normal.z, 0.15) + slope, 1.0));
      water = waterOptics3D(maze, normal, thickness);
    } else {
      vec3 transmission = exp(-uAbsorption * thickness);
      float refractionScale = mix(0.035, 0.07, uClearOptics);
      vec3 transmittedBacking = boardAt(maze + normal.xy * vec2(refractionScale, -refractionScale));
      water = transmittedBacking * transmission;
      water += uScatter * (1.0 - transmission);
      float reflection = pow(max(dot(normal, normalize(vec3(-0.42, 0.32, 1.0))), 0.0), 36.0);
      float fresnel = 0.02 + 0.32 * pow(1.0 - normal.z, 3.0);
      // Colorless water transmits the warm backing and reflects neutral light.
      // Keep the original blue environment only for the named colored profiles.
      water = mix(water, mix(vec3(0.84, 0.95, 1.0), vec3(0.58), uClearOptics), fresnel);
      water += mix(vec3(0.15, 0.19, 0.20), vec3(0.028), uClearOptics)
        * reflection * (0.65 + uStyle * 0.20);
      // Only moving water receives a subtle travelling light band. Time is the
      // accepted physics snapshot's time, so pause and still pools stay still.
      float band = pow(0.5 + 0.5 * sin(maze.x * 6.4 + sin(maze.y * 3.1 - uTime * 1.7) * 0.8), 8.0);
      water += mix(vec3(0.035, 0.045, 0.05), vec3(0.016), uClearOptics)
        * band * motion * (0.6 + uStyle * 0.4);
    }
    float sky = pow(max(dot(outward, normalize(vec2(-0.3, 1.0))), 0.0), 4.0);
    water += mix(vec3(0.40, 0.43, 0.40), vec3(0.34), uClearOptics) * rim * sky * 0.72;
    water -= mix(vec3(0.045, 0.055, 0.045), vec3(0.18), uClearOptics)
      * rim * max(-outward.y, 0.0);
    // A broad reflected shade reveals the clear jet's curvature without dye,
    // a white fill, or a separate outline around each underlying particle.
    water -= vec3(0.14) * uClearOptics * (1.0 - normal.z);
    // The continuous silhouette reflects a dark surround opposite the light.
    // Include side-facing edges so vertical jets remain legible on the board.
    float shade = 1.0 - smoothstep(-0.35, 0.85, dot(outward, normalize(vec2(-0.3, 1.0))));
    water -= vec3(0.12) * uClearOptics * rim * shade;
    // Composite translucency against the actual backing. The canvas itself
    // stays opaque so the maze and controls do not bleed through the stage.
    gl_FragColor = vec4(mix(background, water, coverage * uOpacity), 1.0);
  }
`

/** Render the particle solver's free surface; no independent animation clock. */
export class FreeSurfaceRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  private readonly scene = new THREE.Scene()
  private readonly flatWalls = new THREE.Group()
  private readonly funnel: THREE.Group
  private readonly boardTarget: THREE.WebGLRenderTarget
  private presentation3d: FreeSurfacePresentation3D | null = null
  private viewMode: 'free-surface' | 'surface-3d' = 'free-surface'
  private readonly trackball = new SurfaceTrackball()
  private readonly densityScene = new THREE.Scene()
  private readonly densityTarget: THREE.WebGLRenderTarget
  private readonly filterScene = new THREE.Scene()
  private readonly weightsScene = new THREE.Scene()
  private readonly filterTarget: THREE.WebGLRenderTarget
  private readonly surfaceTarget: THREE.WebGLRenderTarget
  private readonly wallTexture: THREE.DataTexture
  private readonly clearanceTexture: THREE.DataTexture
  private readonly weightsX: THREE.WebGLRenderTarget
  private readonly weightsY: THREE.WebGLRenderTarget
  private readonly weightsMaterial: THREE.ShaderMaterial
  private readonly filterMaterial: THREE.ShaderMaterial
  private readonly densityMaterial: THREE.ShaderMaterial
  private readonly waterMaterial: THREE.ShaderMaterial
  private readonly particleGeometry = new THREE.InstancedBufferGeometry()
  private readonly particles: THREE.Mesh
  private readonly positionAttribute: THREE.InstancedBufferAttribute
  private readonly velocityAttribute: THREE.InstancedBufferAttribute
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly observer: ResizeObserver
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private width = 1
  private height = 1
  private viewWidth = 1
  private viewHeight = 1
  private zoom = 1
  private panX = 0
  private panY = 0
  private pinchDistance = 0
  private pinchCenterX = 0
  private pinchCenterY = 0
  private disposed = false
  private drawCalls = 0
  private triangles = 0
  private fieldDirty = true
  private boardDirty = true
  private surfaceBuilds = 0
  private opticalBuilds = 0
  private weightsDirty = true
  private weightBuilds = 0
  private cameraFrame: number | undefined
  private readonly wetBounds = new THREE.Vector4()

  constructor(
    private readonly mount: HTMLElement,
    private readonly layout: FluidLayout,
    private readonly quality: 'low' | 'high',
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0xf4f3ed, 1)
    this.renderer.info.autoReset = false
    this.canvas = this.renderer.domElement
    this.canvas.className = 'water-simulation-canvas free-surface-canvas'
    this.canvas.dataset.viewMode = 'free-surface'
    this.canvas.dataset.waterOpacity = String(DEFAULT_WATER_APPEARANCE.opacity)
    this.canvas.dataset.waterColor = 'transparent'
    this.canvas.dataset.waterOptics = 'clear'
    this.canvas.dataset.waterDetail = 'flat-meniscus'
    this.canvas.setAttribute('aria-label', '중력에 따라 흐르는 미로의 물. 드래그로 이동하고 스크롤 또는 두 손가락으로 확대합니다.')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none;'
    this.canvas.tabIndex = 0
    this.mount.appendChild(this.canvas)
    this.camera.position.z = 20

    this.densityTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.filterTarget = this.densityTarget.clone()
    this.surfaceTarget = this.densityTarget.clone()
    this.boardTarget = this.densityTarget.clone()
    this.weightsX = this.densityTarget.clone()
    this.weightsY = this.densityTarget.clone()
    this.weightsX.texture.minFilter = this.weightsX.texture.magFilter = THREE.NearestFilter
    this.weightsY.texture.minFilter = this.weightsY.texture.magFilter = THREE.NearestFilter
    // RG8 preserves the exact R/G precision used by these two passes while
    // halving their colour-buffer traffic. Coverage still uses RGBA8 below.
    this.densityTarget.texture.format = THREE.RGFormat
    this.filterTarget.texture.format = THREE.RGFormat
    // Mip-averaged binary coverage supplies a smooth thickness field without
    // the stepped rings caused by a few distant silhouette samples.
    this.surfaceTarget.texture.generateMipmaps = true
    this.surfaceTarget.texture.minFilter = THREE.LinearMipmapLinearFilter
    const mask = buildSolidMask(layout, Math.min(4096, this.renderer.capabilities.maxTextureSize))
    this.wallTexture = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat)
    this.wallTexture.minFilter = this.wallTexture.magFilter = THREE.NearestFilter
    this.wallTexture.unpackAlignment = 1
    this.wallTexture.needsUpdate = true
    this.clearanceTexture = new THREE.DataTexture(mask.clearance, mask.width, mask.height, THREE.RedFormat)
    this.clearanceTexture.minFilter = this.clearanceTexture.magFilter = THREE.NearestFilter
    this.clearanceTexture.unpackAlignment = 1
    this.clearanceTexture.needsUpdate = true
    const wallUniforms = {
      uWalls: { value: this.wallTexture },
      uWallBounds: { value: new THREE.Vector4(...mask.bounds) },
    }
    this.densityMaterial = new THREE.ShaderMaterial({
      vertexShader: densityVertex,
      fragmentShader: densityFragment,
      uniforms: {
        ...wallUniforms, uRadius: { value: layout.radius * 2.8 },
        uClearance: { value: this.clearanceTexture },
        uClearanceScale: { value: mask.clearanceScale },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    this.positionAttribute = new THREE.InstancedBufferAttribute(new Float32Array(layout.capacity * 2), 2).setUsage(THREE.DynamicDrawUsage)
    this.velocityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(layout.capacity * 2), 2).setUsage(THREE.DynamicDrawUsage)
    this.particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3))
    this.particleGeometry.setAttribute('center', this.positionAttribute)
    this.particleGeometry.setAttribute('velocity', this.velocityAttribute)
    this.particleGeometry.instanceCount = 0
    this.particles = new THREE.Mesh(this.particleGeometry, this.densityMaterial)
    this.particles.frustumCulled = false
    this.densityScene.add(this.particles)

    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      uniforms: {
        uDensity: { value: this.surfaceTarget.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2() },
        uViewSize: { value: new THREE.Vector2(1, 1) },
        uMazeSize: { value: new THREE.Vector2(layout.cols, layout.rows) },
        uStyle: { value: 0.5 },
        uTime: { value: 0 },
        uOpticalLod: { value: 0 },
        uOpacity: { value: DEFAULT_WATER_APPEARANCE.opacity },
        uClearOptics: { value: 1 },
        uPresentation3D: { value: 0 },
        uRippleDetail: { value: quality === 'high' ? 1 : 0.45 },
        uViewDirection: { value: new THREE.Vector3(0, 0, 1) },
        uAbsorption: { value: new THREE.Vector3(0.045, 0.045, 0.045) },
        uScatter: { value: new THREE.Vector3(0, 0, 0) },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.filterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: filterFragment,
      uniforms: {
        uInput: { value: this.densityTarget.texture },
        uWeights: { value: this.weightsX.texture },
        uStep: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.weightsMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: filterWeightsFragment,
      uniforms: {
        ...wallUniforms,
        uStep: { value: new THREE.Vector2() },
        uCenter: this.waterMaterial.uniforms.uCenter,
        uViewSize: this.waterMaterial.uniforms.uViewSize,
      },
      depthTest: false,
      depthWrite: false,
    })
    const screenGeometry = new THREE.PlaneGeometry(2, 2)
    const filter = new THREE.Mesh(screenGeometry, this.filterMaterial)
    filter.frustumCulled = false
    this.filterScene.add(filter)
    const weights = new THREE.Mesh(screenGeometry, this.weightsMaterial)
    weights.frustumCulled = false
    this.weightsScene.add(weights)
    const surface = new THREE.Mesh(screenGeometry, this.waterMaterial)
    surface.frustumCulled = false
    surface.renderOrder = -10
    this.scene.add(surface)
    this.geometries.push(screenGeometry)
    this.scene.add(this.flatWalls)
    this.buildWalls()
    this.funnel = buildFunnelVisual(layout)
    this.scene.add(this.funnel)

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('keydown', this.onKeyDown)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(mount)
    this.resize()
  }

  get metrics(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.drawCalls, triangles: this.triangles }
  }

  private buildWalls(): void {
    const fillPositions: number[] = []
    const fillColors: number[] = []
    const shadowPositions: number[] = []
    const shadowColors: number[] = []
    const addRect = (positions: number[], colors: number[], x0: number, y0: number, x1: number, y1: number, z: number, top: THREE.Color, bottom: THREE.Color) => {
      if (x1 <= x0 || y1 <= y0) return
      const vertices = [[x0, -y0], [x0, -y1], [x1, -y1], [x0, -y0], [x1, -y1], [x1, -y0]]
      for (let i = 0; i < vertices.length; i++) {
        positions.push(vertices[i][0], vertices[i][1], z)
        const c = i === 0 || i === 3 || i === 5 ? top : bottom
        colors.push(c.r, c.g, c.b)
      }
    }
    const top = new THREE.Color('#39444a')
    const bottom = new THREE.Color('#26363d')
    const rim = new THREE.Color('#6f7b7f')
    const shadow = new THREE.Color('#4e636b')
    for (const wall of this.layout.walls) {
      if (wall.kind === 'funnel') continue
      const { x0, y0, x1, y1 } = wall
      addRect(shadowPositions, shadowColors, x0 + 0.018, y0 + 0.024, x1 + 0.025, y1 + 0.035, 0.05, shadow, shadow)
      addRect(fillPositions, fillColors, x0, y0, x1, y1, 0.1, top, bottom)
      const bevel = Math.min(0.014, (x1 - x0) * 0.18, (y1 - y0) * 0.18)
      addRect(fillPositions, fillColors, x0, y0, x1, y0 + bevel, 0.11, rim, top)
      addRect(fillPositions, fillColors, x0, y0 + bevel, x0 + bevel, y1, 0.11, rim, top)
    }
    const addMesh = (positions: number[], colors: number[], shadowLayer: boolean) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: shadowLayer,
        opacity: shadowLayer ? 0.13 : 1,
        depthWrite: !shadowLayer,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.renderOrder = shadowLayer ? 0 : 1
      this.flatWalls.add(mesh)
      this.geometries.push(geometry)
      this.materials.push(material)
    }
    addMesh(shadowPositions, shadowColors, true)
    addMesh(fillPositions, fillColors, false)
  }

  render(snapshot: FluidSnapshot): void {
    if (this.disposed) return
    this.waterMaterial.uniforms.uTime.value = snapshot.diagnostics.time
    const count = Math.min(snapshot.count, this.layout.capacity)
    const positions = this.positionAttribute.array as Float32Array
    const velocities = this.velocityAttribute.array as Float32Array
    positions.set(snapshot.positions.subarray(0, count * 2))
    velocities.set(snapshot.velocities.subarray(0, count * 2))
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < count * 2; i += 2) {
      const x = positions[i], y = positions[i + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    this.wetBounds.set(minX, minY, maxX, maxY)
    this.positionAttribute.clearUpdateRanges()
    this.velocityAttribute.clearUpdateRanges()
    if (count > 0) {
      this.positionAttribute.addUpdateRange(0, count * 2)
      this.velocityAttribute.addUpdateRange(0, count * 2)
      this.positionAttribute.needsUpdate = true
      this.velocityAttribute.needsUpdate = true
    }
    this.particleGeometry.instanceCount = count
    this.fieldDirty = true
    this.draw()
  }

  setSurfaceStyle(style: SurfaceStyle): void {
    if (this.disposed) return
    this.waterMaterial.uniforms.uStyle.value = style === 'calm' ? 0 : style === 'dynamic' ? 1 : 0.5
    this.boardDirty = true
    this.draw()
  }

  setAppearance(appearance: WaterAppearance): void {
    if (this.disposed) return
    const color = appearance.color && /^#[0-9a-f]{6}$/i.test(appearance.color) ? appearance.color.toLowerCase() : null
    const profile = appearance.profile === 'aqua' ? 'aqua' : color ? 'tinted' : 'clear'
    const absorption = this.waterMaterial.uniforms.uAbsorption.value as THREE.Vector3
    const scatter = this.waterMaterial.uniforms.uScatter.value as THREE.Vector3
    if (profile === 'aqua') {
      absorption.set(1.25, 0.34, 0.18)
      scatter.set(0.035, 0.20, 0.24)
    } else if (color) {
      const tint = new THREE.Color(color)
      // Channel-dependent absorption retains the etched backing and meniscus;
      // changing dye never replaces the continuous surface with an opaque fill.
      absorption.set(0.12 + (1 - tint.r) * 2.2, 0.12 + (1 - tint.g) * 2.2, 0.12 + (1 - tint.b) * 2.2)
      scatter.set(tint.r * 0.24, tint.g * 0.24, tint.b * 0.24)
    } else {
      // At maze scale clear water has no visible dye. Equal, weak extinction
      // leaves the backing readable; only refraction and neutral light shape it.
      absorption.set(0.045, 0.045, 0.045)
      scatter.set(0, 0, 0)
    }
    const opacity = Number.isFinite(appearance.opacity)
      ? THREE.MathUtils.clamp(appearance.opacity, 0.1, 0.9)
      : DEFAULT_WATER_APPEARANCE.opacity
    this.waterMaterial.uniforms.uClearOptics.value = profile === 'clear' ? 1 : 0
    this.waterMaterial.uniforms.uOpacity.value = opacity
    this.canvas.dataset.waterColor = color ?? 'transparent'
    this.canvas.dataset.waterOpacity = String(opacity)
    this.canvas.dataset.waterOptics = profile
    this.boardDirty = true
    this.draw()
  }

  setInflow(enabled: boolean): void {
    if (this.disposed) return
    this.canvas.dataset.inflow = enabled ? 'enabled' : 'disabled'
    const indicator = this.funnel.getObjectByName('supply-glint')
    if (indicator) indicator.visible = enabled
    const indicator3d = this.presentation3d?.content.getObjectByName('supply-glint')
    if (indicator3d) indicator3d.visible = enabled
    this.draw()
  }

  setViewMode(mode: 'free-surface' | 'surface-3d'): void {
    if (this.disposed || this.viewMode === mode) return
    this.viewMode = mode
    this.weightsDirty = true
    this.waterMaterial.uniforms.uPresentation3D.value = mode === 'surface-3d' ? 1 : 0
    this.fieldDirty = true
    this.canvas.dataset.viewMode = mode
    this.canvas.dataset.waterDetail = mode === 'surface-3d' ? 'multiband-ripples' : 'flat-meniscus'
    this.canvas.setAttribute('aria-label', mode === 'surface-3d'
      ? '같은 미로 물의 입체 보기. 드래그로 회전하고 두 손가락으로 이동·확대합니다.'
      : '중력에 따라 흐르는 미로의 물. 드래그로 이동하고 스크롤 또는 두 손가락으로 확대합니다.')
    if (mode === 'surface-3d' && !this.presentation3d) {
      this.presentation3d = new FreeSurfacePresentation3D(this.layout, this.boardTarget.texture)
      this.presentation3d.content.add(this.funnel.clone(true))
    }
    this.resetCamera()
  }

  resize(): void {
    if (this.disposed) return
    this.configureSize()
    this.draw()
  }

  private configureSize(): void {
    this.width = Math.max(1, this.mount.clientWidth)
    this.height = Math.max(1, this.mount.clientHeight)
    // Bound GPU work on high-DPR and large displays without changing physics.
    const maxPixels = this.quality === 'high' ? 1_600_000 : 900_000
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.5 : 1,
      Math.sqrt(maxPixels / (this.width * this.height))))
    this.renderer.setSize(this.width, this.height, false)
    const ratio = this.renderer.getPixelRatio()
    const maxSize = this.quality === 'high' ? 1280 : 960
    const scale = Math.min(ratio * 0.75, maxSize / Math.max(this.width, this.height))
    const width = Math.max(1, Math.round(this.width * scale))
    const height = Math.max(1, Math.round(this.height * scale))
    this.densityTarget.setSize(width, height)
    this.filterTarget.setSize(width, height)
    this.surfaceTarget.setSize(width, height)
    this.weightsX.setSize(width, height)
    this.weightsY.setSize(width, height)
    this.boardTarget.setSize(Math.max(1, Math.round(this.width * ratio)), Math.max(1, Math.round(this.height * ratio)))
    this.waterMaterial.uniforms.uTexel.value.set(1 / width, 1 / height)
    this.canvas.dataset.surfaceResolution = `${width}x${height}`
    this.canvas.dataset.renderScale = '1'
    this.weightsDirty = true
    this.fieldDirty = true
    this.updateCamera()
  }

  resetCamera(): void {
    if (this.disposed) return
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.trackball.reset()
    this.updateCamera()
    this.draw()
  }

  private updateCamera(): void {
    if (this.viewMode === 'surface-3d') {
      // The field remains in fixed maze coordinates while only the presentation
      // camera orbits. Both views consume the identical particle snapshot.
      this.viewWidth = this.layout.maxX - this.layout.minX + 2 * SURFACE_FIELD_PADDING
      this.viewHeight = this.layout.maxY - this.layout.minY + 2 * SURFACE_FIELD_PADDING
      this.camera.left = this.layout.minX - SURFACE_FIELD_PADDING
      this.camera.right = this.layout.maxX + SURFACE_FIELD_PADDING
      this.camera.top = -this.layout.minY + SURFACE_FIELD_PADDING
      this.camera.bottom = -this.layout.maxY - SURFACE_FIELD_PADDING
      this.camera.updateProjectionMatrix()
      this.waterMaterial.uniforms.uCenter.value.set(
        (this.layout.minX + this.layout.maxX) / 2,
        -(this.layout.minY + this.layout.maxY) / 2,
      )
      this.waterMaterial.uniforms.uViewSize.value.set(this.viewWidth, this.viewHeight)
      this.waterMaterial.uniforms.uOpticalLod.value = Math.max(0, Math.log2(0.28 * this.surfaceTarget.height / this.viewHeight))
      this.presentation3d?.updateView(this.width, this.height, this.zoom, this.panX, this.panY, this.trackball.orientation)
      if (this.presentation3d) {
        this.waterMaterial.uniforms.uViewDirection.value.copy(this.presentation3d.viewDirection)
        this.canvas.dataset.cameraOrientation = this.trackball.orientation.toArray().join(',')
        this.canvas.dataset.cameraView = this.presentation3d.viewSize.toArray().join(',')
        this.canvas.dataset.cameraTarget = this.presentation3d.target.toArray().join(',')
      }
      // View-dependent optics must follow orbiting, but the particle density
      // and its filtered surface remain in the same fixed maze coordinates.
      this.boardDirty = true
      return
    }
    const contentWidth = this.layout.maxX - this.layout.minX + 0.65
    const contentHeight = this.layout.maxY - this.layout.minY + 0.65
    const aspect = this.width / this.height
    this.viewHeight = Math.max(contentHeight, contentWidth / aspect) / this.zoom
    this.viewWidth = this.viewHeight * aspect
    const x = (this.layout.minX + this.layout.maxX) * 0.5 + this.panX
    const y = -(this.layout.minY + this.layout.maxY) * 0.5 + this.panY
    this.camera.left = x - this.viewWidth * 0.5
    this.camera.right = x + this.viewWidth * 0.5
    this.camera.top = y + this.viewHeight * 0.5
    this.camera.bottom = y - this.viewHeight * 0.5
    this.camera.updateProjectionMatrix()
    this.waterMaterial.uniforms.uCenter.value.set(x, y)
    this.waterMaterial.uniforms.uViewSize.value.set(this.viewWidth, this.viewHeight)
    this.waterMaterial.uniforms.uOpticalLod.value = Math.max(0, Math.log2(0.28 * this.surfaceTarget.height / this.viewHeight))
    this.fieldDirty = true
    this.weightsDirty = true
  }

  private scheduleDraw(): void {
    if (this.disposed || this.cameraFrame !== undefined) return
    this.cameraFrame = requestAnimationFrame(() => {
      this.cameraFrame = undefined
      this.draw()
    })
  }

  private filterSurface(target: THREE.WebGLRenderTarget): void {
    target.scissorTest = false
    this.renderer.setRenderTarget(target)
    // Clear the whole previous field, then shade only pixels that can receive
    // water. Include the maximum splat/filter support plus two texels; all
    // omitted R/G/coverage values are mathematically zero, at full resolution.
    this.renderer.clear(true, false, false)
    const center = this.waterMaterial.uniforms.uCenter.value as THREE.Vector2
    const pad = this.layout.radius * 2.8 + 0.035 * 3.230769
    const left = center.x - this.viewWidth * 0.5
    const bottom = center.y - this.viewHeight * 0.5
    const x0 = Math.max(0, Math.min(target.width, Math.floor((this.wetBounds.x - pad - left) / this.viewWidth * target.width) - 2))
    const y0 = Math.max(0, Math.min(target.height, Math.floor((-this.wetBounds.w - pad - bottom) / this.viewHeight * target.height) - 2))
    const x1 = Math.max(0, Math.min(target.width, Math.ceil((this.wetBounds.z + pad - left) / this.viewWidth * target.width) + 2))
    const y1 = Math.max(0, Math.min(target.height, Math.ceil((-this.wetBounds.y + pad - bottom) / this.viewHeight * target.height) + 2))
    // Render-target scissor uses physical texels. renderer.setScissor would
    // multiply these coordinates by the canvas DPR and crop water on phones.
    target.scissor.set(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0))
    target.scissorTest = true
    this.renderer.setRenderTarget(target)
    this.renderer.autoClear = false
    this.renderer.render(this.filterScene, this.camera)
    this.renderer.autoClear = true
    target.scissorTest = false
    this.renderer.setScissorTest(false)
  }

  private draw(): void {
    if (this.disposed) return
    if (this.cameraFrame !== undefined) {
      cancelAnimationFrame(this.cameraFrame)
      this.cameraFrame = undefined
    }
    this.renderer.info.reset()
    if (this.weightsDirty) {
      this.weightsMaterial.uniforms.uStep.value.set(0.035 / this.viewWidth, 0)
      this.renderer.setRenderTarget(this.weightsX)
      this.renderer.render(this.weightsScene, this.camera)
      this.weightsMaterial.uniforms.uStep.value.set(0, 0.035 / this.viewHeight)
      this.renderer.setRenderTarget(this.weightsY)
      this.renderer.render(this.weightsScene, this.camera)
      this.weightsDirty = false
      this.canvas.dataset.wallWeightBuilds = String(++this.weightBuilds)
    }
    if (this.fieldDirty) {
      this.renderer.setRenderTarget(this.densityTarget)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.render(this.densityScene, this.camera)
      this.filterMaterial.uniforms.uInput.value = this.densityTarget.texture
      this.filterMaterial.uniforms.uWeights.value = this.weightsX.texture
      this.filterMaterial.uniforms.uStep.value.set(0.035 / this.viewWidth, 0)
      this.filterSurface(this.filterTarget)
      this.filterMaterial.uniforms.uInput.value = this.filterTarget.texture
      this.filterMaterial.uniforms.uWeights.value = this.weightsY.texture
      this.filterMaterial.uniforms.uStep.value.set(0, 0.035 / this.viewHeight)
      this.filterSurface(this.surfaceTarget)
      this.fieldDirty = false
      this.boardDirty = true
      this.canvas.dataset.surfaceBuilds = String(++this.surfaceBuilds)
    }
    this.renderer.setClearColor(0xf4f3ed, 1)
    if (this.viewMode === 'surface-3d' && this.presentation3d) {
      if (this.boardDirty) {
        this.flatWalls.visible = false
        this.funnel.visible = false
        this.renderer.setRenderTarget(this.boardTarget)
        this.renderer.render(this.scene, this.camera)
        this.canvas.dataset.opticalBuilds = String(++this.opticalBuilds)
        this.flatWalls.visible = true
        this.funnel.visible = true
        this.boardDirty = false
      }
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.presentation3d.scene, this.presentation3d.camera)
    } else {
      this.renderer.setRenderTarget(null)
      this.renderer.setClearColor(0xf4f3ed, 1)
      this.renderer.render(this.scene, this.camera)
    }
    this.drawCalls = this.renderer.info.render.calls
    this.triangles = this.renderer.info.render.triangles
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (this.pointers.size >= 2) return
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    this.canvas.setPointerCapture(event.pointerId)
    this.canvas.style.cursor = 'grabbing'
    if (this.pointers.size === 2) {
      const pinch = this.getPinch()
      this.pinchDistance = pinch.distance
      this.pinchCenterX = pinch.x
      this.pinchCenterY = pinch.y
    }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId)
    if (!previous) return
    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.pointers.size === 2) {
      const pinch = this.getPinch()
      const zoom = this.pinchDistance > 0 ? this.zoom * pinch.distance / this.pinchDistance : this.zoom
      this.zoomAt(zoom, this.pinchCenterX, this.pinchCenterY, pinch.x, pinch.y)
      this.pinchDistance = pinch.distance
      this.pinchCenterX = pinch.x
      this.pinchCenterY = pinch.y
    } else if (this.viewMode === 'surface-3d' && !event.shiftKey) {
      const rect = this.canvas.getBoundingClientRect()
      this.trackball.rotate(
        previous.x - rect.left, previous.y - rect.top,
        event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height,
      )
    } else {
      const rect = this.canvas.getBoundingClientRect()
      const view = this.interactionView()
      this.panX -= dx * view.width / rect.width
      this.panY += dy * view.height / rect.height
    }
    this.updateCamera()
    this.scheduleDraw()
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId)
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
    if (this.pointers.size < 2) this.pinchDistance = 0
    if (this.pointers.size === 0) this.canvas.style.cursor = 'grab'
  }

  private getPinch(): { distance: number; x: number; y: number } {
    const points = this.pointers.values()
    const first = points.next().value!
    const second = points.next().value!
    return {
      distance: Math.hypot(first.x - second.x, first.y - second.y),
      x: (first.x + second.x) * 0.5,
      y: (first.y + second.y) * 0.5,
    }
  }

  private interactionView(): { width: number; height: number } {
    return this.viewMode === 'surface-3d' && this.presentation3d
      ? { width: this.presentation3d.viewSize.x, height: this.presentation3d.viewSize.y }
      : { width: this.viewWidth, height: this.viewHeight }
  }

  private zoomAt(zoom: number, fromX: number, fromY: number, toX = fromX, toY = fromY): void {
    const rect = this.canvas.getBoundingClientRect()
    const before = this.interactionView()
    this.zoom = THREE.MathUtils.clamp(zoom, this.viewMode === 'surface-3d' ? 0.25 : 0.75, 6)
    this.updateCamera()
    const after = this.interactionView()
    // Preserve the grabbed camera-plane point as the pinch midpoint moves.
    // The same basis is used in 2D and after any 3D orbit, including the back.
    this.panX += ((fromX - rect.left) / rect.width - 0.5) * before.width
      - ((toX - rect.left) / rect.width - 0.5) * after.width
    this.panY += (0.5 - (fromY - rect.top) / rect.height) * before.height
      - (0.5 - (toY - rect.top) / rect.height) * after.height
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.zoomAt(this.zoom * Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY)
    this.updateCamera()
    this.scheduleDraw()
  }

  private onDoubleClick = (): void => this.resetCamera()

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Home' || event.key === '0') {
      event.preventDefault()
      this.resetCamera()
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault()
      this.zoom = THREE.MathUtils.clamp(this.zoom * (event.key === '-' ? 1 / 1.2 : 1.2), this.viewMode === 'surface-3d' ? 0.25 : 0.75, 6)
      this.updateCamera()
      this.draw()
    }
  }

  dispose(): void {
    if (this.cameraFrame !== undefined) cancelAnimationFrame(this.cameraFrame)
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.canvas.removeEventListener('keydown', this.onKeyDown)
    for (const id of this.pointers.keys()) {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id)
    }
    this.pointers.clear()
    this.particleGeometry.dispose()
    this.densityMaterial.dispose()
    this.waterMaterial.dispose()
    this.densityTarget.dispose()
    this.filterTarget.dispose()
    this.surfaceTarget.dispose()
    this.boardTarget.dispose()
    this.presentation3d?.dispose()
    const accessoryGeometries = new Set<THREE.BufferGeometry>()
    const accessoryMaterials = new Set<THREE.Material>()
    this.funnel.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        accessoryGeometries.add(object.geometry)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) accessoryMaterials.add(material)
      }
    })
    for (const geometry of accessoryGeometries) geometry.dispose()
    for (const material of accessoryMaterials) material.dispose()
    this.filterMaterial.dispose()
    this.weightsMaterial.dispose()
    this.weightsX.dispose()
    this.weightsY.dispose()
    this.wallTexture.dispose()
    this.clearanceTexture.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.scene.clear()
    this.densityScene.clear()
    this.filterScene.clear()
    this.weightsScene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
