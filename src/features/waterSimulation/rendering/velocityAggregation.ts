export interface EdgeVelocityTopology {
  readonly cols: number
  readonly nodeCellIndex: Int32Array
  readonly edgeFrom: Int32Array
  readonly edgeTo: Int32Array
}

export interface CellVelocityField {
  readonly velocityX: Float32Array
  readonly velocityY: Float32Array
  readonly speed: Float32Array
  readonly fluxMagnitude: Float32Array
  /** Positive values indicate local accumulation/compression. */
  readonly convergence: Float32Array
  /** Zero for coherent straight flow, one for fully opposed/turning flow. */
  readonly turn: Float32Array
}

/**
 * Allocation-free edge-to-cell reducer. Q is signed edgeFrom -> edgeTo.
 * Rendering Y is inverted because maze rows grow downwards.
 */
export class EdgeVelocityAggregator implements CellVelocityField {
  readonly velocityX: Float32Array
  readonly velocityY: Float32Array
  readonly speed: Float32Array
  readonly fluxMagnitude: Float32Array
  readonly convergence: Float32Array
  readonly turn: Float32Array

  private readonly directionX: Float64Array
  private readonly directionY: Float64Array
  private readonly weightedVelocityX: Float64Array
  private readonly weightedVelocityY: Float64Array
  private readonly directionSumX: Float64Array
  private readonly directionSumY: Float64Array
  private readonly weight: Float64Array

  constructor(private readonly topology: EdgeVelocityTopology) {
    const nodeCount = topology.nodeCellIndex.length
    if (!Number.isInteger(topology.cols) || topology.cols < 1) {
      throw new RangeError('cols must be a positive integer.')
    }
    if (topology.edgeFrom.length !== topology.edgeTo.length) {
      throw new RangeError('edgeFrom and edgeTo must have the same length.')
    }
    this.velocityX = new Float32Array(nodeCount)
    this.velocityY = new Float32Array(nodeCount)
    this.speed = new Float32Array(nodeCount)
    this.fluxMagnitude = new Float32Array(nodeCount)
    this.convergence = new Float32Array(nodeCount)
    this.turn = new Float32Array(nodeCount)
    this.directionX = new Float64Array(topology.edgeFrom.length)
    this.directionY = new Float64Array(topology.edgeFrom.length)
    this.weightedVelocityX = new Float64Array(nodeCount)
    this.weightedVelocityY = new Float64Array(nodeCount)
    this.directionSumX = new Float64Array(nodeCount)
    this.directionSumY = new Float64Array(nodeCount)
    this.weight = new Float64Array(nodeCount)

    for (let edgeIndex = 0; edgeIndex < topology.edgeFrom.length; edgeIndex += 1) {
      const from = topology.edgeFrom[edgeIndex]
      const to = topology.edgeTo[edgeIndex]
      if (from < 0 || from >= nodeCount || to < 0 || to >= nodeCount || from === to) {
        throw new RangeError('Each hydraulic edge must connect two distinct nodes.')
      }
      const fromCell = topology.nodeCellIndex[from]
      const toCell = topology.nodeCellIndex[to]
      const fromRow = Math.floor(fromCell / topology.cols)
      const toRow = Math.floor(toCell / topology.cols)
      const deltaX = (toCell % topology.cols) - (fromCell % topology.cols)
      const deltaY = -(toRow - fromRow)
      const length = Math.hypot(deltaX, deltaY)
      if (!(length > 0) || !Number.isFinite(length)) {
        throw new RangeError('Hydraulic edge cells must have distinct positions.')
      }
      this.directionX[edgeIndex] = deltaX / length
      this.directionY[edgeIndex] = deltaY / length
    }
  }

