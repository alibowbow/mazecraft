import * as THREE from 'three'

export interface OutletWaterfallVisualState {
  strength: number
  frontProgress: number
  timeSeconds: number
}

export interface AdvanceOutletWaterfallOptions {
  targetStrength: number
  deltaSeconds: number
  paused?: boolean
}

interface OutletWaterfallGeometryData {
  readonly rowCount: number
  readonly columnCount: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

const smoothstep = (minimum: number, maximum: number, value: number): number => {
  const normalized = clamp01(
    (value - minimum) / Math.max(1e-9, maximum - minimum),
  )
  return normalized * normalized * (3 - 2 * normalized)
}

const lerp = (from: number, to: number, alpha: number): number =>
  from + (to - from) * alpha

function requireNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`)
  }
}

/** Maps hydraulic discharge to a visually useful, bounded outlet strength. */
export function resolveOutletTargetStrength(
  outletDischargeCubicMetersPerSecond: number,
  fullFlowCubicMetersPerSecond = 0.012,
): number {
  requireNonNegativeFinite(
    'outletDischargeCubicMetersPerSecond',
    outletDischargeCubicMetersPerSecond,
  )
  if (!Number.isFinite(fullFlowCubicMetersPerSecond) || fullFlowCubicMetersPerSecond <= 0) {
    throw new RangeError('fullFlowCubicMetersPerSecond must be positive and finite.')
  }
  const visibleThreshold = Math.min(0.00005, fullFlowCubicMetersPerSecond * 0.1)
  return smoothstep(
    visibleThreshold,
    Math.max(visibleThreshold + 1e-8, fullFlowCubicMetersPerSecond),
    outletDischargeCubicMetersPerSecond,
  )
}

export function createOutletWaterfallVisualState(): OutletWaterfallVisualState {
  return {
    strength: 0,
    frontProgress: 0,
    timeSeconds: 0,
  }
}

export function resetOutletWaterfallVisualState(
  state: OutletWaterfallVisualState,
): OutletWaterfallVisualState {
  state.strength = 0
  state.frontProgress = 0
  state.timeSeconds = 0
  return state
}

/**
 * Smooths 20–30 Hz hydraulic snapshots into a continuous visual stream.
 * Stream length grows once after breakthrough; it never tracks discharge in
 * discrete blocks. Width and opacity follow the separately smoothed strength.
 */
export function advanceOutletWaterfallVisualState(
  state: OutletWaterfallVisualState,
  options: AdvanceOutletWaterfallOptions,
): OutletWaterfallVisualState {
  if (!Number.isFinite(options.targetStrength)) {
    throw new RangeError('targetStrength must be finite.')
  }
  if (
    !Number.isFinite(options.deltaSeconds) ||
    options.deltaSeconds < 0 ||
    options.deltaSeconds > 0.25
  ) {
    throw new RangeError('deltaSeconds must be in the range [0, 0.25].')
  }
  if (options.paused || options.deltaSeconds === 0) return state

  const targetStrength = clamp01(options.targetStrength)
  const responseRate = targetStrength > state.strength ? 8.5 : 4.2
  const response = 1 - Math.exp(-responseRate * options.deltaSeconds)
  state.strength += (targetStrength - state.strength) * response
  if (state.strength < 1e-5 && targetStrength === 0) state.strength = 0

  if (targetStrength > 0.004 || state.strength > 0.004) {
    state.frontProgress = Math.min(
      1,
      state.frontProgress + options.deltaSeconds * 2.65,
    )
  } else {
    state.frontProgress = Math.max(
      0,
      state.frontProgress - options.deltaSeconds * 3.2,
    )
  }

  state.timeSeconds =
    (state.timeSeconds +
      options.deltaSeconds * (0.78 + state.strength * 0.92)) %
    3_600
  return state
}

/** Creates a thin, subdivided waterfall ribbon instead of a low-poly tube. */
export function createOutletWaterfallGeometry(
  quality: 'low' | 'high',
): THREE.BufferGeometry {
  const rowCount = quality === 'high' ? 42 : 30
  const columnCount = quality === 'high' ? 7 : 5
  const positions = new Float32Array(rowCount * columnCount * 3)
  const uvs = new Float32Array(rowCount * columnCount * 2)
  const indices: number[] = []

  for (let row = 0; row < rowCount; row += 1) {
    const progress = row / Math.max(1, rowCount - 1)
    for (let column = 0; column < columnCount; column += 1) {
      const horizontal = column / Math.max(1, columnCount - 1)
      const vertexIndex = row * columnCount + column
      positions[vertexIndex * 3] = (horizontal - 0.5) * 0.28
      positions[vertexIndex * 3 + 1] = -progress
      positions[vertexIndex * 3 + 2] = -progress * 0.06
      uvs[vertexIndex * 2] = horizontal
      uvs[vertexIndex * 2 + 1] = progress

      if (row < rowCount - 1 && column < columnCount - 1) {
        const right = vertexIndex + 1
        const down = vertexIndex + columnCount
        const downRight = down + 1
        indices.push(vertexIndex, down, right, right, down, downRight)
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  const position = new THREE.BufferAttribute(positions, 3)
  position.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', position)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.userData.outletWaterfall = {
    rowCount,
    columnCount,
  } satisfies OutletWaterfallGeometryData
  return geometry
}

export interface UpdateOutletWaterfallOptions {
  dropHeight: number
  state: Readonly<OutletWaterfallVisualState>
}

/** Updates the continuous ribbon with coherent narrowing, flutter and breakup. */
export function updateOutletWaterfallGeometry(
  geometry: THREE.BufferGeometry,
  options: UpdateOutletWaterfallOptions,
): void {
  if (!Number.isFinite(options.dropHeight) || options.dropHeight <= 0) {
    throw new RangeError('dropHeight must be positive and finite.')
  }
  const data = geometry.userData.outletWaterfall as
    | OutletWaterfallGeometryData
    | undefined
  if (!data) throw new Error('Geometry is not an outlet waterfall ribbon.')

  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const visibleFront = Math.max(0.001, clamp01(options.state.frontProgress))
  const strength = clamp01(options.state.strength)
  const time = Math.max(0, options.state.timeSeconds)

  for (let row = 0; row < data.rowCount; row += 1) {
    const streamProgress = row / Math.max(1, data.rowCount - 1)
    const aheadOfFront = streamProgress > visibleFront
    const renderedProgress = aheadOfFront ? visibleFront : streamProgress
    const breakup = smoothstep(0.48, 1, renderedProgress)
    const centerX =
      Math.sin(time * 5.4 - renderedProgress * 8.6) *
        (0.008 + renderedProgress * 0.022) +
      Math.sin(time * 9.7 + renderedProgress * 15.3) * 0.005
    const centerZ =
      -0.015 -
      renderedProgress * 0.075 +
      Math.sin(time * 6.1 - renderedProgress * 10.8) *
        (0.004 + breakup * 0.012)
    const baseHalfWidth = lerp(0.18, 0.105, renderedProgress)
    const halfWidth =
      baseHalfWidth *
      (0.42 + Math.sqrt(Math.max(0.001, strength)) * 0.58)
    const y = -options.dropHeight * renderedProgress

    for (let column = 0; column < data.columnCount; column += 1) {
      const vertexIndex = row * data.columnCount + column
      const horizontal = column / Math.max(1, data.columnCount - 1)
      const signedHorizontal = horizontal * 2 - 1
      const edge = Math.abs(signedHorizontal)
      const flutter =
        Math.sin(
          time * 8.2 -
            renderedProgress * 18.0 +
            signedHorizontal * 3.1,
        ) *
        (0.004 + breakup * 0.012) *
        (0.35 + edge * 0.65)
      const centerBulge =
        (1 - edge * edge) *
        Math.sin(time * 7.0 - renderedProgress * 13.2) *
        (0.004 + breakup * 0.009)
      const hiddenScale = aheadOfFront ? 0.002 : 1
      position.setXYZ(
        vertexIndex,
        centerX + signedHorizontal * halfWidth * hiddenScale + flutter,
        y,
        centerZ + centerBulge,
      )
    }
  }

  position.needsUpdate = true
  geometry.computeVertexNormals()
}

export function createOutletWaterfallMaterial(
  quality: 'low' | 'high',
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x4fd8ec,
    emissive: 0x007b91,
    emissiveIntensity: 0.2,
    roughness: 0.08,
    metalness: 0,
    transmission: quality === 'high' ? 0.26 : 0,
    ior: 1.333,
    thickness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.15,
  })
  material.name = 'maze-outlet-waterfall-ribbon'
  return material
}

export function createOutletDropletGeometry(
  quality: 'low' | 'high',
): THREE.BufferGeometry {
  return new THREE.SphereGeometry(
    0.034,
    quality === 'high' ? 10 : 7,
    quality === 'high' ? 8 : 5,
  )
}
