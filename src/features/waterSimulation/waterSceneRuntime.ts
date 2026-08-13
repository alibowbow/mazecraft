import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  getActiveCell,
  getVisualOpeningDirection,
  type CellPosition,
  type MazeGraph,
  type MazeProject,
  type WallDirection,
} from '../../core/maze'
import {
  buildHydraulicNetwork,
  createHydraulicBridge,
  type HydraulicBridge,
  type HydraulicBridgeMode,
  type HydraulicDiagnosticsSnapshot,
  type HydraulicSnapshotMessage,
} from './hydraulics'
import {
  buildWaterTopologyAtlas,
  countClosedWallLeakTexels,
  createDynamicStateTextureBuffer,
  createWaterDetailTextureData,
  createWaterSurfaceProfile,
  EdgeVelocityAggregator,
  resetDynamicStateTexture,
  updateDynamicStateTexture,
  WaterFoamRenderTargets,
  writeFlowFoamSource,
  type DynamicStateTextureBuffer,
  type WaterFoamMode,
  type WaterSurfaceProfile,
  type WaterSurfaceStyle,
  type WaterTopologyAtlas,
} from './rendering'
import {
  resolveWaterInletLayout,
  sampleWaterHandoff,
  sampleWaterInlet,
  WATER_INLET_IMPACT_MS,
  type WaterInletLayout,
  type WaterInletState,
} from './waterInletVisual'

export interface WaterPlaybackStatus {
  elapsedMs: number
  simulationTime: number
  filledCells: number
  totalCells: number
  reachedExit: boolean
  complete: boolean
  inletState: WaterInletState
  inletVisible: boolean
  outletVisible: boolean
  activeFlowEdgeCount: number
  cumulativeInjectedVolume: number
  cumulativeOutletVolume: number
  currentStoredVolume: number
  absoluteMassError: number
  relativeMassError: number
  maxVelocity: number
  outletDischarge: number
}

export interface WaterRuntimeMetrics {
  atlasWidth: number
  atlasHeight: number
  closedWallLeakTexels: number
  drawCalls: number
  triangles: number
  inletDropHeight: number
  inletContactGap: number
  outletDropHeight: number
  physicsStepHz: number
  snapshotHz: number
  solverMode: HydraulicBridgeMode
  waveBands: number
  foamMode: WaterFoamMode
}

export type ResolvedWaterQuality = 'low' | 'high'

interface WallSpec {
  x: number
  y: number
  width: number
  height: number
  orientation: 'horizontal' | 'vertical'
}

interface ParticleSeed {
  phase: number
  drift: number
  size: number
  lift: number
  depth: number
}

interface BubbleSeed extends ParticleSeed {
  nodeIndex: number
}

const WATER_BODY_COLOR = 0x16bad8
const WATER_EMISSIVE_COLOR = 0x006f86
const WATER_SURFACE_Z = 0.185
const WATER_JET_TOP_Z = 0.34
const WATER_JET_CONTACT_Z = 0.205
const WATER_JET_MIN_CONTACT_RADIUS = 0.074
const WATER_OUTLET_DROP_HEIGHT = 1.58

const WATER_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uTopology;
  uniform sampler2D uDynamicState;
  uniform float uWaveTime;
  uniform vec2 uBoardSize;
  uniform vec2 uImpactCenter;
  uniform float uImpactStrength;
  uniform float uFlowGate;
  uniform vec3 uBandAmplitude;
  uniform vec3 uBandFrequency;
  uniform vec3 uBandSpeed;
  uniform vec3 uBandCrossFlow;
  uniform vec3 uBandPhase;
  uniform float uBandCount;
  uniform float uDepthScaleMeters;
  uniform float uCellWidthMeters;
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying float vDepth;
  varying float vMask;
  varying float vWaveCrest;
  varying vec2 vVelocity;

  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {
    float waveNumberPerMeter = waveNumberPerCell / max(0.001, uCellWidthMeters);
    float kh = min(
      10.0,
      max(0.0, waveNumberPerMeter * normalizedDepth * uDepthScaleMeters)
    );
    float negativeExponential = exp(-2.0 * kh);
    float finiteDepthTanh =
      (1.0 - negativeExponential) / (1.0 + negativeExponential);
    return sqrt(max(0.0, finiteDepthTanh));
  }

  void main() {
    float mask = texture2D(uTopology, uv).r;
    vec4 dynamicState = texture2D(uDynamicState, uv);
    float depth = clamp(dynamicState.r, 0.0, 1.0) * uFlowGate;
    vec2 velocity = dynamicState.gb;
    float speed = length(velocity);
    vec2 flow = speed > 0.001
      ? normalize(velocity)
      : vec2(0.0, -1.0);
    vec2 channelUv = uv * uBoardSize;
    float motion = smoothstep(0.002, 0.12, speed);
    vec2 flowPerpendicular = vec2(-flow.y, flow.x);
    vec2 broadDirection = normalize(flow + flowPerpendicular * uBandCrossFlow.x);
    float wave = sin(
      dot(channelUv, broadDirection) * uBandFrequency.x -
      uWaveTime * uBandSpeed.x *
        finiteDepthPhaseScale(uBandFrequency.x, depth) +
      uBandPhase.x
    ) * uBandAmplitude.x;
    if (uBandCount > 1.5) {
      vec2 mediumDirection = normalize(
        flow + flowPerpendicular * uBandCrossFlow.y
      );
      wave += sin(
        dot(channelUv, mediumDirection) * uBandFrequency.y -
        uWaveTime * uBandSpeed.y *
          finiteDepthPhaseScale(uBandFrequency.y, depth) +
        uBandPhase.y
      ) * uBandAmplitude.y;
    }
    if (uBandCount > 2.5) {
      vec2 fineDirection = normalize(flow + flowPerpendicular * uBandCrossFlow.z);
      wave += sin(
        dot(channelUv, fineDirection) * uBandFrequency.z -
        uWaveTime * uBandSpeed.z *
          finiteDepthPhaseScale(uBandFrequency.z, depth) +
        uBandPhase.z
      ) * uBandAmplitude.z;
    }
    float impactDistance = length((uv - uImpactCenter) * uBoardSize);
    float impactDimple = exp(-pow(impactDistance / 0.12, 2.0)) *
      uImpactStrength;
    float impactShoulder = exp(-pow(
      (impactDistance - 0.24) / 0.085,
      2.0
    )) * uImpactStrength;
    vec3 transformed = position;
    transformed.z += mask * (
      depth * (0.012 + wave * motion * mix(0.035, 0.12, motion)) -
      impactDimple * 0.026 +
      impactShoulder * 0.026
    );
    vUv = uv;
    vDepth = depth;
    vMask = mask;
    float totalAmplitude = max(
      0.0001,
      uBandAmplitude.x + uBandAmplitude.y + uBandAmplitude.z
    );
    vWaveCrest = max(
      clamp(wave / totalAmplitude * 0.5 + 0.5, 0.0, 1.0) * motion,
      impactShoulder * 0.72
    );
    vVelocity = velocity;
    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const WATER_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uTopology;
  uniform sampler2D uDynamicState;
  uniform sampler2D uDetail;
  uniform sampler2D uFoamHistory;
  uniform float uFoamHistoryEnabled;
  uniform float uWaveTime;
  uniform vec2 uBoardSize;
  uniform vec2 uImpactCenter;
  uniform float uImpactStrength;
  uniform float uFlowGate;
  uniform float uDetailStrength;
  uniform float uFresnelPower;
  uniform float uGlitterStrength;
  uniform float uReflectionStrength;
  uniform float uSubsurfaceStrength;
  uniform vec3 uCameraPosition;
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying float vDepth;
  varying float vMask;
  varying float vWaveCrest;
  varying vec2 vVelocity;

  void main() {
    vec4 dynamicState = texture2D(uDynamicState, vUv);
    float mask = smoothstep(0.08, 0.92, vMask);
    float depth = clamp(vDepth, 0.0, 1.0);
    if (mask < 0.01 || depth < 0.0001 || uFlowGate < 0.001) discard;

    float speed = length(vVelocity);
    vec2 flow = speed > 0.001 ? normalize(vVelocity) : vec2(0.0, -1.0);
    float motion = smoothstep(0.002, 0.12, speed);
    vec2 channelUv = vUv * uBoardSize;
    vec2 detailUvA =
      channelUv * 0.36 + flow * uWaveTime * 0.035 * motion;
    vec2 detailUvB =
      channelUv * 1.18 - flow * uWaveTime * 0.072 * motion;
    vec4 detailA = texture2D(uDetail, detailUvA);
    vec4 detailB = texture2D(uDetail, detailUvB);
    float impactDistance = length((vUv - uImpactCenter) * uBoardSize);
    float impactPhase = fract(uWaveTime * 0.72);
    float impactRing = exp(-pow(
      (impactDistance - (0.08 + impactPhase * 0.42)) / 0.045,
      2.0
    )) * (1.0 - impactPhase) * uImpactStrength;
    vec3 geometricNormal = normalize(cross(
      dFdx(vWorldPosition),
      dFdy(vWorldPosition)
    ));
    geometricNormal *= geometricNormal.z < 0.0 ? -1.0 : 1.0;
    vec2 detailNormal =
      ((detailA.rg * 2.0 - 1.0) +
        (detailB.rg * 2.0 - 1.0) * 0.48) *
      uDetailStrength * motion;
    vec3 normal = normalize(vec3(
      geometricNormal.xy + detailNormal * 0.24,
      max(0.2, geometricNormal.z)
    ));
    vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
    float fresnel = 0.02 + 0.98 * pow(
      1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0),
      uFresnelPower
    );
    vec3 sunDirection = normalize(vec3(-0.35, 0.58, 0.74));
    vec3 reflectedSun = reflect(-sunDirection, normal);
    float glitter = pow(max(dot(reflectedSun, viewDirection), 0.0), 48.0) *
      uGlitterStrength;
    vec3 reflectedView = reflect(-viewDirection, normal);
    float skyHeight = clamp(reflectedView.z, -1.0, 1.0);
    vec3 belowHorizon = vec3(0.19, 0.34, 0.39);
    vec3 horizon = vec3(0.7, 0.87, 0.91);
    vec3 zenith = vec3(0.12, 0.39, 0.67);
    vec3 skyReflection = mix(
      belowHorizon,
      horizon,
      smoothstep(-0.22, 0.08, skyHeight)
    );
    skyReflection = mix(
      skyReflection,
      zenith,
      pow(max(0.0, skyHeight), 0.62)
    );
    float sunHalo = pow(max(dot(reflectedView, sunDirection), 0.0), 96.0);
    skyReflection += vec3(1.0, 0.88, 0.66) * sunHalo * 0.7;

    vec3 shallowCyan = vec3(0.025, 0.73, 0.9);
    vec3 deepBlue = vec3(0.005, 0.28, 0.59);
    vec3 bodyColor = mix(shallowCyan, deepBlue, smoothstep(0.08, 0.86, depth));
    bodyColor = mix(
      bodyColor,
      skyReflection,
      clamp(fresnel * uReflectionStrength, 0.0, 0.92)
    );
    bodyColor += vec3(0.82, 0.97, 1.0) * glitter;
    float forwardLight = pow(
      max(dot(viewDirection, normalize(sunDirection - normal * 0.38)), 0.0),
      3.0
    );
    float thinWater = 1.0 - smoothstep(0.16, 0.82, depth);
    float subsurface = vWaveCrest * thinWater *
      (0.3 + forwardLight * 0.7) * uSubsurfaceStrength;
    bodyColor += vec3(0.04, 0.7, 0.68) * subsurface;
    bodyColor = mix(bodyColor, vec3(0.15, 0.76, 0.84), impactRing * 0.18);

    float foam = uFoamHistoryEnabled > 0.5
      ? texture2D(uFoamHistory, vUv).r
      : clamp(dynamicState.a, 0.0, 1.0);
    float bubbleStructure = mix(0.72, 1.08, detailA.b * detailB.a);
    float foamLighting = mix(0.82, 1.12, max(dot(normal, sunDirection), 0.0));
    bodyColor = mix(
      bodyColor,
      vec3(0.82, 0.97, 0.98) * bubbleStructure * foamLighting,
      smoothstep(0.18, 0.88, foam)
    );

    float alpha = mask * mix(0.38, 0.9, sqrt(depth));
    alpha = max(alpha, foam * mask * 0.76);
    if (alpha < 0.018) discard;
    gl_FragColor = vec4(bodyColor, alpha);
  }
