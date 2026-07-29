import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import { migrateProject } from '../../core/maze/serialization'
import { solveMaze } from '../../core/maze/solver'
import type { CellPosition, MazeProject } from '../../core/maze/types'
import {
  DEFAULT_SHARE_OPTIONS,
  SHARE_FORMAT_VERSION,
  type MazeSharePayload,
  type ShareLinkResult,
  type ShareOptions,
} from './types'

// Kept below the practical QR byte-mode ceiling as QR is a first-class share
// path, and below common messaging/browser truncation thresholds.
export const MAX_SHARE_URL_LENGTH = 2_000
const MAX_COMPRESSED_BYTES = 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024
const PACKED_GRAPH_KEY = '$graph'

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
    )
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('공유 데이터 형식이 올바르지 않습니다.')
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding)
  } catch {
    throw new Error('공유 데이터를 읽을 수 없습니다.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function packGraph(project: MazeProject): Record<string, unknown> {
  const { mazeGraph, mask: _mask, mazeMetrics: _metrics, ...projectData } =
    project
  const packed = new Uint8Array(Math.ceil((mazeGraph.cells.length * 5) / 8))
  let bitOffset = 0
  for (const cell of mazeGraph.cells) {
    const value =
      (cell.active ? 1 : 0) |
      (cell.walls.top ? 2 : 0) |
      (cell.walls.right ? 4 : 0) |
      (cell.walls.bottom ? 8 : 0) |
      (cell.walls.left ? 16 : 0)
    const byteIndex = bitOffset >> 3
    const shift = bitOffset & 7
    packed[byteIndex] |= value << shift
    if (shift > 3) packed[byteIndex + 1] |= value >> (8 - shift)
    bitOffset += 5
  }
  return {
    ...projectData,
    [PACKED_GRAPH_KEY]: [
      mazeGraph.rows,
      mazeGraph.cols,
      mazeGraph.algorithm,
      mazeGraph.seed,
      bytesToBase64Url(packed),
    ],
  }
}

function unpackGraph(value: Record<string, unknown>): Record<string, unknown> {
  const descriptor = value[PACKED_GRAPH_KEY]
  if (!Array.isArray(descriptor) || descriptor.length !== 5) {
    return value
  }
  const rows = Number(descriptor[0])
  const cols = Number(descriptor[1])
  const algorithm = descriptor[2]
  const seed = descriptor[3]
  const packedValue = descriptor[4]
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    cols < 1 ||
    rows > 500 ||
    cols > 500 ||
    (algorithm !== 'dfs' &&
      algorithm !== 'kruskal' &&
      algorithm !== 'prim') ||
    typeof seed !== 'string' ||
    typeof packedValue !== 'string'
  ) {
    throw new Error('압축된 미로 그래프 정보가 올바르지 않습니다.')
  }
  const count = rows * cols
  const bytes = base64UrlToBytes(packedValue)
  if (bytes.byteLength !== Math.ceil((count * 5) / 8)) {
    throw new Error('압축된 미로 셀 수가 격자 크기와 일치하지 않습니다.')
  }

  const cells = Array.from({ length: count }, (_, index) => {
    const bitOffset = index * 5
    const byteIndex = bitOffset >> 3
    const shift = bitOffset & 7
    let packed = bytes[byteIndex] >> shift
    if (shift > 3) packed |= bytes[byteIndex + 1] << (8 - shift)
    const flags = packed & 31
    return {
      index,
      row: Math.floor(index / cols),
      col: index % cols,
      active: Boolean(flags & 1),
      walls: {
        top: Boolean(flags & 2),
        right: Boolean(flags & 4),
        bottom: Boolean(flags & 8),
        left: Boolean(flags & 16),
      },
    }
  })
  const { [PACKED_GRAPH_KEY]: _packedGraph, ...projectData } = value
  return {
    ...projectData,
    mazeGraph: {
      version: 1,
      rows,
      cols,
      algorithm,
      seed,
      cells,
    },
  }
}

export function createSharePayload(
  project: MazeProject,
  options: Partial<ShareOptions> = {},
  solutionPath?: CellPosition[],
): MazeSharePayload {
  const resolvedOptions: ShareOptions = {
    ...DEFAULT_SHARE_OPTIONS,
    ...options,
  }

  const projectCopy = migrateProject(project)
  const projectRecord = projectCopy as unknown as Record<string, unknown>
  projectCopy.remixAllowed = resolvedOptions.allowRemix
  if (resolvedOptions.creatorName !== undefined) {
    projectCopy.creatorDisplayName = resolvedOptions.creatorName.slice(0, 120)
  }
  if (!resolvedOptions.includeCreatorReplay) {
    projectCopy.creatorReplay = null
  }
  if (!resolvedOptions.includeSolution) {
    delete projectRecord.solution
    delete projectRecord.solutionPath
  }
  const resolvedSolution =
    resolvedOptions.includeSolution && !solutionPath?.length
      ? solveMaze(project.mazeGraph, project.startCell, project.endCell).path
      : solutionPath

  return {
    format: 'mazecraft-share',
    version: SHARE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    options: resolvedOptions,
    project: projectCopy,
    ...(resolvedOptions.includeSolution && resolvedSolution?.length
      ? {
          solutionPath: resolvedSolution
            .slice(0, project.mazeGraph.cells.length)
            .map(({ row, col }) => ({ row, col })),
        }
      : {}),
  }
}

