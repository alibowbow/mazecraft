import type { MazeProject } from '../../core/maze/types'

let fallbackIdSequence = 0

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  fallbackIdSequence += 1
  return `maze-remix-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`
}

export interface RemixOverrides {
  title?: string
  now?: string
  id?: string
  sourceCreator?: string
}

export function createRemixProject(
  source: MazeProject,
  overrides: RemixOverrides = {},
): MazeProject {
  if (!source.remixAllowed) {
    throw new Error('제작자가 이 미로의 리믹스를 허용하지 않았습니다.')
  }
  const now = overrides.now ?? new Date().toISOString()
  const copy = structuredClone(source) as MazeProject
  copy.id = overrides.id ?? randomId()
  copy.title = overrides.title ?? `${source.title} 리믹스`
  copy.createdAt = now
  copy.updatedAt = now
  copy.creatorReplay = null
  copy.attribution = {
    sourceProjectId: source.id,
    sourceTitle: source.title,
    creatorDisplayName:
      overrides.sourceCreator || source.creatorDisplayName || undefined,
  }

  return copy
}