  update(
    edgeDischarge: ArrayLike<number>,
    edgeVelocity?: ArrayLike<number>,
  ): this {
    const edgeCount = this.topology.edgeFrom.length
    if (edgeDischarge.length < edgeCount) {
      throw new RangeError('edgeDischarge must contain one value per edge.')
    }
    if (edgeVelocity && edgeVelocity.length < edgeCount) {
      throw new RangeError('edgeVelocity must contain one value per edge.')
    }
    this.velocityX.fill(0)
    this.velocityY.fill(0)
    this.speed.fill(0)
    this.fluxMagnitude.fill(0)
    this.convergence.fill(0)
    this.turn.fill(0)
    this.weightedVelocityX.fill(0)
    this.weightedVelocityY.fill(0)
    this.directionSumX.fill(0)
    this.directionSumY.fill(0)
    this.weight.fill(0)

    for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
      const discharge = Number(edgeDischarge[edgeIndex])
      const suppliedVelocity = edgeVelocity ? Number(edgeVelocity[edgeIndex]) : discharge
      if (!Number.isFinite(discharge) || !Number.isFinite(suppliedVelocity)) {
        throw new RangeError('Edge flow state must contain only finite values.')
      }
      const magnitude = Math.abs(discharge)
      if (magnitude <= 1e-14) continue
      const flowSign = discharge < 0 ? -1 : 1
      const velocityMagnitude = Math.abs(suppliedVelocity)
      const flowX = this.directionX[edgeIndex] * flowSign
      const flowY = this.directionY[edgeIndex] * flowSign
      const from = this.topology.edgeFrom[edgeIndex]
      const to = this.topology.edgeTo[edgeIndex]

      this.weightedVelocityX[from] += flowX * velocityMagnitude * magnitude
      this.weightedVelocityY[from] += flowY * velocityMagnitude * magnitude
      this.weightedVelocityX[to] += flowX * velocityMagnitude * magnitude
      this.weightedVelocityY[to] += flowY * velocityMagnitude * magnitude
      this.directionSumX[from] += flowX * magnitude
      this.directionSumY[from] += flowY * magnitude
      this.directionSumX[to] += flowX * magnitude
      this.directionSumY[to] += flowY * magnitude
      this.weight[from] += magnitude
      this.weight[to] += magnitude
      this.fluxMagnitude[from] += magnitude
      this.fluxMagnitude[to] += magnitude
      this.convergence[from] -= discharge
      this.convergence[to] += discharge
    }

    for (let nodeIndex = 0; nodeIndex < this.velocityX.length; nodeIndex += 1) {
      const weight = this.weight[nodeIndex]
      if (weight <= 1e-14) continue
      const velocityX = this.weightedVelocityX[nodeIndex] / weight
      const velocityY = this.weightedVelocityY[nodeIndex] / weight
      this.velocityX[nodeIndex] = velocityX
      this.velocityY[nodeIndex] = velocityY
      this.speed[nodeIndex] = Math.hypot(velocityX, velocityY)
      const coherence = Math.min(
        1,
        Math.hypot(
          this.directionSumX[nodeIndex],
          this.directionSumY[nodeIndex],
        ) / weight,
      )
      this.turn[nodeIndex] = 1 - coherence
    }
    return this
  }
}

export interface FoamSourceOptions {
  velocityScale: number
  fluxScale: number
  velocityWeight?: number
  turnWeight?: number
  compressionWeight?: number
  sourceNodeIndex?: number
  outletNodeIndex?: number
  impactStrength?: number
  outletStrength?: number
}

const saturate = (value: number): number => Math.max(0, Math.min(1, value))

/** Combines flow speed, direction change and compression into a foam source. */
export function writeFlowFoamSource(
  field: CellVelocityField,
  target: Float32Array,
  options: FoamSourceOptions,
): Float32Array {
  const count = field.velocityX.length
  if (target.length < count) {
    throw new RangeError('Foam target must contain one value per node.')
  }
  if (!(options.velocityScale > 0) || !(options.fluxScale > 0)) {
    throw new RangeError('Foam velocityScale and fluxScale must be positive.')
  }
  const velocityWeight = options.velocityWeight ?? 0.32
  const turnWeight = options.turnWeight ?? 0.48
  const compressionWeight = options.compressionWeight ?? 0.42
  for (let nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
    const velocity = saturate(field.speed[nodeIndex] / options.velocityScale)
    const compression = saturate(
      Math.max(0, field.convergence[nodeIndex]) / options.fluxScale,
    )
    target[nodeIndex] = saturate(
      velocity * velocityWeight +
        field.turn[nodeIndex] * turnWeight +
        compression * compressionWeight,
    )
  }
  if (options.sourceNodeIndex !== undefined) {
    const index = options.sourceNodeIndex
    if (index >= 0 && index < count) {
      target[index] = Math.max(target[index], saturate(options.impactStrength ?? 1))
    }
  }
  if (options.outletNodeIndex !== undefined) {
    const index = options.outletNodeIndex
    if (index >= 0 && index < count) {
      target[index] = Math.max(target[index], saturate(options.outletStrength ?? 0.7))
    }
  }
  return target
}
