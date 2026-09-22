import * as THREE from 'three'
import type { FluidLayout, FluidSnapshot, FluidDiagnostics } from './types'
import type { BasinSnapshot } from './basinSimulation'
import { buildSolidMask, WATER_WALL_VISIBILITY } from './surfaceField'
import { FreeSurfacePresentation3D, SURFACE_FIELD_PADDING } from './presentation3d'
import { CascadePresentation3D } from './cascadePresentation3d'
import type { CascadeSnapshot } from './cascadeTypes'
import { SurfaceTrackball } from './camera3d'
import { buildFunnelVisual } from './funnelVisual'
import { DEFAULT_WATER_APPEARANCE, type WaterAppearance } from './appearance'
import { DEFAULT_WATER_LOOK, getWaterTheme, normalizeWaterLook, STUDIO_BACKGROUND, STUDIO_IVORY_BACKGROUND, WATER_LIGHTS, type WaterLook } from './lookdev'

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
  ${WATER_WALL_VISIBILITY}
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
  uniform vec3 uFloor;
  uniform vec3 uBackdrop;
  uniform vec3 uLightDirection;
  uniform vec3 uLightColor;
  uniform float uWallDepth;
  uniform float uWhiteBackground;
  uniform float uGridVisible;
  uniform vec3 uGridColor;
  varying vec2 vUv;

  vec3 boardAt(vec2 maze) {
    // A quiet etched backing remains visible through the water. Refraction
    // samples this backing only, never geometry on the other side of a wall.
    vec2 cell = abs(fract(maze + 0.5) - 0.5);
    vec2 line = 1.0 - smoothstep(vec2(0.007), vec2(0.017), cell);
    float inside = step(0.0, maze.x) * step(maze.x, uMazeSize.x)
      * step(0.0, maze.y) * step(maze.y, uMazeSize.y);
    float pastelBlend = clamp(maze.y / max(uMazeSize.y, 1.0), 0.0, 1.0);
    vec3 color = mix(uFloor * 0.98, min(vec3(1.0), uFloor + vec3(0.012)), pastelBlend);
    color = mix(color, vec3(1.0), uWhiteBackground);
    color = mix(color, uGridColor, max(line.x, line.y) * inside * uGridVisible);
    float dotMark = 1.0 - smoothstep(0.008, 0.020, length(fract(maze) - 0.5));
    color -= dotMark * inside * 0.024 * uGridVisible;
    // A short directional contact shade makes the recess legible and follows
    // the same light as the physical bevels. No full-scene shadow pass needed.
    vec2 toLight = vec2(uLightDirection.x, -uLightDirection.y) * uWallDepth;
    float shade = wallAt(maze + toLight * 0.18) * 0.060
      + wallAt(maze + toLight * 0.43) * 0.035;
    color *= 1.0 - shade * uPresentation3D;
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
    float environment = mix(0.62, 0.28, uClearOptics)
      + mix(0.30, 0.54, uClearOptics) * smoothstep(-0.65, 0.75, reflected.y);
    float fresnel = 0.02 + 0.98 * pow(1.0 - noV, 5.0);
    vec3 environmentTint = mix(uBackdrop, uLightColor, 0.48) * environment;
    water = mix(water, environmentTint, fresnel);
    vec3 light = normalize(uLightDirection);
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
    water += uLightColor * min(0.17, distribution * visibility * sunFresnel * noL * 0.32);
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
      float reflection = pow(max(dot(normal, normalize(uLightDirection)), 0.0), 36.0);
      float fresnel = 0.02 + 0.32 * pow(1.0 - normal.z, 3.0);
      // Colorless water transmits the warm backing and reflects neutral light.
      // Keep the original blue environment only for the named colored profiles.
      water = mix(water, mix(vec3(0.84, 0.95, 1.0), vec3(0.58), uClearOptics), fresnel);
      water += mix(vec3(0.15, 0.19, 0.20), vec3(0.028), uClearOptics) * uLightColor
        * reflection * (0.65 + uStyle * 0.20);
      // Only moving water receives a subtle travelling light band. Time is the
      // accepted physics snapshot's time, so pause and still pools stay still.
      float band = pow(0.5 + 0.5 * sin(maze.x * 6.4 + sin(maze.y * 3.1 - uTime * 1.7) * 0.8), 8.0);
      water += mix(vec3(0.035, 0.045, 0.05), vec3(0.016), uClearOptics)
        * band * motion * (0.6 + uStyle * 0.4);
    }
    float sky = pow(max(dot(outward, normalize(uLightDirection.xy)), 0.0), 4.0);
    water += mix(vec3(0.40, 0.43, 0.40), vec3(0.34), uClearOptics) * rim * sky * 0.72;
    water -= mix(vec3(0.045, 0.055, 0.045), vec3(0.18), uClearOptics)
      * rim * max(-outward.y, 0.0);
    // A broad reflected shade reveals the clear jet's curvature without dye,
    // a white fill, or a separate outline around each underlying particle.
    water -= vec3(0.14) * uClearOptics * (1.0 - normal.z);
    // The continuous silhouette reflects a dark surround opposite the light.
    // Include side-facing edges so vertical jets remain legible on the board.
    float shade = 1.0 - smoothstep(-0.35, 0.85, dot(outward, normalize(uLightDirection.xy)));
    water -= vec3(0.12) * uClearOptics * rim * shade;
    // Composite translucency against the actual backing. The canvas itself
    // stays opaque so the maze and controls do not bleed through the stage.
    gl_FragColor = vec4(mix(background, water, coverage * uOpacity), 1.0);
  }
