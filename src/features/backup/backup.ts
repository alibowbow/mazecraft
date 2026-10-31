import { migrateProject, serializeProject } from '../../core/maze/serialization'
import type { MazeProject } from '../../core/maze/types'
import type { ProjectRepository } from '../../storage/projectRepository'
import { APP_VERSION } from '../../app/appInfo'

import { BACKUP_FORMAT, BACKUP_VERSION } from './backupFormat'

export { BACKUP_FORMAT, BACKUP_VERSION, MAX_BACKUP_FILE_SIZE } from './backupFormat'

/** Game progress and preferences live in localStorage under these prefixes. */
const STORAGE_PREFIXES = ['mazecraft.', 'mazecraft:']
const CHALLENGE_PREFIX = 'mazecraft.challenges.v1'

export interface MazecraftBackup {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  appVersion: string
  projects: unknown[]
  storage: Record<string, string>
}

export interface RestoreSummary {
  /** Projects new to this device. */
  added: number
  /** Projects replaced by a newer copy from the backup. */
  updated: number
  /** Projects whose copy on this device was already as new or newer. */
  kept: number
  /** Entries that could not be read as projects. */
  invalid: number
  /** Progress and preference entries restored. */
  settings: number
}

function storageArea(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function backedUpKey(key: string): boolean {
  return STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Challenge stars, crafted courses and preferences from this browser. */
export function collectLocalData(storage = storageArea()): Record<string, string> {
  const data: Record<string, string> = {}
  if (!storage) return data
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key || !backedUpKey(key)) continue
      const value = storage.getItem(key)
      if (value !== null) data[key] = value
    }
  } catch {
    // Storage became unavailable while reading; keep what was collected.
  }
  return data
}

export function backupFileName(now = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return `mazecraft-backup-${day}.json`
}

/** Every saved project plus this browser's game progress, as one file. */
export async function createBackup(repository: ProjectRepository, now = new Date()): Promise<{ blob: Blob; projectCount: number }> {
  const projects = await repository.list()
  const backup: MazecraftBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
    projects: projects.map((project) => JSON.parse(serializeProject(project)) as unknown),
    storage: collectLocalData(),
  }
  return {
    blob: new Blob([JSON.stringify(backup)], { type: 'application/json;charset=utf-8' }),
    projectCount: projects.length,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads a backup file's text. Returns null for anything that is not a
 * MazeCraft backup, so the caller can try it as a single project instead.
 */
export function parseBackup(text: string): MazecraftBackup | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.format !== BACKUP_FORMAT) return null
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    throw new Error('이 백업은 더 새로운 버전의 메이즈크래프트에서 만들었습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.')
  }
  const storage: Record<string, string> = {}
  if (isRecord(parsed.storage)) {
    for (const [key, value] of Object.entries(parsed.storage)) {
      if (backedUpKey(key) && typeof value === 'string') storage[key] = value
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: parsed.version,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    storage,
  }
}

function timestamp(project: MazeProject): number {
  const value = Date.parse(project.updatedAt)
  return Number.isFinite(value) ? value : 0
}

interface ChallengeData { stars: Record<string, number>; drafts: Record<string, unknown> }

function readChallengeData(text: string | null): ChallengeData | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) return null
    const stars: Record<string, number> = {}
    if (isRecord(value.stars)) {
      for (const [stage, count] of Object.entries(value.stars)) {
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 3) stars[stage] = count
      }
    }
    return { stars, drafts: isRecord(value.drafts) ? value.drafts : {} }
  } catch {
    return null
  }
}

/** Stars only ever go up; a stage's draft on this device wins over the backup's. */
function mergeChallengeData(local: ChallengeData | null, incoming: ChallengeData): ChallengeData {
  if (!local) return incoming
  const stars = { ...local.stars }
  for (const [stage, count] of Object.entries(incoming.stars)) stars[stage] = Math.max(count, stars[stage] ?? 0)
  return { stars, drafts: { ...incoming.drafts, ...local.drafts } }
}

function restoreLocalData(data: Record<string, string>, storage = storageArea()): number {
  if (!storage) return 0
  let restored = 0
  for (const [key, value] of Object.entries(data)) {
    try {
      const current = storage.getItem(key)
      if (key.startsWith(CHALLENGE_PREFIX)) {
        const incoming = readChallengeData(value)
        if (!incoming) continue
        const merged = JSON.stringify(mergeChallengeData(readChallengeData(current), incoming))
        if (merged !== current) {
          storage.setItem(key, merged)
          restored++
        }
      } else if (current === null) {
        // Preferences already chosen on this device are kept.
        storage.setItem(key, value)
        restored++
      }
    } catch {
      // A full or blocked storage skips the entry; projects are unaffected.
    }
  }
  return restored
}

/**
 * Restore without losing anything on this device: a project is replaced only
 * by a newer copy of itself, and earned challenge stars are never lowered.
 */
export async function restoreBackup(backup: MazecraftBackup, repository: ProjectRepository): Promise<RestoreSummary> {
  const summary: RestoreSummary = { added: 0, updated: 0, kept: 0, invalid: 0, settings: 0 }
  for (const entry of backup.projects) {
    let project: MazeProject
    try {
      project = migrateProject(entry)
    } catch {
      summary.invalid++
      continue
    }
    const existing = await repository.get(project.id)
    if (!existing) {
      await repository.put(project)
      summary.added++
    } else if (timestamp(project) > timestamp(existing)) {
      await repository.put(project)
      summary.updated++
    } else {
      summary.kept++
    }
  }
  summary.settings = restoreLocalData(backup.storage)
  return summary
}

export function describeRestore(summary: RestoreSummary): string {
  const parts: string[] = []
  if (summary.added) parts.push(`새 프로젝트 ${summary.added}개`)
  if (summary.updated) parts.push(`최신본으로 바뀐 프로젝트 ${summary.updated}개`)
  if (summary.kept) parts.push(`이 기기의 최신본 유지 ${summary.kept}개`)
  if (summary.settings) parts.push(`기록과 설정 ${summary.settings}개`)
  const body = parts.length ? `백업을 복원했습니다: ${parts.join(', ')}.` : '백업에 새로 가져올 항목이 없었습니다.'
  return summary.invalid ? `${body} 읽을 수 없는 프로젝트 ${summary.invalid}개는 건너뛰었습니다.` : body
}
