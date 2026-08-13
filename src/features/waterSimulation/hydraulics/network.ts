import {
  getActiveCell,
  getCellIndex,
  type CellPosition,
  type MazeGraph,
} from '../../../core/maze'
import {
  elevationForRow,
  portalSillElevation,
  resolveHydraulicGeometry,
  type HydraulicGeometryOptions,
  type ResolvedHydraulicGeometry,
} from './geometry'

export interface HydraulicNetwork {
  readonly rows: number
  readonly cols: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly sourceNode: number
  readonly outletNode: number
  readonly geometry: ResolvedHydraulicGeometry
  /** Packed node -> original row-major MazeGraph cell index. */
  readonly nodeCellIndex: Int32Array
  readonly nodeRow: Int32Array
  readonly nodeCol: Int32Array
  /** Original row-major MazeGraph cell index -> packed node, or -1 if inactive. */
  readonly cellToNode: Int32Array
  readonly elevation: Float64Array
  readonly storageArea: Float64Array
  /** Edge orientation is canonical only; positive Q means edgeFrom -> edgeTo. */
  readonly edgeFrom: Int32Array
  readonly edgeTo: Int32Array
  readonly edgeLength: Float64Array
  readonly edgeWidth: Float64Array
  readonly edgeMaxOpeningDepth: Float64Array
  readonly edgeSillElevation: Float64Array
  readonly edgeResistance: Float64Array
  /** CSR adjacency. Each hydraulic edge occurs exactly twice. */
  readonly adjacencyOffsets: Int32Array
  readonly adjacencyEdges: Int32Array
  readonly adjacencyOtherNode: Int32Array
  /** +1 when the node is edgeFrom, -1 when it is edgeTo. */
  readonly adjacencyOrientation: Int8Array
}

export type HydraulicNetworkOptions = HydraulicGeometryOptions

function assertGraphShape(graph: MazeGraph): void {
  if (
    !Number.isInteger(graph.rows) ||
    !Number.isInteger(graph.cols) ||
    graph.rows < 1 ||
    graph.cols < 1 ||
    graph.cells.length !== graph.rows * graph.cols
  ) {
    throw new RangeError('MazeGraph dimensions and cells are inconsistent.')
  }
}

function resolveEndpoint(
  graph: MazeGraph,
  cellToNode: Int32Array,
  position: CellPosition,
  name: string,
): number {
  const cell = getActiveCell(graph, position)
  if (!cell) throw new RangeError(`${name} must be an active maze cell.`)
  const node = cellToNode[getCellIndex(graph.cols, position)]
  if (node < 0) throw new Error(`${name} could not be mapped to a hydraulic node.`)
  return node
}