`

/** Render each solver's accepted state; no independent animation clock. */
export class FreeSurfaceRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  private readonly scene = new THREE.Scene()
  private readonly flatWalls = new THREE.Group()
  private readonly funnel: THREE.Group
  private presentation3d: FreeSurfacePresentation3D | CascadePresentation3D | null = null
  private basinSnapshot: BasinSnapshot | null = null
  private viewMode: 'free-surface' | 'surface-3d' = 'free-surface'
  private readonly trackball = new SurfaceTrackball()
  private look: WaterLook = { ...DEFAULT_WATER_LOOK }
  private appearance: WaterAppearance = { ...DEFAULT_WATER_APPEARANCE }
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
  private surfaceBuilds = 0
  private weightsDirty = true
  private weightBuilds = 0
  private cameraFrame: number | undefined
  private readonly wetBounds = new THREE.Vector4()

  constructor(
    private readonly mount: HTMLElement,
    private readonly layout: FluidLayout,
    private readonly quality: 'low' | 'high',
    private readonly sculpture?: 'terraced-fountain' | 'extruded-flow',
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0xffefdf, 1)
    this.renderer.info.autoReset = false
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.canvas = this.renderer.domElement
    this.canvas.className = 'water-simulation-canvas free-surface-canvas'
    this.canvas.dataset.viewMode = 'free-surface'
    this.canvas.dataset.particleCapacity = String(layout.capacity)
    this.canvas.dataset.particleRadius = String(layout.radius)
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
        ...wallUniforms,
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
        uFloor: { value: new THREE.Color(STUDIO_IVORY_BACKGROUND).convertLinearToSRGB() },
        uWhiteBackground: { value: 1 },
        uGridVisible: { value: 1 },
        uGridColor: { value: new THREE.Color('#dce3e8').convertLinearToSRGB() },
        uBackdrop: { value: new THREE.Color(STUDIO_BACKGROUND).convertLinearToSRGB() },
        uLightDirection: { value: new THREE.Vector3(...WATER_LIGHTS.daylight.direction).normalize() },
        uLightColor: { value: new THREE.Color(WATER_LIGHTS.daylight.color).convertLinearToSRGB() },
        uWallDepth: { value: DEFAULT_WATER_LOOK.wallHeight },
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
    const palette = getWaterTheme(this.look.theme)
    const top = new THREE.Color(this.look.wallColor ?? this.look.wallColor2d ?? '#526b7a')
    const bottom = top.clone().multiplyScalar(0.82)
    const rim = top.clone().lerp(new THREE.Color('#ffffff'), 0.45)
    const shadow = new THREE.Color(palette.edge)
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

  captureParticles(diagnostics: FluidDiagnostics): FluidSnapshot {
    const count = this.particleGeometry.instanceCount
    return { count, positions: new Float32Array(this.positionAttribute.array.slice(0, count * 2)),
      velocities: new Float32Array(this.velocityAttribute.array.slice(0, count * 2)), diagnostics: { ...diagnostics } }
  }

  pointAt(clientX: number, clientY: number): { x: number; y: number } | null {
    if (this.viewMode !== 'free-surface') return null
    const bounds = this.canvas.getBoundingClientRect()
    const point = new THREE.Vector3((clientX - bounds.left) / bounds.width * 2 - 1, 1 - (clientY - bounds.top) / bounds.height * 2, 0).unproject(this.camera)
    return { x: point.x, y: -point.y }
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
    this.canvas.dataset.particleTime = String(snapshot.diagnostics.time)
    this.canvas.dataset.particleCount = String(count)
    this.canvas.dataset.particleStoredVolume = String(snapshot.diagnostics.stored)
    this.particleGeometry.instanceCount = count
    this.fieldDirty = true
    if (this.viewMode === 'free-surface' || this.sculpture === 'extruded-flow') this.draw()
  }

  setBasinSnapshot(snapshot: BasinSnapshot): void {
    if (this.disposed) return
    this.basinSnapshot = snapshot
    this.presentation3d?.setBasinSnapshot(snapshot)
    this.canvas.dataset.basinTime = String(snapshot.diagnostics.time)
    this.canvas.dataset.basinStoredVolume = String(snapshot.diagnostics.stored)
    this.canvas.dataset.basinInitialVolume = String(snapshot.initialStoredVolume)
    this.canvas.dataset.basinWetCells = String(snapshot.diagnostics.wetCells)
    this.canvas.dataset.basinInletRate = String(snapshot.sourceRate)
    this.canvas.dataset.basinOutletRate = String(snapshot.diagnostics.outletRate)
    this.canvas.dataset.basinInjectedVolume = String(snapshot.diagnostics.injected)
    this.canvas.dataset.basinOutletVolume = String(snapshot.diagnostics.discharged)
    if ('cascade' in snapshot) {
      const state = (snapshot as CascadeSnapshot).cascade
      this.canvas.dataset.sculpture = 'terraced-fountain'
      this.canvas.dataset.terraceCount = '3'
      this.canvas.dataset.terraceDepths = JSON.stringify(state.depths)
      this.canvas.dataset.terraceOutletRates = JSON.stringify(state.discharge)
    }
    if (this.viewMode === 'surface-3d') this.draw()
  }

  setSurfaceStyle(style: SurfaceStyle): void {
    if (this.disposed) return
    this.waterMaterial.uniforms.uStyle.value = style === 'calm' ? 0 : style === 'dynamic' ? 1 : 0.5
    this.draw()
  }

  setAppearance(appearance: WaterAppearance): void {
    this.appearance = { ...appearance }
    this.presentation3d?.setAppearance(appearance)
    if (this.disposed) return
    const color = appearance.color && /^#[0-9a-f]{6}$/i.test(appearance.color) ? appearance.color.toLowerCase() : null
    const profile = appearance.profile === 'aqua' ? 'aqua' : color ? 'tinted' : 'clear'
    const absorption = this.waterMaterial.uniforms.uAbsorption.value as THREE.Vector3
    const scatter = this.waterMaterial.uniforms.uScatter.value as THREE.Vector3
    if (color) {
      // This compositor outputs display RGB directly, so use display RGB for
      // the dye too; linearized picker colors excessively darken midtones.
      const tint = new THREE.Color(color).convertLinearToSRGB()
      // Channel-dependent absorption retains the etched backing and meniscus;
      // changing dye never replaces the continuous surface with an opaque fill.
      absorption.set(0.06 + (1 - tint.r) * 2.2, 0.06 + (1 - tint.g) * 2.2, 0.06 + (1 - tint.b) * 2.2)
      scatter.set(tint.r * 0.35, tint.g * 0.35, tint.b * 0.35)
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
    this.draw()
  }

  setInflow(enabled: boolean): void {
    if (this.disposed) return
    this.canvas.dataset.inflow = enabled ? 'enabled' : 'disabled'
    const indicator = this.funnel.getObjectByName('supply-glint')
    if (indicator) indicator.visible = enabled
    const indicator3d = this.presentation3d?.content.getObjectByName('supply-glint')
    if (indicator3d) indicator3d.visible = enabled
    this.presentation3d?.setInflow(enabled)
    this.draw()
  }

  setLook(next: Partial<WaterLook>): void {
    if (this.disposed) return
    const previousTheme = this.look.theme
    const previousWallColor = this.look.wallColor ?? this.look.wallColor2d
    this.look = normalizeWaterLook(next, this.look)
    const palette = getWaterTheme(this.look.theme)
    const lighting = WATER_LIGHTS[this.look.light]
    this.waterMaterial.uniforms.uFloor.value.set(STUDIO_IVORY_BACKGROUND).convertLinearToSRGB()
    this.waterMaterial.uniforms.uBackdrop.value.set(STUDIO_BACKGROUND).convertLinearToSRGB()
    this.waterMaterial.uniforms.uLightDirection.value.set(...lighting.direction).normalize()
    this.waterMaterial.uniforms.uLightColor.value.set(lighting.color).convertLinearToSRGB()
    this.waterMaterial.uniforms.uWallDepth.value = this.look.wallHeight
    this.waterMaterial.uniforms.uWhiteBackground.value = this.look.background2d === 'white' ? 1 : 0
    this.waterMaterial.uniforms.uGridColor.value.set(this.look.gridColor2d ?? '#dce3e8').convertLinearToSRGB()
    this.canvas.dataset.wallColor2d = this.look.wallColor ?? this.look.wallColor2d ?? '#526b7a'
    this.canvas.dataset.wallColor3d = this.look.wallColor ?? palette.wall
    this.canvas.dataset.gridColor2d = this.look.gridColor2d ?? '#dce3e8'
    this.canvas.dataset.background2d = this.look.background2d ?? 'material'
    this.presentation3d?.setLook(this.look)
    if (previousTheme !== this.look.theme || previousWallColor !== (this.look.wallColor ?? this.look.wallColor2d)) {
      // Only appearance edits rebuild the two flat meshes; simulation buffers
      // and the filtered density/coverage targets remain untouched.
      for (const child of this.flatWalls.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
        mesh.geometry.dispose()
        mesh.material.dispose()
        this.geometries.splice(this.geometries.indexOf(mesh.geometry), 1)
        this.materials.splice(this.materials.indexOf(mesh.material), 1)
      }
      this.flatWalls.clear()
      this.buildWalls()
    }
    this.funnel.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshBasicMaterial)) continue
        const original = material.userData.originalColor ??= material.color.getHexString()
        if (original === 'afc7ce' || original === 'a7bfc7') material.color.set(palette.edge)
        else if (original === '78939e' || original === '71848b') material.color.set(palette.wallSide)
        else if (original === '9fadb0') material.color.set(palette.slab)
        else if (original === '77bed0') material.color.set(palette.accent)
      }
    })
    this.canvas.dataset.theme = this.look.theme
    this.canvas.dataset.lighting = this.look.light
    this.canvas.dataset.wallHeight = String(this.look.wallHeight)
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
    this.canvas.dataset.waterModel = mode === 'surface-3d' && this.sculpture !== 'extruded-flow' ? 'hydraulic-basin' : 'position-based-free-surface'
    this.canvas.setAttribute('aria-label', mode === 'surface-3d'
      ? '벽 안에 담긴 미로의 물. 드래그로 회전하고 두 손가락으로 이동·확대합니다.'
      : '중력에 따라 흐르는 미로의 물. 드래그로 이동하고 스크롤 또는 두 손가락으로 확대합니다.')
    if (mode === 'surface-3d' && !this.presentation3d) {
      this.presentation3d = this.sculpture === 'terraced-fountain'
        ? new CascadePresentation3D(this.layout, this.renderer)
        : new FreeSurfacePresentation3D(this.layout, this.surfaceTarget.texture, this.renderer, this.sculpture === 'extruded-flow')
      if (this.sculpture === 'extruded-flow' && this.presentation3d instanceof FreeSurfacePresentation3D) {
        const material = new THREE.ShaderMaterial({
          vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: waterFragment.replace('gl_FragColor = vec4(background, 1.0); return;', 'discard;')
            .replace('vec4(mix(background, water, coverage * uOpacity), 1.0)', 'vec4(water, coverage * uOpacity)'),
          uniforms: { ...this.waterMaterial.uniforms, uPresentation3D: { value: 0 }, uGridVisible: { value: 0 } },
          transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
        })
        this.materials.push(material)
        this.presentation3d.setFlowMaterial(material, this.layout)
      }
      this.presentation3d.addFunnel(this.funnel)
      this.presentation3d.setAppearance(this.appearance)
      this.presentation3d.setLook(this.look)
      if (this.basinSnapshot) this.presentation3d.setBasinSnapshot(this.basinSnapshot)
      this.presentation3d.setInflow(this.canvas.dataset.inflow !== 'disabled')
    }
    if (mode === 'free-surface' && this.sculpture === 'extruded-flow') this.scene.add(this.funnel)
    else if (this.sculpture === 'extruded-flow') this.presentation3d?.addFunnel(this.funnel)
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
    if (this.sculpture === 'extruded-flow') this.trackball.orientation.setFromEuler(new THREE.Euler(0.22, -0.12, 0))
    this.updateCamera()
    this.draw()
  }

  zoomCamera(factor: number): void {
    if (this.disposed || !Number.isFinite(factor) || factor <= 0) return
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, this.viewMode === 'surface-3d' ? 0.25 : 0.75, 6)
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
    // Orbiting the basin must not leak its view-dependent Fresnel angle into
    // the restored front-facing 2D water. Its paused pixels stay reproducible.
    this.waterMaterial.uniforms.uViewDirection.value.set(0, 0, 1)
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
    if ((this.viewMode === 'free-surface' || this.sculpture === 'extruded-flow') && this.weightsDirty) {
      this.weightsMaterial.uniforms.uStep.value.set(0.035 / this.viewWidth, 0)
      this.renderer.setRenderTarget(this.weightsX)
      this.renderer.render(this.weightsScene, this.camera)
      this.weightsMaterial.uniforms.uStep.value.set(0, 0.035 / this.viewHeight)
      this.renderer.setRenderTarget(this.weightsY)
      this.renderer.render(this.weightsScene, this.camera)
      this.weightsDirty = false
      this.canvas.dataset.wallWeightBuilds = String(++this.weightBuilds)
    }
    if ((this.viewMode === 'free-surface' || this.sculpture === 'extruded-flow') && this.fieldDirty) {
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
      this.canvas.dataset.surfaceBuilds = String(++this.surfaceBuilds)
    }
    this.renderer.setClearColor(STUDIO_BACKGROUND, 1)
    if (this.viewMode === 'surface-3d' && this.presentation3d) {
      this.presentation3d.updateWater(this.sculpture === 'extruded-flow' ? this.waterMaterial.uniforms.uTime.value : this.basinSnapshot?.diagnostics.time ?? 0, 0.5 + this.waterMaterial.uniforms.uStyle.value)
      this.renderer.setRenderTarget(null)
      this.renderer.shadowMap.enabled = true
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = 1.10
      this.renderer.render(this.presentation3d.scene, this.presentation3d.camera)
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.shadowMap.enabled = false
    } else {
      this.renderer.setRenderTarget(null)
      this.renderer.setClearColor(STUDIO_BACKGROUND, 1)
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