`

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const smoothstep = (minimum: number, maximum: number, value: number) => {
  const normalized = clamp01((value - minimum) / Math.max(0.0001, maximum - minimum))
  return normalized * normalized * (3 - 2 * normalized)
}

const positionKey = ({ row, col }: CellPosition) => `${row}:${col}`

const openingKey = (position: CellPosition, direction: WallDirection | null) =>
  direction ? `${positionKey(position)}:${direction}` : ''

const cellScenePosition = (graph: MazeGraph, position: CellPosition) => ({
  x: position.col - graph.cols / 2 + 0.5,
  y: graph.rows / 2 - position.row - 0.5,
})

const seededUnit = (index: number, salt: number) => {
  const value = Math.sin(index * 91.733 + salt * 37.719) * 43_758.5453
  return value - Math.floor(value)
}

const collectWallSpecs = (
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
): WallSpec[] => {
  const openings = new Set([
    openingKey(start, getVisualOpeningDirection(graph, start)),
    openingKey(end, getVisualOpeningDirection(graph, end)),
  ])
  const walls: WallSpec[] = []

  const addWall = (
    position: CellPosition,
    direction: WallDirection,
    x: number,
    y: number,
    width: number,
    height: number,
    orientation: WallSpec['orientation'],
  ) => {
    if (!openings.has(openingKey(position, direction))) {
      walls.push({ x, y, width, height, orientation })
    }
  }

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const { x, y } = cellScenePosition(graph, cell)
    if (cell.walls.top) {
      addWall(cell, 'top', x, y + 0.5, 1.12, 0.16, 'horizontal')
    }
    if (cell.walls.left) {
      addWall(cell, 'left', x - 0.5, y, 0.16, 1.12, 'vertical')
    }

    const right = getActiveCell(graph, { row: cell.row, col: cell.col + 1 })
    if (!right && cell.walls.right) {
      addWall(cell, 'right', x + 0.5, y, 0.16, 1.12, 'vertical')
    }
    const bottom = getActiveCell(graph, { row: cell.row + 1, col: cell.col })
    if (!bottom && cell.walls.bottom) {
      addWall(cell, 'bottom', x, y - 0.5, 1.12, 0.16, 'horizontal')
    }
  }
  return walls
}

const createLabelSprite = (text: string, fill: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    context.clearRect(0, 0, 128, 128)
    context.fillStyle = fill
    context.beginPath()
    context.arc(64, 64, 43, 0, Math.PI * 2)
    context.fill()
    context.lineWidth = 5
    context.strokeStyle = 'rgba(255,255,255,.96)'
    context.stroke()
    context.fillStyle = '#ffffff'
    context.font = '800 58px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 64, 68)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    }),
  )
  sprite.scale.set(0.56, 0.56, 1)
  sprite.renderOrder = 30
  return sprite
}

const createParticleSeeds = (count: number, salt: number): ParticleSeed[] =>
  Array.from({ length: count }, (_, index) => ({
    phase: seededUnit(index, salt),
    drift: seededUnit(index, salt + 1) * 2 - 1,
    size: 0.58 + seededUnit(index, salt + 2) * 0.72,
    lift: 0.45 + seededUnit(index, salt + 3) * 0.72,
    depth: seededUnit(index, salt + 4) * 2 - 1,
  }))

function createStudioGradientTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, '#f8fbfc')
    gradient.addColorStop(0.5, '#dfeaec')
    gradient.addColorStop(1, '#b8cdd1')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

function applyWaterSurfaceProfile(
  material: THREE.ShaderMaterial,
  profile: WaterSurfaceProfile,
): void {
  const amplitudes = new THREE.Vector3()
  const frequencies = new THREE.Vector3()
  const speeds = new THREE.Vector3()
  const crossFlows = new THREE.Vector3()
  const phases = new THREE.Vector3()
  profile.waveBands.forEach((band, index) => {
    amplitudes.setComponent(index, band.amplitude)
    frequencies.setComponent(index, (Math.PI * 2) / band.wavelengthCells)
    speeds.setComponent(index, band.speed)
    crossFlows.setComponent(index, band.crossFlow)
    phases.setComponent(index, band.phase)
  })
  material.uniforms.uBandAmplitude.value.copy(amplitudes)
  material.uniforms.uBandFrequency.value.copy(frequencies)
  material.uniforms.uBandSpeed.value.copy(speeds)
  material.uniforms.uBandCrossFlow.value.copy(crossFlows)
  material.uniforms.uBandPhase.value.copy(phases)
  material.uniforms.uBandCount.value = profile.waveBands.length
  material.uniforms.uDetailStrength.value = profile.detailStrength
  material.uniforms.uFresnelPower.value = profile.fresnelPower
  material.uniforms.uGlitterStrength.value = profile.glitterStrength
  material.uniforms.uReflectionStrength.value = profile.reflectionStrength
  material.uniforms.uSubsurfaceStrength.value = profile.subsurfaceStrength
}

function createWaterSurfaceMaterial(
  topology: WaterTopologyAtlas,
  dynamicState: DynamicStateTextureBuffer,
  profile: WaterSurfaceProfile,
  seed: string,
  cellWidthMeters: number,
) {
  const topologyTexture = new THREE.DataTexture(
    topology.data,
    topology.width,
    topology.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  topologyTexture.minFilter = THREE.LinearFilter
  topologyTexture.magFilter = THREE.LinearFilter
  topologyTexture.generateMipmaps = false
  topologyTexture.flipY = false
  topologyTexture.needsUpdate = true

  const dynamicTexture = new THREE.DataTexture(
    dynamicState.data,
    dynamicState.width,
    dynamicState.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  dynamicTexture.minFilter = THREE.NearestFilter
  dynamicTexture.magFilter = THREE.NearestFilter
  dynamicTexture.generateMipmaps = false
  dynamicTexture.flipY = false
  dynamicTexture.needsUpdate = true

  const detailData = createWaterDetailTextureData({
    size: profile.quality === 'high' ? 128 : 64,
    seed,
  })
  const detailTexture = new THREE.DataTexture(
    detailData.data,
    detailData.width,
    detailData.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  detailTexture.wrapS = THREE.RepeatWrapping
  detailTexture.wrapT = THREE.RepeatWrapping
  detailTexture.minFilter = THREE.LinearFilter
  detailTexture.magFilter = THREE.LinearFilter
  detailTexture.generateMipmaps = false
  detailTexture.needsUpdate = true

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTopology: { value: topologyTexture },
      uDynamicState: { value: dynamicTexture },
      uDetail: { value: detailTexture },
      uFoamHistory: { value: dynamicTexture },
      uFoamHistoryEnabled: { value: profile.foamMode === 'history' ? 1 : 0 },
      uWaveTime: { value: 0 },
      uBoardSize: { value: new THREE.Vector2(1, 1) },
      uImpactCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uImpactStrength: { value: 0 },
      uFlowGate: { value: 0 },
      uBandAmplitude: { value: new THREE.Vector3() },
      uBandFrequency: { value: new THREE.Vector3() },
      uBandSpeed: { value: new THREE.Vector3() },
      uBandCrossFlow: { value: new THREE.Vector3() },
      uBandPhase: { value: new THREE.Vector3() },
      uBandCount: { value: 1 },
      uDepthScaleMeters: { value: dynamicState.encoding.depthScale },
      uCellWidthMeters: { value: cellWidthMeters },
      uDetailStrength: { value: 0 },
      uFresnelPower: { value: 2.65 },
      uGlitterStrength: { value: 0.3 },
      uReflectionStrength: { value: 0.68 },
      uSubsurfaceStrength: { value: 0.32 },
      uCameraPosition: { value: new THREE.Vector3() },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: true,
  })
  applyWaterSurfaceProfile(material, profile)
  return { material, topologyTexture, dynamicTexture, detailTexture }
}

interface FallingJetGeometryData {
  ringCount: number
  radialSegments: number
}

export interface FallingJetCenterOffset {
  x: number
  z: number
}

export function sampleFallingJetCenterOffset(
  elapsedMs: number,
  streamProgress: number,
): FallingJetCenterOffset {
  const time = Math.max(0, elapsedMs) / 1_000
  const progress = clamp01(streamProgress)
  return {
    x:
      Math.sin(time * 7.7 - progress * 10.8) *
        (0.016 + progress * 0.024) +
      Math.sin(time * 13.1 - progress * 19.4) * 0.009,
    z:
      Math.sin(time * 8.9 - progress * 8.2) *
        (0.009 + progress * 0.008) -
      (WATER_JET_TOP_Z - WATER_JET_CONTACT_Z) * progress,
  }
}

export function resolveFallingJetContactGap(elapsedMs: number): number {
  const terminal = sampleFallingJetCenterOffset(elapsedMs, 1)
  const terminalNearSurface =
    WATER_JET_TOP_Z + terminal.z - WATER_JET_MIN_CONTACT_RADIUS
  return Math.max(0, terminalNearSurface - WATER_SURFACE_Z)
}

function createFallingJetGeometry(
  ringCount: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const vertexCount = ringCount * radialSegments
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices: number[] = []

  for (let ring = 0; ring < ringCount; ring += 1) {
    const verticalUv = ring / Math.max(1, ringCount - 1)
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const vertexIndex = ring * radialSegments + segment
      uvs[vertexIndex * 2] = segment / radialSegments
      uvs[vertexIndex * 2 + 1] = verticalUv
      if (ring < ringCount - 1) {
        const nextSegment = (segment + 1) % radialSegments
        const nextRing = vertexIndex + radialSegments
        const nextRingSegment = ring * radialSegments + nextSegment + radialSegments
        indices.push(
          vertexIndex,
          nextRing,
          ring * radialSegments + nextSegment,
          ring * radialSegments + nextSegment,
          nextRing,
          nextRingSegment,
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3)
  const normalAttribute = new THREE.BufferAttribute(normals, 3)
  positionAttribute.setUsage(THREE.DynamicDrawUsage)
  normalAttribute.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('normal', normalAttribute)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.userData.fallingJet = { ringCount, radialSegments }
  return geometry
}

function updateFallingJetGeometry(
  geometry: THREE.BufferGeometry,
  dropHeight: number,
  elapsedMs: number,
  frontProgress: number,
  strength: number,
  radiusScale = 1,
) {
  const data = geometry.userData.fallingJet as FallingJetGeometryData
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute
  const time = elapsedMs / 1_000
  const visibleFront = Math.max(0.001, frontProgress)

  for (let ring = 0; ring < data.ringCount; ring += 1) {
    const streamProgress = ring / Math.max(1, data.ringCount - 1)
    const isAheadOfFront = streamProgress > visibleFront
    const renderedProgress = isAheadOfFront ? visibleFront : streamProgress
    const lowerBreakup = smoothstep(0.66, 1, renderedProgress)
    const center = sampleFallingJetCenterOffset(
      elapsedMs,
      renderedProgress,
    )
    const radiusNoise =
      Math.sin(time * 9.8 - renderedProgress * 15.2) * 0.065 +
      Math.sin(time * 16.7 + renderedProgress * 21.0) * 0.032
    const baseRadius = THREE.MathUtils.lerp(0.145, 0.098, renderedProgress)
    const pinch = 1 - lowerBreakup * (0.08 + Math.sin(time * 12 + ring) * 0.05)
    const contactFlare =
      1 +
      smoothstep(0.82, 1, renderedProgress) *
        smoothstep(0.97, 1, frontProgress) *
        0.42
    const radius = isAheadOfFront
      ? 0.0008
      : baseRadius *
        radiusScale *
        (1 + radiusNoise) *
        pinch *
        contactFlare *
        (0.8 + strength * 0.2)
    const y = -dropHeight * renderedProgress

    for (let segment = 0; segment < data.radialSegments; segment += 1) {
      const vertexIndex = ring * data.radialSegments + segment
      const angle = (segment / data.radialSegments) * Math.PI * 2
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      position.setXYZ(
        vertexIndex,
        center.x + cosine * radius,
        y,
        center.z + sine * radius,
      )
      normal.setXYZ(vertexIndex, cosine, 0.08 * lowerBreakup, sine)
    }
  }
  position.needsUpdate = true
  normal.needsUpdate = true
}

export class WaterSceneRuntime {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(29, 1, 0.1, 2_000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly clock = new THREE.Clock()
  private readonly network: ReturnType<typeof buildHydraulicNetwork>
  private readonly bridge: HydraulicBridge
  private readonly topology: WaterTopologyAtlas
  private readonly closedWallLeakTexels: number
  private readonly dynamicState: DynamicStateTextureBuffer
  private readonly velocityAggregator: EdgeVelocityAggregator
  private readonly foamSource: Float32Array
  private readonly foamHistory: WaterFoamRenderTargets | null
  private readonly previousDepth: Float32Array
  private readonly previousVelocityX: Float32Array
  private readonly previousVelocityY: Float32Array
  private readonly previousFoam: Float32Array
  private readonly targetDepth: Float32Array
  private readonly targetVelocityX: Float32Array
  private readonly targetVelocityY: Float32Array
  private readonly targetFoam: Float32Array
  private readonly interpolatedDepth: Float32Array
  private readonly interpolatedVelocityX: Float32Array
  private readonly interpolatedVelocityY: Float32Array
  private readonly interpolatedFoam: Float32Array
  private readonly waterSurfaceMaterial: THREE.ShaderMaterial
  private readonly topologyTexture: THREE.DataTexture
  private readonly dynamicTexture: THREE.DataTexture
  private readonly detailTexture: THREE.DataTexture
  private readonly inletJet: THREE.Mesh
  private readonly outletJet: THREE.Mesh
  private readonly reservoirWater: THREE.Mesh
  private readonly outletPool: THREE.Mesh
  private readonly outletSplashRing: THREE.Mesh
  private readonly inletDroplets: THREE.InstancedMesh
  private readonly outletDroplets: THREE.InstancedMesh
  private readonly splashDroplets: THREE.InstancedMesh
  private readonly bubbles: THREE.InstancedMesh
  private readonly inletSeeds: ParticleSeed[]
  private readonly outletSeeds: ParticleSeed[]
  private readonly splashSeeds: ParticleSeed[]
  private readonly bubbleSeeds: BubbleSeed[]
  private readonly particleDummy = new THREE.Object3D()
  private readonly initialCameraPosition = new THREE.Vector3()
  private readonly initialTarget = new THREE.Vector3()
  private readonly sourcePosition: { x: number; y: number }
  private readonly exitPosition: { x: number; y: number }
  private readonly inletLayout: WaterInletLayout
  private readonly environmentTarget: THREE.WebGLRenderTarget
  private readonly pmremGenerator: THREE.PMREMGenerator
  private readonly introCameraPosition = new THREE.Vector3()
  private readonly introTarget = new THREE.Vector3()
  private surfaceProfile: WaterSurfaceProfile
  private latestSnapshot: HydraulicSnapshotMessage | null = null
  private latestDiagnostics: HydraulicDiagnosticsSnapshot = {
    simulationTime: 0,
    cumulativeInjectedVolume: 0,
    cumulativeOutletVolume: 0,
    currentStoredVolume: 0,
    absoluteMassError: 0,
    relativeMassError: 0,
    maxVelocity: 0,
    activeFlowEdgeCount: 0,
    outletDischarge: 0,
  }
  private latestOutletDischarge = 0
  private lastFoamSimulationTime = 0
  private interpolationStartTime = 0
  private interpolationStartSimulationTime = 0
  private interpolationTargetSimulationTime = 0
  private lastInterpolationAlpha = -1
  private physicsStepHz = 120
  private snapshotHz = 25
  private renderReadyEmitted = false
  private startLabel!: THREE.Sprite
  private frameId = 0
  private elapsedMs = 0
  private waveTimeSeconds = 0
  private speed = 1
  private paused = false
  private requestedPaused = false
  private disposed = false
  private lastStatusAt = -Infinity
  private lastAspect = 0
  private lastParticleAt = -Infinity
  private lastCameraInteractionAt = 0
  private metricsEmitted = false
  private cameraIntroCancelled = false
  private lastVisualElapsedMs = -1
  private needsRender = true
  private lastStatusSignature = ''

  constructor(
    private readonly mount: HTMLDivElement,
    private readonly project: MazeProject,
    private readonly quality: ResolvedWaterQuality,
    private surfaceStyle: WaterSurfaceStyle,
    private readonly onReady: () => void,
    private readonly onStatus: (status: WaterPlaybackStatus) => void,
    private readonly onError: (message: string) => void,
    private readonly onMetrics: (metrics: WaterRuntimeMetrics) => void,
    private readonly reducedMotion: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: quality === 'high',
      alpha: false,
      powerPreference: quality === 'high' ? 'high-performance' : 'low-power',
    })
    try {
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.94
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1.05),
    )
    this.renderer.setClearColor(0xdfeaec, 1)
    if (quality === 'high') {
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }
    this.renderer.domElement.className = 'water-simulation-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this.handleContextLost,
      false,
    )
    this.mount.replaceChildren(this.renderer.domElement)

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer)
    const roomEnvironment = new RoomEnvironment()
    this.environmentTarget = this.pmremGenerator.fromScene(
      roomEnvironment,
      quality === 'high' ? 0.05 : 0.1,
    )
    roomEnvironment.dispose()
    this.scene.environment = this.environmentTarget.texture

    this.sourcePosition = cellScenePosition(
      project.mazeGraph,
      project.startCell,
    )
    this.exitPosition = cellScenePosition(project.mazeGraph, project.endCell)
    this.inletLayout = resolveWaterInletLayout(
      project.mazeGraph.rows,
      this.sourcePosition.y,
    )
    this.network = buildHydraulicNetwork(
      project.mazeGraph,
      project.startCell,
      project.endCell,
    )
    const sourceCellIndex =
      project.startCell.row * project.mazeGraph.cols + project.startCell.col
    const outletCellIndex =
      project.endCell.row * project.mazeGraph.cols + project.endCell.col
    this.topology = buildWaterTopologyAtlas(project.mazeGraph, {
      pixelsPerCell: quality === 'high' ? 16 : 5,
      maxTextureSize: 1_024,
      sourceCellIndex,
      outletCellIndex,
      nodeCellIndices: this.network.nodeCellIndex,
    })
    this.closedWallLeakTexels = countClosedWallLeakTexels(
      project.mazeGraph,
      this.topology,
    )
    this.dynamicState = createDynamicStateTextureBuffer(
      project.mazeGraph.rows,
      project.mazeGraph.cols,
      this.network.nodeCellIndex,
      {
        depthScale: this.network.geometry.maxOpeningDepthMeters * 2,
        velocityScale: 4,
      },
    )
    this.velocityAggregator = new EdgeVelocityAggregator({
      cols: project.mazeGraph.cols,
      nodeCellIndex: this.network.nodeCellIndex,
      edgeFrom: this.network.edgeFrom,
      edgeTo: this.network.edgeTo,
    })
    this.foamSource = new Float32Array(this.network.nodeCount)
    this.previousDepth = new Float32Array(this.network.nodeCount)
    this.previousVelocityX = new Float32Array(this.network.nodeCount)
    this.previousVelocityY = new Float32Array(this.network.nodeCount)
    this.previousFoam = new Float32Array(this.network.nodeCount)
    this.targetDepth = new Float32Array(this.network.nodeCount)
    this.targetVelocityX = new Float32Array(this.network.nodeCount)
    this.targetVelocityY = new Float32Array(this.network.nodeCount)
    this.targetFoam = new Float32Array(this.network.nodeCount)
    this.interpolatedDepth = new Float32Array(this.network.nodeCount)
    this.interpolatedVelocityX = new Float32Array(this.network.nodeCount)
    this.interpolatedVelocityY = new Float32Array(this.network.nodeCount)
    this.interpolatedFoam = new Float32Array(this.network.nodeCount)
    this.surfaceProfile = createWaterSurfaceProfile(
      surfaceStyle,
      quality,
      project.mazeGraph.seed,
    )
    this.foamHistory = quality === 'high'
      ? new WaterFoamRenderTargets(
          Math.min(512, project.mazeGraph.cols),
          Math.min(512, project.mazeGraph.rows),
        )
      : null
    const waterSurface = createWaterSurfaceMaterial(
      this.topology,
      this.dynamicState,
      this.surfaceProfile,
      project.mazeGraph.seed,
      this.network.geometry.cellWidthMeters,
    )
    this.waterSurfaceMaterial = waterSurface.material
    this.topologyTexture = waterSurface.topologyTexture
    this.dynamicTexture = waterSurface.dynamicTexture
    this.detailTexture = waterSurface.detailTexture
    this.foamHistory?.reset(this.renderer)
    if (this.foamHistory) {
      this.waterSurfaceMaterial.uniforms.uFoamHistory.value =
        this.foamHistory.texture
    }
    this.waterSurfaceMaterial.uniforms.uBoardSize.value.set(
      project.mazeGraph.cols,
      project.mazeGraph.rows,
    )
    this.waterSurfaceMaterial.uniforms.uImpactCenter.value.set(
      (this.sourcePosition.x + project.mazeGraph.cols / 2) /
        project.mazeGraph.cols,
      (this.sourcePosition.y + project.mazeGraph.rows / 2) /
        project.mazeGraph.rows,
    )
    this.bridge = createHydraulicBridge({
      onSnapshot: this.handleHydraulicSnapshot,
      onError: (error) => this.onError(error.message),
    })

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = !reducedMotion
    this.controls.dampingFactor = 0.075
    this.controls.enablePan = false
    this.controls.minDistance = 4
    this.controls.maxDistance =
      Math.max(project.mazeGraph.rows, project.mazeGraph.cols) * 3.4
    this.controls.rotateSpeed = 0.32
    this.controls.zoomSpeed = 0.72
    this.controls.minAzimuthAngle = -0.18
    this.controls.maxAzimuthAngle = 0.18
    this.controls.minPolarAngle = Math.PI / 2 - 0.14
    this.controls.maxPolarAngle = Math.PI / 2 + 0.14
    this.controls.addEventListener('start', () => {
      this.lastCameraInteractionAt = performance.now()
      this.cameraIntroCancelled = true
    })

    this.addEnvironment()
    this.addMaze()
    this.addWaterSurface()
    const streams = this.addReservoirAndStreams()
    this.inletJet = streams.inletJet
    this.outletJet = streams.outletJet
    this.reservoirWater = streams.reservoirWater
    this.outletPool = streams.outletPool
    this.outletSplashRing = streams.outletSplashRing

    const particleSystems = this.addParticleSystems()
    this.inletDroplets = particleSystems.inletDroplets
    this.outletDroplets = particleSystems.outletDroplets
    this.splashDroplets = particleSystems.splashDroplets
    this.bubbles = particleSystems.bubbles
    this.inletSeeds = particleSystems.inletSeeds
    this.outletSeeds = particleSystems.outletSeeds
    this.splashSeeds = particleSystems.splashSeeds
    this.bubbleSeeds = particleSystems.bubbleSeeds
    this.resetEffects()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.mount)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.resize()
    this.clock.start()
    void this.bridge
      .initialize({
        graph: project.mazeGraph,
        source: project.startCell,
        outlet: project.endCell,
        solverOptions: {
          physicsStepSeconds: 1 / 120,
          source: {
            targetFlowRateCubicMetersPerSecond: 0.018,
            rampDurationSeconds: 0.75,
          },
        },
        snapshotHz: 25,
      })
      .then((ready) => {
        if (this.disposed) return
        this.physicsStepHz = ready.physicsStepHz
        this.snapshotHz = ready.snapshotHz
        this.metricsEmitted = false
      })
      .catch((error) => {
        if (!this.disposed) {
          this.onError(
            error instanceof Error
              ? error.message
              : '수리 시뮬레이션을 시작할 수 없습니다.',
          )
        }
      })
    this.tick()
    } catch (error) {
      // A constructor that throws is never returned to React, so reclaim every
      // resource allocated up to the failing statement before propagating it.
      this.dispose()
      throw error
    }
  }

  setPaused(paused: boolean) {
    this.requestedPaused = paused
    this.paused = paused || document.hidden
    if (this.paused) this.bridge.pause()
    else this.bridge.resume()
    this.controls.enabled = !this.paused
    this.clock.getDelta()
    if (paused) this.emitStatus(performance.now(), true)
    this.needsRender = true
  }

  setSpeed(speed: number) {
    if (![0.1, 0.5, 1, 2, 4].includes(speed)) {
      throw new RangeError('Water speed must be 0.1, 0.5, 1, 2, or 4.')
    }
    this.speed = speed
  }

  setSurfaceStyle(style: WaterSurfaceStyle) {
    this.surfaceStyle = style
    this.surfaceProfile = createWaterSurfaceProfile(
      style,
      this.quality,
      this.project.mazeGraph.seed,
    )
    applyWaterSurfaceProfile(this.waterSurfaceMaterial, this.surfaceProfile)
    this.metricsEmitted = false
    this.needsRender = true
  }

  restart() {
    this.elapsedMs = 0
    this.waveTimeSeconds = 0
    this.paused = false
    this.requestedPaused = false
    this.controls.enabled = true
    this.bridge.reset()
    resetDynamicStateTexture(this.dynamicState)
    this.dynamicTexture.needsUpdate = true
    this.foamHistory?.reset(this.renderer)
    this.lastFoamSimulationTime = 0
    this.previousDepth.fill(0)
    this.previousVelocityX.fill(0)
    this.previousVelocityY.fill(0)
    this.previousFoam.fill(0)
    this.targetDepth.fill(0)
    this.targetVelocityX.fill(0)
    this.targetVelocityY.fill(0)
    this.targetFoam.fill(0)
    this.interpolatedDepth.fill(0)
    this.interpolatedVelocityX.fill(0)
    this.interpolatedVelocityY.fill(0)
    this.interpolatedFoam.fill(0)
    this.interpolationStartTime = 0
    this.interpolationStartSimulationTime = 0
    this.interpolationTargetSimulationTime = 0
    this.lastInterpolationAlpha = -1
    this.latestSnapshot = null
    this.latestDiagnostics = {
      simulationTime: 0,
      cumulativeInjectedVolume: 0,
      cumulativeOutletVolume: 0,
      currentStoredVolume: 0,
      absoluteMassError: 0,
      relativeMassError: 0,
      maxVelocity: 0,
      activeFlowEdgeCount: 0,
      outletDischarge: 0,
    }
    this.latestOutletDischarge = 0
    this.waterSurfaceMaterial.uniforms.uWaveTime.value = 0
    this.lastVisualElapsedMs = -1
    this.lastStatusAt = -Infinity
    this.lastStatusSignature = ''
    this.cameraIntroCancelled = this.reducedMotion
    this.resetEffects()
    this.fitCamera()
    this.onStatus({
      elapsedMs: 0,
      simulationTime: 0,
      filledCells: 0,
      totalCells: this.network.nodeCount,
      reachedExit: false,
      complete: false,
      inletState: 'off',
      inletVisible: false,
      outletVisible: false,
      activeFlowEdgeCount: 0,
      cumulativeInjectedVolume: 0,
      cumulativeOutletVolume: 0,
      currentStoredVolume: 0,
      absoluteMassError: 0,
      relativeMassError: 0,
      maxVelocity: 0,
      outletDischarge: 0,
    })
  }

  resetCamera() {
    this.cameraIntroCancelled = true
    this.camera.position.copy(this.initialCameraPosition)
    this.controls.target.copy(this.initialTarget)
    this.controls.update()
    this.needsRender = true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frameId)
    this.bridge?.dispose()
    this.resizeObserver?.disconnect()
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this.handleContextLost,
      false,
    )
    this.controls?.dispose()
    this.topologyTexture?.dispose()
    this.dynamicTexture?.dispose()
    this.detailTexture?.dispose()
    this.foamHistory?.dispose()
    this.environmentTarget?.dispose()
    this.pmremGenerator?.dispose()
    this.scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.InstancedMesh ||
        object instanceof THREE.Points
      ) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material]
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) {
            material.map.dispose()
          }
          material.dispose()
        }
      } else if (object instanceof THREE.Sprite) {
        object.material.map?.dispose()
        object.material.dispose()
      }
    })
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.mount.replaceChildren()
  }

  private handleHydraulicSnapshot = (snapshot: HydraulicSnapshotMessage) => {
    if (this.disposed || this.paused) return
    const hadSnapshot = this.latestSnapshot !== null
    this.velocityAggregator.update(
      snapshot.edgeDischarge,
      snapshot.edgeVelocity,
    )
    const outletStrength = clamp01(
      snapshot.diagnostics.outletDischarge / 0.018,
    )
    writeFlowFoamSource(
      this.velocityAggregator,
      this.foamSource,
      {
        velocityScale: 2.2,
        fluxScale: 0.018,
        sourceNodeIndex: this.network.sourceNode,
        outletNodeIndex: this.network.outletNode,
        impactStrength: sampleWaterInlet(this.elapsedMs).impactStrength,
        outletStrength,
      },
    )
    const foam = this.foamSource
    if (hadSnapshot) {
      this.previousDepth.set(this.interpolatedDepth)
      this.previousVelocityX.set(this.interpolatedVelocityX)
      this.previousVelocityY.set(this.interpolatedVelocityY)
      this.previousFoam.set(this.interpolatedFoam)
      this.interpolationStartSimulationTime = this.dynamicState.stats.simulationTime
    } else {
      this.previousDepth.set(snapshot.depth)
      this.previousVelocityX.set(this.velocityAggregator.velocityX)
      this.previousVelocityY.set(this.velocityAggregator.velocityY)
      this.previousFoam.set(foam)
      this.interpolatedDepth.set(this.previousDepth)
      this.interpolatedVelocityX.set(this.previousVelocityX)
      this.interpolatedVelocityY.set(this.previousVelocityY)
      this.interpolatedFoam.set(this.previousFoam)
      this.interpolationStartSimulationTime = snapshot.diagnostics.simulationTime
    }
    this.targetDepth.set(snapshot.depth)
    this.targetVelocityX.set(this.velocityAggregator.velocityX)
    this.targetVelocityY.set(this.velocityAggregator.velocityY)
    this.targetFoam.set(foam)
    this.interpolationTargetSimulationTime = snapshot.diagnostics.simulationTime
    this.interpolationStartTime = performance.now()
    this.lastInterpolationAlpha = -1
    this.latestSnapshot = snapshot
    this.latestDiagnostics = snapshot.diagnostics
    this.latestOutletDischarge = snapshot.diagnostics.outletDischarge
    this.needsRender = true
  }

  private updateInterpolatedWaterState(now: number): boolean {
    if (!this.latestSnapshot) return false
    const transitionDurationMs = 1_000 / Math.max(1, this.snapshotHz)
    const alpha = this.interpolationTargetSimulationTime <=
      this.interpolationStartSimulationTime
      ? 1
      : clamp01((now - this.interpolationStartTime) / transitionDurationMs)
    if (Math.abs(alpha - this.lastInterpolationAlpha) < 1e-5) return false
    const inverseAlpha = 1 - alpha
    for (let index = 0; index < this.network.nodeCount; index += 1) {
      this.interpolatedDepth[index] =
        this.previousDepth[index] * inverseAlpha + this.targetDepth[index] * alpha
      this.interpolatedVelocityX[index] =
        this.previousVelocityX[index] * inverseAlpha +
        this.targetVelocityX[index] * alpha
      this.interpolatedVelocityY[index] =
        this.previousVelocityY[index] * inverseAlpha +
        this.targetVelocityY[index] * alpha
      this.interpolatedFoam[index] =
        this.previousFoam[index] * inverseAlpha + this.targetFoam[index] * alpha
    }
    updateDynamicStateTexture(this.dynamicState, {
      simulationTime:
        this.interpolationStartSimulationTime * inverseAlpha +
        this.interpolationTargetSimulationTime * alpha,
      depth: this.interpolatedDepth,
      velocityX: this.interpolatedVelocityX,
      velocityY: this.interpolatedVelocityY,
      foamSource: this.interpolatedFoam,
    })
    this.dynamicTexture.needsUpdate = true
    if (this.foamHistory) {
      const foamDelta = Math.max(
        0,
        Math.min(
          1,
          this.dynamicState.stats.simulationTime - this.lastFoamSimulationTime,
        ),
      )
      const texture = this.foamHistory.step(
        this.renderer,
        this.dynamicTexture,
        foamDelta,
        this.surfaceProfile.foamBuildRate,
        this.surfaceProfile.foamDecayRate,
      )
      this.waterSurfaceMaterial.uniforms.uFoamHistory.value = texture
      this.lastFoamSimulationTime = this.dynamicState.stats.simulationTime
    }
    this.lastInterpolationAlpha = alpha
    return true
  }

  private handleVisibilityChange = () => {
    this.paused = this.requestedPaused || document.hidden
    if (this.paused) this.bridge.pause()
    else this.bridge.resume()
    this.controls.enabled = !this.paused
    this.clock.getDelta()
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault()
    this.paused = true
    this.requestedPaused = true
    this.bridge.pause()
    this.onError('그래픽 컨텍스트가 종료되었습니다. 창을 닫고 다시 열어 주세요.')
  }

  private addEnvironment() {
    const graph = this.project.mazeGraph
    const gradientTexture = createStudioGradientTexture()
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(graph.cols * 3.2 + 12, graph.rows * 3.2 + 12),
      new THREE.MeshBasicMaterial({ map: gradientTexture }),
    )
    background.position.z = -1.25
    this.scene.add(background)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa3aa, 2.35))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.9)
    keyLight.position.set(-9, 13, 18)
    if (this.quality === 'high') {
      keyLight.castShadow = true
      keyLight.shadow.mapSize.set(1_024, 1_024)
      keyLight.shadow.camera.near = 2
      keyLight.shadow.camera.far = 60
      const shadowSpan =
        Math.max(this.project.mazeGraph.cols, this.project.mazeGraph.rows) * 0.8
      keyLight.shadow.camera.left = -shadowSpan
      keyLight.shadow.camera.right = shadowSpan
      keyLight.shadow.camera.top = shadowSpan
      keyLight.shadow.camera.bottom = -shadowSpan
      keyLight.shadow.bias = -0.0007
    }
    this.scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0x77d6ff, 1.45)
    fillLight.position.set(10, -4, 12)
    this.scene.add(fillLight)
    const warmRim = new THREE.DirectionalLight(0xffb46e, 1.1)
    warmRim.position.set(-12, 4, 7)
    this.scene.add(warmRim)
  }

  private addMaze() {
    const graph = this.project.mazeGraph
    const board = new THREE.Mesh(
      new RoundedBoxGeometry(
        graph.cols + 0.72,
        graph.rows + 0.72,
        0.28,
        this.quality === 'high' ? 5 : 2,
        0.16,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xf7f5ef,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.72,
      }),
    )
    board.position.z = -0.19
    board.receiveShadow = true
    this.scene.add(board)

    const inset = new THREE.Mesh(
      new RoundedBoxGeometry(
        graph.cols + 0.18,
        graph.rows + 0.18,
        0.08,
        this.quality === 'high' ? 4 : 2,
        0.1,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xf6f7f3,
        roughness: 0.36,
        metalness: 0,
        envMapIntensity: 0.9,
      }),
    )
    inset.position.z = -0.015
    inset.receiveShadow = true
    this.scene.add(inset)

    const walls = collectWallSpecs(
      graph,
      this.project.startCell,
      this.project.endCell,
    )
    const horizontalWalls = walls.filter(
      (wall) => wall.orientation === 'horizontal',
    )
    const verticalWalls = walls.filter(
      (wall) => wall.orientation === 'vertical',
    )
    const wallMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xff4b0b,
      roughness: 0.22,
      metalness: 0,
      clearcoat: 0.48,
      clearcoatRoughness: 0.19,
      envMapIntensity: 1.18,
    })
    const horizontalGeometry =
      this.quality === 'high'
        ? new RoundedBoxGeometry(1.12, 0.16, 0.68, 3, 0.052)
        : new THREE.BoxGeometry(1.12, 0.16, 0.64)
    const verticalGeometry =
      this.quality === 'high'
        ? new RoundedBoxGeometry(0.16, 1.12, 0.68, 3, 0.052)
        : new THREE.BoxGeometry(0.16, 1.12, 0.64)
    const dummy = new THREE.Object3D()

    const horizontalMesh = new THREE.InstancedMesh(
      horizontalGeometry,
      wallMaterial,
      horizontalWalls.length,
    )
    horizontalWalls.forEach((wall, index) => {
      dummy.position.set(wall.x, wall.y, 0.31)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(wall.width / 1.12, wall.height / 0.16, 1)
      dummy.updateMatrix()
      horizontalMesh.setMatrixAt(index, dummy.matrix)
    })
    horizontalMesh.instanceMatrix.needsUpdate = true
    horizontalMesh.castShadow = this.quality === 'high'
    horizontalMesh.receiveShadow = true
    this.scene.add(horizontalMesh)

    const verticalMesh = new THREE.InstancedMesh(
      verticalGeometry,
      wallMaterial,
      verticalWalls.length,
    )
    verticalWalls.forEach((wall, index) => {
      dummy.position.set(wall.x, wall.y, 0.31)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(wall.width / 0.16, wall.height / 1.12, 1)
      dummy.updateMatrix()
      verticalMesh.setMatrixAt(index, dummy.matrix)
    })
    verticalMesh.instanceMatrix.needsUpdate = true
    verticalMesh.castShadow = this.quality === 'high'
    verticalMesh.receiveShadow = true
    this.scene.add(verticalMesh)

    const startLabel = createLabelSprite(
      'S',
      this.project.visualTheme.startColor,
    )
    startLabel.scale.set(0.42, 0.42, 1)
    startLabel.position.set(
      this.sourcePosition.x - 0.3,
      this.sourcePosition.y + 0.27,
      0.76,
    )
    this.startLabel = startLabel
    const endLabel = createLabelSprite('E', this.project.visualTheme.endColor)
    endLabel.scale.set(0.42, 0.42, 1)
    endLabel.position.set(
      this.exitPosition.x + 0.3,
      this.exitPosition.y - 0.27,
      0.76,
    )
    this.scene.add(startLabel, endLabel)
  }

  private addWaterSurface() {
    const graph = this.project.mazeGraph
    const segmentLimit = this.quality === 'high' ? 96 : 42
    const segmentDensity = this.quality === 'high' ? 4 : 2
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(
        graph.cols,
        graph.rows,
        Math.max(1, Math.min(segmentLimit, graph.cols * segmentDensity)),
        Math.max(1, Math.min(segmentLimit, graph.rows * segmentDensity)),
      ),
      this.waterSurfaceMaterial,
    )
    surface.position.z = WATER_SURFACE_Z
    surface.renderOrder = 5
    this.scene.add(surface)
  }

  private createWaterParticleMaterial() {
    return new THREE.MeshPhysicalMaterial({
      color: WATER_BODY_COLOR,
      emissive: WATER_EMISSIVE_COLOR,
      emissiveIntensity: 0.11,
      roughness: 0.16,
      metalness: 0,
      transmission: this.quality === 'high' ? 0.08 : 0,
      ior: 1.333,
      thickness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      envMapIntensity: 1.05,
    })
  }

  private addReservoirAndStreams() {
    const graph = this.project.mazeGraph
    const { nozzleY, reservoirY, dropHeight } = this.inletLayout
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf6fdff,
      transparent: true,
      opacity: this.quality === 'high' ? 0.24 : 0.42,
      transmission: this.quality === 'high' ? 0.82 : 0,
      ior: 1.49,
      thickness: 0.16,
      roughness: 0.1,
      clearcoat: 1,
      depthWrite: false,
      envMapIntensity: 1.25,
    })
    const reservoir = new THREE.Mesh(
      new RoundedBoxGeometry(1.72, 0.88, 0.56, 4, 0.13),
      glassMaterial,
    )
    reservoir.position.set(this.sourcePosition.x, reservoirY, 0.23)
    reservoir.renderOrder = 14
    this.scene.add(reservoir)

    const waterMaterial = this.createWaterParticleMaterial()
    const reservoirWater = new THREE.Mesh(
      new RoundedBoxGeometry(1.46, 0.48, 0.34, 4, 0.09),
      waterMaterial,
    )
    reservoirWater.position.set(
      this.sourcePosition.x,
      reservoirY - 0.08,
      0.24,
    )
    reservoirWater.renderOrder = 6
    this.scene.add(reservoirWater)

    const nozzleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xdde6e9,
      roughness: 0.18,
      metalness: 0.72,
      clearcoat: 0.46,
      envMapIntensity: 1.45,
    })
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.11,
        0.14,
        0.44,
        this.quality === 'high' ? 20 : 10,
      ),
      nozzleMaterial,
    )
    nozzle.position.set(this.sourcePosition.x, nozzleY + 0.2, 0.34)
    nozzle.castShadow = this.quality === 'high'
    this.scene.add(nozzle)

    const inletJetMaterial = new THREE.MeshStandardMaterial({
      color: 0x28c4dc,
      roughness: 0.48,
      metalness: 0,
      emissive: WATER_EMISSIVE_COLOR,
      emissiveIntensity: 0.28,
      envMapIntensity: 0.18,
      depthWrite: true,
    })
    const inletJet = new THREE.Mesh(
      createFallingJetGeometry(
        this.quality === 'high' ? 28 : 18,
        this.quality === 'high' ? 14 : 8,
      ),
      inletJetMaterial,
    )
    inletJet.position.set(this.sourcePosition.x, nozzleY, WATER_JET_TOP_Z)
    inletJet.frustumCulled = false
    inletJet.renderOrder = 8
    this.scene.add(inletJet)

    const outletJet = new THREE.Mesh(
      createFallingJetGeometry(
        this.quality === 'high' ? 24 : 16,
        this.quality === 'high' ? 12 : 8,
      ),
      waterMaterial.clone(),
    )
    outletJet.position.set(
      this.exitPosition.x,
      -graph.rows / 2,
      WATER_SURFACE_Z,
    )
    outletJet.renderOrder = 8
    outletJet.frustumCulled = false
    this.scene.add(outletJet)

    updateFallingJetGeometry(inletJet.geometry, dropHeight, 0, 0, 0)
    updateFallingJetGeometry(
      outletJet.geometry,
      WATER_OUTLET_DROP_HEIGHT,
      0,
      0,
      0,
      1.28,
    )

    const tray = new THREE.Mesh(
      new RoundedBoxGeometry(2.05, 0.5, 0.54, 4, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0xf2f5f3,
        roughness: 0.34,
        metalness: 0.04,
      }),
    )
    tray.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - WATER_OUTLET_DROP_HEIGHT,
      0.03,
    )
    tray.receiveShadow = true
    tray.castShadow = this.quality === 'high'
    this.scene.add(tray)

    const outletPoolMaterial = waterMaterial.clone()
    outletPoolMaterial.opacity = 0.82
    const outletPool = new THREE.Mesh(
      new RoundedBoxGeometry(1.7, 0.25, 0.18, 4, 0.07),
      outletPoolMaterial,
    )
    outletPool.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - WATER_OUTLET_DROP_HEIGHT,
      0.34,
    )
    outletPool.renderOrder = 9
    outletPool.visible = false
    this.scene.add(outletPool)

    const outletSplashRing = new THREE.Mesh(
      new THREE.TorusGeometry(
        0.24,
        0.035,
        this.quality === 'high' ? 10 : 6,
        this.quality === 'high' ? 28 : 14,
      ),
      new THREE.MeshBasicMaterial({
        color: 0xb8f5ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    )
    outletSplashRing.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - WATER_OUTLET_DROP_HEIGHT,
      0.46,
    )
    outletSplashRing.renderOrder = 12
    outletSplashRing.visible = false
    this.scene.add(outletSplashRing)

    return {
      inletJet,
      outletJet,
      reservoirWater,
      outletPool,
      outletSplashRing,
    }
  }

  private addParticleSystems() {
    const dropletGeometry = new THREE.SphereGeometry(
      0.075,
      this.quality === 'high' ? 12 : 6,
      this.quality === 'high' ? 9 : 5,
    )
    const waterMaterial = this.createWaterParticleMaterial()
    const inletCount = this.quality === 'high' ? 46 : 14
    const outletCount = this.quality === 'high' ? 42 : 14
    const splashCount = this.quality === 'high' ? 64 : 16
    const bubbleCount = Math.min(
      this.quality === 'high' ? 62 : 22,
      Math.max(10, Math.ceil(this.network.nodeCount * 0.48)),
    )

    const inletDroplets = new THREE.InstancedMesh(
      dropletGeometry,
      waterMaterial,
      inletCount,
    )
    inletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    inletDroplets.frustumCulled = false
    inletDroplets.renderOrder = 9
    this.scene.add(inletDroplets)

    const outletDroplets = new THREE.InstancedMesh(
      dropletGeometry.clone(),
      waterMaterial.clone(),
      outletCount,
    )
    outletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    outletDroplets.frustumCulled = false
    outletDroplets.renderOrder = 9
    this.scene.add(outletDroplets)

    const foamMaterial = this.createWaterParticleMaterial()
    foamMaterial.roughness = 0.24
    foamMaterial.opacity = 0.78
    const splashDroplets = new THREE.InstancedMesh(
      new THREE.SphereGeometry(
        0.105,
        this.quality === 'high' ? 12 : 6,
        this.quality === 'high' ? 9 : 5,
      ),
      foamMaterial,
      splashCount,
    )
    splashDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    splashDroplets.frustumCulled = false
    splashDroplets.renderOrder = 11
    this.scene.add(splashDroplets)

    const bubbleGeometry = new THREE.SphereGeometry(
      0.016,
      this.quality === 'high' ? 8 : 5,
      this.quality === 'high' ? 6 : 4,
    )
    const bubbleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf3fdff,
      roughness: 0.04,
      transmission: this.quality === 'high' ? 0.72 : 0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      clearcoat: 1,
    })
    const bubbles = new THREE.InstancedMesh(
      bubbleGeometry,
      bubbleMaterial,
      bubbleCount,
    )
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    bubbles.frustumCulled = false
    bubbles.renderOrder = 12
    this.scene.add(bubbles)

    const inletSeeds = createParticleSeeds(inletCount, 11)
    const outletSeeds = createParticleSeeds(outletCount, 29)
    const splashSeeds = createParticleSeeds(splashCount, 47)
    const bubbleSeeds: BubbleSeed[] = createParticleSeeds(
      bubbleCount,
      71,
    ).map((seed, index) => ({
      ...seed,
      nodeIndex: Math.min(
        this.network.nodeCount - 1,
        Math.floor(seededUnit(index, 83) * this.network.nodeCount),
      ),
    }))

    return {
      inletDroplets,
      outletDroplets,
      splashDroplets,
      bubbles,
      inletSeeds,
      outletSeeds,
      splashSeeds,
      bubbleSeeds,
    }
  }

  private hideParticle(mesh: THREE.InstancedMesh, index: number) {
    this.particleDummy.position.set(0, 0, -20)
    this.particleDummy.rotation.set(0, 0, 0)
    this.particleDummy.scale.setScalar(0.001)
    this.particleDummy.updateMatrix()
    mesh.setMatrixAt(index, this.particleDummy.matrix)
  }

  private resetEffects() {
    this.inletJet.visible = false
    updateFallingJetGeometry(
      this.inletJet.geometry,
      this.inletLayout.dropHeight,
      0,
      0,
      0,
    )
    this.outletJet.scale.set(1, 1, 1)
    this.outletJet.visible = false
    this.outletPool.visible = false
    this.outletSplashRing.visible = false
    this.startLabel.visible = true
    this.waterSurfaceMaterial.uniforms.uImpactStrength.value = 0
    this.waterSurfaceMaterial.uniforms.uFlowGate.value = 0
    for (let index = 0; index < this.inletSeeds.length; index += 1) {
      this.hideParticle(this.inletDroplets, index)
    }
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      this.hideParticle(this.outletDroplets, index)
    }
    for (let index = 0; index < this.splashSeeds.length; index += 1) {
      this.hideParticle(this.splashDroplets, index)
    }
    for (let index = 0; index < this.bubbleSeeds.length; index += 1) {
      this.hideParticle(this.bubbles, index)
    }
    this.inletDroplets.instanceMatrix.needsUpdate = true
    this.outletDroplets.instanceMatrix.needsUpdate = true
    this.splashDroplets.instanceMatrix.needsUpdate = true
    this.bubbles.instanceMatrix.needsUpdate = true
  }

  private updateStreams() {
    const graph = this.project.mazeGraph
    const inlet = sampleWaterHandoff(this.elapsedMs)
    updateFallingJetGeometry(
      this.inletJet.geometry,
      this.inletLayout.dropHeight,
      this.elapsedMs,
      inlet.frontProgress,
      inlet.strength,
    )
    const contactOffset = sampleFallingJetCenterOffset(
      this.elapsedMs,
      inlet.frontProgress,
    )
    this.inletJet.visible = inlet.strength > 0.01
    this.startLabel.visible =
      this.elapsedMs < WATER_INLET_IMPACT_MS - 140
    this.waterSurfaceMaterial.uniforms.uImpactStrength.value =
      inlet.impactStrength
    this.waterSurfaceMaterial.uniforms.uImpactCenter.value.set(
      (this.sourcePosition.x + contactOffset.x + graph.cols / 2) /
        graph.cols,
      (this.sourcePosition.y + graph.rows / 2) / graph.rows,
    )
    this.waterSurfaceMaterial.uniforms.uFlowGate.value = inlet.surfaceGate

    const outletStrength = smoothstep(
      0.00005,
      0.012,
      this.latestOutletDischarge,
    )
    const flowElapsedMs = this.latestDiagnostics.simulationTime * 1_000
    updateFallingJetGeometry(
      this.outletJet.geometry,
      WATER_OUTLET_DROP_HEIGHT,
      flowElapsedMs,
      outletStrength,
      outletStrength,
      1.28,
    )
    this.outletJet.visible = outletStrength > 0.01

    const poolPulse = 1 + Math.sin(flowElapsedMs * 0.0065) * 0.035
    this.outletPool.visible = outletStrength > 0.01
    this.outletPool.scale.set(poolPulse, 2 - poolPulse, 1)
    const splashPhase = (flowElapsedMs * 0.00145) % 1
    const splashMaterial = this.outletSplashRing.material as THREE.MeshBasicMaterial
    this.outletSplashRing.visible = outletStrength > 0.02
    this.outletSplashRing.scale.setScalar(0.72 + splashPhase * 1.35)
    splashMaterial.opacity =
      (1 - splashPhase) * outletStrength * (this.quality === 'high' ? 0.62 : 0.48)

    const reservoirPulse = 1 + Math.sin(this.elapsedMs * 0.004) * 0.025
    this.reservoirWater.scale.set(
      reservoirPulse,
      1,
      2 - reservoirPulse,
    )
  }

  private updateInletParticles() {
    const inlet = sampleWaterInlet(this.elapsedMs)
    for (let index = 0; index < this.inletSeeds.length; index += 1) {
      const seed = this.inletSeeds[index]
      if (inlet.strength < 0.02) {
        this.hideParticle(this.inletDroplets, index)
        continue
      }
      const phase = (this.elapsedMs * 0.00182 + seed.phase) % 1
      if (phase > inlet.frontProgress + 0.035) {
        this.hideParticle(this.inletDroplets, index)
        continue
      }
      const gravityProgress = phase * phase
      const y =
        this.inletLayout.nozzleY -
        gravityProgress * this.inletLayout.dropHeight
      this.particleDummy.position.set(
        this.sourcePosition.x +
          seed.drift * (0.022 + gravityProgress * 0.09) +
          Math.sin(this.elapsedMs * 0.007 + index) * 0.014,
        y,
        THREE.MathUtils.lerp(
          WATER_JET_TOP_Z,
          WATER_JET_CONTACT_Z,
          gravityProgress,
        ) + seed.depth * (0.04 + gravityProgress * 0.035),
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.12)
      this.particleDummy.scale.set(
        seed.size * inlet.strength * (0.56 - gravityProgress * 0.1),
        seed.size * (0.85 + gravityProgress * 1.2) * inlet.strength,
        seed.size * 0.52 * inlet.strength,
      )
      this.particleDummy.updateMatrix()
      this.inletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.inletDroplets.instanceMatrix.needsUpdate = true
  }

  private updateSplashParticles() {
    const inlet = sampleWaterInlet(this.elapsedMs)
    const sinceImpactMs = this.elapsedMs - WATER_INLET_IMPACT_MS
    const contactOffset = sampleFallingJetCenterOffset(this.elapsedMs, 1)
    for (let index = 0; index < this.splashSeeds.length; index += 1) {
      const seed = this.splashSeeds[index]
      if (inlet.impactStrength < 0.02 || sinceImpactMs < 0) {
        this.hideParticle(this.splashDroplets, index)
        continue
      }
      const lifetime = 0.38 + seed.lift * 0.16
      const crownCount = this.quality === 'high' ? 18 : 7
      const steadyCount = this.quality === 'high' ? 9 : 4
      const initialCrown = sinceImpactMs < 760 && index < crownCount
      if (!initialCrown && index >= steadyCount) {
        this.hideParticle(this.splashDroplets, index)
        continue
      }
      const phase = initialCrown
        ? clamp01(sinceImpactMs / (570 + seed.phase * 170))
        : ((sinceImpactMs / (lifetime * 1_000) + seed.phase) % 1 + 1) % 1
      const age = phase * lifetime
      const crownDirection =
        crownCount <= 1 ? 0 : (index / (crownCount - 1)) * 2 - 1
      const horizontalVelocity = initialCrown
        ? crownDirection * (1.24 + seed.size * 0.3)
        : seed.drift * (0.24 + seed.size * 0.11)
      const verticalVelocity = initialCrown
        ? 1.44 + (1 - Math.abs(crownDirection)) * 0.52 + seed.lift * 0.18
        : 0.5 + seed.lift * 0.28
      const verticalPosition =
        verticalVelocity * age - 0.5 * (initialCrown ? 4.6 : 3.5) * age * age
      const depthVelocity = seed.depth *
        (initialCrown ? 0.22 : 0.08 + seed.size * 0.04)
      this.particleDummy.position.set(
        this.sourcePosition.x + contactOffset.x + horizontalVelocity * age,
        this.inletLayout.impactY + verticalPosition,
        WATER_JET_TOP_Z + contactOffset.z + depthVelocity * age +
          Math.sin(phase * Math.PI) * 0.08,
      )
      const verticalSpeed =
        verticalVelocity - (initialCrown ? 4.6 : 3.5) * age
      this.particleDummy.rotation.set(
        0,
        0,
        Math.atan2(verticalSpeed, horizontalVelocity) - Math.PI / 2,
      )
      const initialBurst = Math.exp(-Math.max(0, sinceImpactMs) / 700)
      const splashStrength =
        inlet.impactStrength * (0.1 + initialBurst * 0.72)
      const fade = Math.sin(phase * Math.PI) * splashStrength
      const sizeScale = initialCrown ? 0.42 : 0.24
      this.particleDummy.scale.set(
        Math.max(0.001, seed.size * fade * sizeScale),
        Math.max(
          0.001,
          seed.size * fade * (sizeScale + Math.abs(verticalSpeed) * 0.3),
        ),
        Math.max(0.001, seed.size * fade * sizeScale * 0.9),
      )
      this.particleDummy.updateMatrix()
      this.splashDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.splashDroplets.instanceMatrix.needsUpdate = true
  }

  private updateOutletParticles() {
    const graph = this.project.mazeGraph
    const bottomEdge = -graph.rows / 2
    const flowElapsedMs = this.latestDiagnostics.simulationTime * 1_000
    const outletStrength = smoothstep(
      0.00005,
      0.012,
      this.latestOutletDischarge,
    )
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      const seed = this.outletSeeds[index]
      if (outletStrength < 0.02) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const phase = (flowElapsedMs * 0.0018 + seed.phase + 10) % 1
      const fan = Math.sin(phase * Math.PI)
      this.particleDummy.position.set(
        this.exitPosition.x + seed.drift * fan * 0.38,
        bottomEdge - 0.08 - phase * (1.34 + seed.lift * 0.18),
        WATER_SURFACE_Z + seed.depth * 0.08 + fan * 0.07,
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.45)
      const fade = Math.sin(phase * Math.PI) * outletStrength
      this.particleDummy.scale.set(
        seed.size * fade * 1.08,
        seed.size * fade * (1.3 + phase * 1.4),
        seed.size * fade * 0.9,
      )
      this.particleDummy.updateMatrix()
      this.outletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.outletDroplets.instanceMatrix.needsUpdate = true
  }

  private updateBubbles() {
    const flowElapsedMs = this.latestDiagnostics.simulationTime * 1_000
    for (let index = 0; index < this.bubbleSeeds.length; index += 1) {
      const seed = this.bubbleSeeds[index]
      const nodeIndex = seed.nodeIndex
      const depth = this.interpolatedDepth[nodeIndex]
      if (depth <= 1e-5) {
        this.hideParticle(this.bubbles, index)
        continue
      }
      const cellIndex = this.network.nodeCellIndex[nodeIndex]
      const position = cellScenePosition(
        this.project.mazeGraph,
        {
          row: Math.floor(cellIndex / this.project.mazeGraph.cols),
          col: cellIndex % this.project.mazeGraph.cols,
        },
      )
      const phase = (flowElapsedMs * 0.00042 + seed.phase) % 1
      this.particleDummy.position.set(
        position.x +
          seed.drift * 0.22 +
          Math.sin(flowElapsedMs * 0.002 + index) * 0.045,
        position.y - 0.27 + phase * 0.52,
        0.22 + seed.depth * 0.08,
      )
      this.particleDummy.rotation.set(0, 0, 0)
      const activity = Math.max(
        0.28,
        this.foamSource[nodeIndex] ?? 0,
      )
      const pulse = 0.62 + Math.sin(flowElapsedMs * 0.006 + index) * 0.16
      this.particleDummy.scale.setScalar(seed.size * pulse * activity)
      this.particleDummy.updateMatrix()
      this.bubbles.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.bubbles.instanceMatrix.needsUpdate = true
  }

  private updateEffects(now: number) {
    this.updateStreams()
    const impactBurstActive =
      this.elapsedMs >= WATER_INLET_IMPACT_MS &&
      this.elapsedMs < WATER_INLET_IMPACT_MS + 1_400
    // The status callback and pause button can land between throttled particle
    // frames. Keep the short impact crown in lockstep with simulation time so
    // a paused collision frame never loses the actual splash.
    if (impactBurstActive) this.updateSplashParticles()
    if (now - this.lastParticleAt < (this.quality === 'high' ? 24 : 44)) return
    this.lastParticleAt = now
    this.updateInletParticles()
    if (!impactBurstActive) this.updateSplashParticles()
    this.updateOutletParticles()
    this.updateBubbles()
  }

  private emitStatus(now: number, force = false) {
    if (!force && now - this.lastStatusAt < 140) return
    this.lastStatusAt = now
    const inlet = sampleWaterInlet(this.elapsedMs)
    const reachedExit = this.latestDiagnostics.cumulativeOutletVolume > 1e-8
    const status: WaterPlaybackStatus = {
      elapsedMs: this.elapsedMs,
      simulationTime: this.latestDiagnostics.simulationTime,
      filledCells: this.dynamicState.stats.wetCellCount,
      totalCells: this.network.nodeCount,
      reachedExit,
      complete: reachedExit,
      inletState: inlet.state,
      inletVisible: inlet.strength > 0.01,
      outletVisible: this.latestOutletDischarge > 1e-5,
      activeFlowEdgeCount: this.latestDiagnostics.activeFlowEdgeCount,
      cumulativeInjectedVolume:
        this.latestDiagnostics.cumulativeInjectedVolume,
      cumulativeOutletVolume: this.latestDiagnostics.cumulativeOutletVolume,
      currentStoredVolume: this.latestDiagnostics.currentStoredVolume,
      absoluteMassError: this.latestDiagnostics.absoluteMassError,
      relativeMassError: this.latestDiagnostics.relativeMassError,
      maxVelocity: this.latestDiagnostics.maxVelocity,
      outletDischarge: this.latestOutletDischarge,
    }
    const signature = [
      Math.round(status.elapsedMs),
      status.filledCells,
      status.reachedExit,
      status.complete,
      status.inletState,
      status.inletVisible,
      status.outletVisible,
      status.activeFlowEdgeCount,
      status.cumulativeInjectedVolume.toFixed(8),
      status.cumulativeOutletVolume.toFixed(8),
    ].join(':')
    if (signature === this.lastStatusSignature) return
    this.lastStatusSignature = signature
    this.onStatus(status)
  }

  private emitMetrics() {
    if (this.metricsEmitted || this.renderer.info.render.calls < 1) return
    this.metricsEmitted = true
    this.onMetrics({
      atlasWidth: this.topology.width,
      atlasHeight: this.topology.height,
      closedWallLeakTexels: this.closedWallLeakTexels,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      inletDropHeight: this.inletLayout.dropHeight,
      inletContactGap: resolveFallingJetContactGap(this.elapsedMs),
      outletDropHeight: WATER_OUTLET_DROP_HEIGHT,
      physicsStepHz: this.physicsStepHz,
      snapshotHz: this.snapshotHz,
      solverMode: this.bridge.mode,
      waveBands: this.surfaceProfile.waveBands.length,
      foamMode: this.surfaceProfile.foamMode,
    })
  }

  private fitCamera() {
    const graph = this.project.mazeGraph
    const boardWidth = graph.cols + 1.8
    const topExtent = this.inletLayout.reservoirY + 0.58
    const bottomExtent =
      -graph.rows / 2 - WATER_OUTLET_DROP_HEIGHT - 0.5
    const boardHeight = topExtent - bottomExtent
    const sceneCenterY = (topExtent + bottomExtent) / 2
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov)
    const horizontalFov =
      2 *
      Math.atan(
        Math.tan(verticalFov / 2) * Math.max(0.2, this.camera.aspect),
      )
    const distanceForHeight = boardHeight / (2 * Math.tan(verticalFov / 2))
    const distanceForWidth = boardWidth / (2 * Math.tan(horizontalFov / 2))
    const distance = Math.max(distanceForHeight, distanceForWidth) * 1.035
    const isNarrow = this.camera.aspect < 0.72
    this.camera.position.set(
      isNarrow ? boardWidth * 0.025 : boardWidth * 0.065,
      sceneCenterY + boardHeight * 0.008,
      distance,
    )
    this.controls.target.set(0, sceneCenterY, 0.08)
    this.camera.lookAt(this.controls.target)
    this.initialCameraPosition.copy(this.camera.position)
    this.initialTarget.copy(this.controls.target)

    const introHeight = Math.max(4.2, this.inletLayout.dropHeight + 1.7)
    const introDistance =
      (introHeight / (2 * Math.tan(verticalFov / 2))) * 1.04
    const introCenterY =
      (this.inletLayout.nozzleY + this.inletLayout.impactY) / 2 + 0.18
    this.introCameraPosition.set(
      this.sourcePosition.x + 0.12,
      introCenterY,
      introDistance,
    )
    this.introTarget.set(this.sourcePosition.x, introCenterY, 0.16)

    if (
      !this.reducedMotion &&
      !this.cameraIntroCancelled &&
      this.elapsedMs < 2_700
    ) {
      this.camera.position.copy(this.introCameraPosition)
      this.controls.target.copy(this.introTarget)
      this.camera.lookAt(this.controls.target)
    }
  }

  private updateCameraIntro() {
    if (this.reducedMotion || this.cameraIntroCancelled) return
    const progress = smoothstep(1_080, 2_700, this.elapsedMs)
    this.camera.position.lerpVectors(
      this.introCameraPosition,
      this.initialCameraPosition,
      progress,
    )
    this.controls.target.lerpVectors(
      this.introTarget,
      this.initialTarget,
      progress,
    )
    this.camera.lookAt(this.controls.target)
    if (progress >= 0.999) this.cameraIntroCancelled = true
  }

  private resize() {
    const width = Math.max(1, this.mount.clientWidth)
    const height = Math.max(1, this.mount.clientHeight)
    const nextAspect = width / height
    const shouldRefit =
      this.lastAspect === 0 || Math.abs(nextAspect - this.lastAspect) > 0.08
    this.lastAspect = nextAspect
    this.renderer.setSize(width, height, false)
    this.camera.aspect = nextAspect
    this.camera.updateProjectionMatrix()
    if (shouldRefit) this.fitCamera()
    this.needsRender = true
  }

  private tick = () => {
    if (this.disposed) return
    this.frameId = requestAnimationFrame(this.tick)
    // Wall time only contributes a budget. The bridge always consumes that
    // budget with the solver's fixed 1/120 s step, including at 4x playback.
    const deltaMs = Math.min(5_000, this.clock.getDelta() * 1_000)
    if (!this.paused) {
      const previousElapsedMs = this.elapsedMs
      this.elapsedMs += deltaMs * this.speed
      this.waveTimeSeconds =
        (this.waveTimeSeconds + (deltaMs * this.speed) / 1_000) % 3_600

      // The source remains physically dry during the reservoir/nozzle pre-roll.
      // If this frame crosses the impact instant, only the post-impact slice is
      // handed to the hydraulic solver.
      const previousActiveMs = Math.max(
        0,
        previousElapsedMs - WATER_INLET_IMPACT_MS,
      )
      const nextActiveMs = Math.max(0, this.elapsedMs - WATER_INLET_IMPACT_MS)
      const activeSimulationMs = nextActiveMs - previousActiveMs
      if (activeSimulationMs > 0 && this.bridge.ready) {
        this.bridge.advance(
          activeSimulationMs / (1_000 * this.speed),
          this.speed,
        )
      }
    }
    const now = performance.now()
    const waterStateChanged = this.paused
      ? false
      : this.updateInterpolatedWaterState(now)
    const visualTimeChanged = this.elapsedMs !== this.lastVisualElapsedMs
    if (visualTimeChanged) {
      this.waterSurfaceMaterial.uniforms.uWaveTime.value = this.waveTimeSeconds
      this.updateEffects(now)
      this.updateCameraIntro()
      this.lastVisualElapsedMs = this.elapsedMs
    }
    const controlsChanged = this.paused ? false : this.controls.update()
    this.emitStatus(now)
    if (
      !visualTimeChanged &&
      !waterStateChanged &&
      !controlsChanged &&
      !this.needsRender
    ) return
    this.waterSurfaceMaterial.uniforms.uCameraPosition.value.copy(
      this.camera.position,
    )
    this.renderer.render(this.scene, this.camera)
    this.emitMetrics()
    this.needsRender = false
    if (!this.renderReadyEmitted && this.latestSnapshot) {
      this.renderReadyEmitted = true
      this.onReady()
    }
  }
}
