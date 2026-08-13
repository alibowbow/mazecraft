export interface HydraulicRenderSnapshot {
  readonly simulationTime: number
  readonly depth: ArrayLike<number>
  readonly velocityX: ArrayLike<number>
  readonly velocityY: ArrayLike<number>
  readonly foamSource?: ArrayLike<number>
}

export interface DynamicStateEncoding {
  /** Physical depth represented by texture R=1. */
  depthScale: number
  /** Absolute physical velocity represented by texture G/B magnitude 1. */
  velocityScale: number
}

export interface DynamicStateTextureStats {
  simulationTime: number
  maximumDepth: number
  maximumVelocity: number
  wetCellCount: number
}

/**
 * cols x rows float texture. RGBA = normalized depth, signed velocity X,
 * signed velocity Y, foam source/history. Maze rows are flipped into WebGL UV
 * order once through nodeToTexelOffset.
 */
export interface DynamicStateTextureBuffer {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
  readonly activeCellIndices: Int32Array
  readonly nodeToTexelOffset: Int32Array
  readonly encoding: DynamicStateEncoding
  readonly stats: DynamicStateTextureStats
  version: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
}

export function createDynamicStateTextureBuffer(
  rows: number,
  cols: number,
  activeCellIndices: Int32Array,
  encoding: DynamicStateEncoding,
): DynamicStateTextureBuffer {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    throw new RangeError('Dynamic state texture dimensions must be positive integers.')
  }
  assertPositiveFinite('depthScale', encoding.depthScale)
  assertPositiveFinite('velocityScale', encoding.velocityScale)
  const nodeToTexelOffset = new Int32Array(activeCellIndices.length)
  const seen = new Uint8Array(rows * cols)
  for (let nodeIndex = 0; nodeIndex < activeCellIndices.length; nodeIndex += 1) {
    const cellIndex = activeCellIndices[nodeIndex]
    if (cellIndex < 0 || cellIndex >= rows * cols || seen[cellIndex]) {
      throw new RangeError('activeCellIndices must contain unique in-grid cells.')
    }
    seen[cellIndex] = 1
    const row = Math.floor(cellIndex / cols)
    const col = cellIndex - row * cols
    nodeToTexelOffset[nodeIndex] = ((rows - 1 - row) * cols + col) * 4
  }
  return {
    width: cols,
    height: rows,
    data: new Float32Array(rows * cols * 4),
    activeCellIndices,
    nodeToTexelOffset,
    encoding: { ...encoding },
    stats: {
      simulationTime: 0,
      maximumDepth: 0,
      maximumVelocity: 0,
      wetCellCount: 0,
    },
    version: 0,
  }
}

function assertSnapshotLength(
  name: string,
  values: ArrayLike<number>,
  expected: number,
): void {
  if (values.length < expected) {
    throw new RangeError(`${name} must contain one value per active node.`)
  }
}

/** Updates the existing RGBA buffer in O(active nodes), without allocations. */
export function updateDynamicStateTexture(
  target: DynamicStateTextureBuffer,
  snapshot: HydraulicRenderSnapshot,
): DynamicStateTextureStats {
  const count = target.activeCellIndices.length
  assertSnapshotLength('depth', snapshot.depth, count)
  assertSnapshotLength('velocityX', snapshot.velocityX, count)
  assertSnapshotLength('velocityY', snapshot.velocityY, count)
  if (snapshot.foamSource) {
    assertSnapshotLength('foamSource', snapshot.foamSource, count)
  }
  if (!Number.isFinite(snapshot.simulationTime) || snapshot.simulationTime < 0) {
    throw new RangeError('simulationTime must be a non-negative finite number.')
  }

  let maximumDepth = 0
  let maximumVelocity = 0
  let wetCellCount = 0
  for (let nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
    const depth = Number(snapshot.depth[nodeIndex])
    const velocityX = Number(snapshot.velocityX[nodeIndex])
    const velocityY = Number(snapshot.velocityY[nodeIndex])
    const foam = snapshot.foamSource ? Number(snapshot.foamSource[nodeIndex]) : 0
    if (
      !Number.isFinite(depth) ||
      !Number.isFinite(velocityX) ||
      !Number.isFinite(velocityY) ||
      !Number.isFinite(foam)
    ) {
      throw new RangeError('Dynamic water state must contain only finite values.')
    }
    const physicalDepth = Math.max(0, depth)
    const speed = Math.hypot(velocityX, velocityY)
    const offset = target.nodeToTexelOffset[nodeIndex]
    target.data[offset] = clamp(physicalDepth / target.encoding.depthScale, 0, 1)
    target.data[offset + 1] = clamp(
      velocityX / target.encoding.velocityScale,
      -1,
      1,
    )
    target.data[offset + 2] = clamp(
      velocityY / target.encoding.velocityScale,
      -1,
      1,
    )
    target.data[offset + 3] = clamp(foam, 0, 1)
    maximumDepth = Math.max(maximumDepth, physicalDepth)
    maximumVelocity = Math.max(maximumVelocity, speed)
    if (physicalDepth > 1e-8) wetCellCount += 1
  }
  target.stats.simulationTime = snapshot.simulationTime
  target.stats.maximumDepth = maximumDepth
  target.stats.maximumVelocity = maximumVelocity
  target.stats.wetCellCount = wetCellCount
  target.version += 1
  return target.stats
}

export function resetDynamicStateTexture(target: DynamicStateTextureBuffer): void {
  target.data.fill(0)
  target.stats.simulationTime = 0
  target.stats.maximumDepth = 0
  target.stats.maximumVelocity = 0
  target.stats.wetCellCount = 0
  target.version += 1
}