export function encodeSharePayload(payload: MazeSharePayload): string {
  const bytes = strToU8(
    JSON.stringify({
      ...payload,
      project: packGraph(payload.project),
    }),
  )
  if (bytes.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error('공유할 프로젝트 데이터가 너무 큽니다.')
  }
  return bytesToBase64Url(deflateSync(bytes, { level: 9 }))
}

export function decodeSharePayload(encoded: string): MazeSharePayload {
  if (!encoded || encoded.length > MAX_COMPRESSED_BYTES * 2) {
    throw new Error('공유 데이터가 비어 있거나 너무 큽니다.')
  }
  const compressed = base64UrlToBytes(encoded)
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('압축된 공유 데이터가 허용 크기를 초과했습니다.')
  }

  let json: string
  try {
    const inflated = inflateSync(compressed, {
      out: new Uint8Array(MAX_DECOMPRESSED_BYTES + 1),
    })
    if (inflated.byteLength > MAX_DECOMPRESSED_BYTES) {
      throw new Error('압축 해제된 공유 데이터가 너무 큽니다.')
    }
    json = strFromU8(inflated)
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === '압축 해제된 공유 데이터가 너무 큽니다.'
    ) {
      throw cause
    }
    throw new Error('공유 데이터의 압축을 해제할 수 없습니다.')
  }

  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    throw new Error('공유 데이터의 JSON 형식이 올바르지 않습니다.')
  }

  if (
    !isObject(value) ||
    value.format !== 'mazecraft-share' ||
    value.version !== SHARE_FORMAT_VERSION ||
    !isObject(value.options) ||
    !isObject(value.project)
  ) {
    throw new Error('지원하지 않는 메이즈크래프트 공유 데이터입니다.')
  }
  const rawOptions = value.options
  const unpackedProject = unpackGraph(value.project)
  if (typeof unpackedProject.id !== 'string') {
    throw new Error('공유 프로젝트 식별자가 없습니다.')
  }
  const project = migrateProject(unpackedProject)
  const includeSolution = Boolean(rawOptions.includeSolution)
  const allowRemix =
    rawOptions.allowRemix === undefined ? true : Boolean(rawOptions.allowRemix)
  project.remixAllowed = allowRemix
  const solved = includeSolution
    ? solveMaze(project.mazeGraph, project.startCell, project.endCell)
    : undefined
  const solutionPath = solved?.solved ? solved.path : undefined
  return {
    format: 'mazecraft-share',
    version: SHARE_FORMAT_VERSION,
    createdAt:
      typeof value.createdAt === 'string'
        ? value.createdAt
        : new Date().toISOString(),
    options: {
      includeSolution,
      includeCreatorReplay:
        rawOptions.includeCreatorReplay === undefined
          ? true
          : Boolean(rawOptions.includeCreatorReplay),
      allowRemix,
      ...(typeof rawOptions.creatorName === 'string'
        ? { creatorName: rawOptions.creatorName.slice(0, 120) }
        : {}),
    },
    project,
    ...(solutionPath?.length ? { solutionPath } : {}),
  }
}

export function createShareLink(
  payload: MazeSharePayload,
  baseUrl = typeof location === 'undefined'
    ? 'https://localhost/'
    : location.href,
  maximumLength = MAX_SHARE_URL_LENGTH,
): ShareLinkResult {
  let encoded: string
  try {
    encoded = encodeSharePayload(payload)
  } catch (cause) {
    return {
      ok: false,
      reason: 'invalid',
      encodedLength: 0,
      message:
        cause instanceof Error
          ? cause.message
          : '공유 데이터를 만들 수 없습니다.',
    }
  }

  const cleanBase = baseUrl.split('#')[0]
  const url = `${cleanBase}#/play?data=${encoded}`
  if (url.length > maximumLength) {
    return {
      ok: false,
      reason: 'too-large',
      encodedLength: encoded.length,
      message:
        '이미지 데이터가 커서 링크로 공유하기 어렵습니다. 독립 실행 HTML 또는 메이즈크래프트 프로젝트 파일로 내보내세요.',
    }
  }
  return { ok: true, url, encodedLength: encoded.length }
}

export function readShareHash(
  hash = typeof location === 'undefined' ? '' : location.hash,
): MazeSharePayload | null {
  if (!hash.startsWith('#/play')) return null
  const queryStart = hash.indexOf('?')
  if (queryStart < 0) return null
  const encoded = new URLSearchParams(hash.slice(queryStart + 1)).get('data')
  return encoded ? decodeSharePayload(encoded) : null
}