export function buildHydraulicNetwork(
  graph: MazeGraph,
  source: CellPosition,
  outlet: CellPosition,
  options: HydraulicNetworkOptions = {},
): HydraulicNetwork {
  assertGraphShape(graph)
  const geometry = resolveHydraulicGeometry(options)
  const cellCount = graph.rows * graph.cols
  const cellToNode = new Int32Array(cellCount)
  cellToNode.fill(-1)

  let nodeCount = 0
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    if (graph.cells[cellIndex]?.active) nodeCount += 1
  }

  const nodeCellIndex = new Int32Array(nodeCount)
  const nodeRow = new Int32Array(nodeCount)
  const nodeCol = new Int32Array(nodeCount)
  const elevation = new Float64Array(nodeCount)
  const storageArea = new Float64Array(nodeCount)
  let packedNode = 0
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const cell = graph.cells[cellIndex]
    if (!cell?.active) continue
    cellToNode[cellIndex] = packedNode
    nodeCellIndex[packedNode] = cellIndex
    nodeRow[packedNode] = cell.row
    nodeCol[packedNode] = cell.col
    elevation[packedNode] = elevationForRow(
      graph.rows,
      cell.row,
      geometry.cellHeightMeters,
    )
    storageArea[packedNode] = geometry.storageAreaSquareMeters
    packedNode += 1
  }

  let edgeCount = 0
  for (let node = 0; node < nodeCount; node += 1) {
    const cell = graph.cells[nodeCellIndex[node]]
    const rightIndex = cell.col + 1 < graph.cols ? nodeCellIndex[node] + 1 : -1
    const bottomIndex = cell.row + 1 < graph.rows ? nodeCellIndex[node] + graph.cols : -1
    if (
      rightIndex >= 0 &&
      cellToNode[rightIndex] >= 0 &&
      !cell.walls.right &&
      !graph.cells[rightIndex].walls.left
    ) edgeCount += 1
    if (
      bottomIndex >= 0 &&
      cellToNode[bottomIndex] >= 0 &&
      !cell.walls.bottom &&
      !graph.cells[bottomIndex].walls.top
    ) edgeCount += 1
  }

  const edgeFrom = new Int32Array(edgeCount)
  const edgeTo = new Int32Array(edgeCount)
  const edgeLength = new Float64Array(edgeCount)
  const edgeWidth = new Float64Array(edgeCount)
  const edgeMaxOpeningDepth = new Float64Array(edgeCount)
  const edgeSillElevation = new Float64Array(edgeCount)
  const edgeResistance = new Float64Array(edgeCount)
  const degree = new Int32Array(nodeCount)
  let edge = 0

  const addEdge = (from: number, to: number, lengthMeters: number): void => {
    edgeFrom[edge] = from
    edgeTo[edge] = to
    edgeLength[edge] = lengthMeters
    edgeWidth[edge] = geometry.passageWidthMeters
    edgeMaxOpeningDepth[edge] = geometry.maxOpeningDepthMeters
    edgeSillElevation[edge] = portalSillElevation(elevation[from], elevation[to])
    const fullArea = geometry.passageWidthMeters * geometry.maxOpeningDepthMeters
    edgeResistance[edge] =
      geometry.frictionCoefficient * lengthMeters / Math.max(fullArea * fullArea, 1e-12)
    degree[from] += 1
    degree[to] += 1
    edge += 1
  }

  for (let node = 0; node < nodeCount; node += 1) {
    const cellIndex = nodeCellIndex[node]
    const cell = graph.cells[cellIndex]
    const rightIndex = cell.col + 1 < graph.cols ? cellIndex + 1 : -1
    const bottomIndex = cell.row + 1 < graph.rows ? cellIndex + graph.cols : -1
    if (
      rightIndex >= 0 &&
      cellToNode[rightIndex] >= 0 &&
      !cell.walls.right &&
      !graph.cells[rightIndex].walls.left
    ) addEdge(node, cellToNode[rightIndex], geometry.cellWidthMeters)
    if (
      bottomIndex >= 0 &&
      cellToNode[bottomIndex] >= 0 &&
      !cell.walls.bottom &&
      !graph.cells[bottomIndex].walls.top
    ) addEdge(node, cellToNode[bottomIndex], geometry.cellHeightMeters)
  }

  const adjacencyOffsets = new Int32Array(nodeCount + 1)
  for (let node = 0; node < nodeCount; node += 1) {
    adjacencyOffsets[node + 1] = adjacencyOffsets[node] + degree[node]
  }
  const adjacencyEdges = new Int32Array(edgeCount * 2)
  const adjacencyOtherNode = new Int32Array(edgeCount * 2)
  const adjacencyOrientation = new Int8Array(edgeCount * 2)
  const cursor = new Int32Array(adjacencyOffsets)
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    const from = edgeFrom[edgeIndex]
    const to = edgeTo[edgeIndex]
    let slot = cursor[from]++
    adjacencyEdges[slot] = edgeIndex
    adjacencyOtherNode[slot] = to
    adjacencyOrientation[slot] = 1
    slot = cursor[to]++
    adjacencyEdges[slot] = edgeIndex
    adjacencyOtherNode[slot] = from
    adjacencyOrientation[slot] = -1
  }

  return {
    rows: graph.rows,
    cols: graph.cols,
    nodeCount,
    edgeCount,
    sourceNode: resolveEndpoint(graph, cellToNode, source, 'source'),
    outletNode: resolveEndpoint(graph, cellToNode, outlet, 'outlet'),
    geometry,
    nodeCellIndex,
    nodeRow,
    nodeCol,
    cellToNode,
    elevation,
    storageArea,
    edgeFrom,
    edgeTo,
    edgeLength,
    edgeWidth,
    edgeMaxOpeningDepth,
    edgeSillElevation,
    edgeResistance,
    adjacencyOffsets,
    adjacencyEdges,
    adjacencyOtherNode,
    adjacencyOrientation,
  }
}

export function findHydraulicNode(
  network: HydraulicNetwork,
  position: CellPosition,
): number {
  if (
    !Number.isInteger(position.row) ||
    !Number.isInteger(position.col) ||
    position.row < 0 ||
    position.row >= network.rows ||
    position.col < 0 ||
    position.col >= network.cols
  ) return -1
  return network.cellToNode[position.row * network.cols + position.col]
}

export function findHydraulicEdge(
  network: HydraulicNetwork,
  firstNode: number,
  secondNode: number,
): number {
  if (
    !Number.isInteger(firstNode) ||
    !Number.isInteger(secondNode) ||
    firstNode < 0 ||
    secondNode < 0 ||
    firstNode >= network.nodeCount ||
    secondNode >= network.nodeCount
  ) return -1
  for (
    let slot = network.adjacencyOffsets[firstNode];
    slot < network.adjacencyOffsets[firstNode + 1];
    slot += 1
  ) {
    if (network.adjacencyOtherNode[slot] === secondNode) {
      return network.adjacencyEdges[slot]
    }
  }
  return -1
}
