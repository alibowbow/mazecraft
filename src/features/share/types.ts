import type { CellPosition, MazeProject } from '../../core/maze/types'

export const SHARE_FORMAT_VERSION = 1

export interface ShareOptions {
  includeSolution: boolean
  includeCreatorReplay: boolean
  allowRemix: boolean
  creatorName?: string
}

export interface MazeSharePayload {
  format: 'mazecraft-share'
  version: typeof SHARE_FORMAT_VERSION
  createdAt: string
  options: ShareOptions
  project: MazeProject
  solutionPath?: CellPosition[]
}

export interface ShareLinkSuccess {
  ok: true
  url: string
  encodedLength: number
}

export interface ShareLinkFailure {
  ok: false
  reason: 'too-large' | 'invalid'
  encodedLength: number
  message: string
}

export type ShareLinkResult = ShareLinkSuccess | ShareLinkFailure

export const DEFAULT_SHARE_OPTIONS: ShareOptions = {
  includeSolution: false,
  includeCreatorReplay: true,
  allowRemix: true,
}
