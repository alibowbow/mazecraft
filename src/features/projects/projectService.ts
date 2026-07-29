import type { MazeProject } from '../../core/maze/types'
import { readProjectFile } from '../export/projectFile'
import type { ProjectRepository } from '../../storage/projectRepository'
import { readSettings, updateSettings } from '../../storage/settings'

let fallbackIdSequence = 0

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  fallbackIdSequence += 1
  return `maze-project-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`
}

export type DeleteConfirmation = (
  project: MazeProject,
) => boolean | Promise<boolean>

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async recent(limit = 12): Promise<MazeProject[]> {
    const projects = await this.repository.list()
    return projects.slice(0, Math.max(0, limit))
  }

  async load(id: string): Promise<MazeProject | null> {
    const project = await this.repository.get(id)
    if (project) updateSettings({ lastProjectId: project.id })
    return project
  }

  async recoverLast(): Promise<MazeProject | null> {
    const id = readSettings().lastProjectId
    if (!id) return null
    const project = await this.repository.get(id)
    if (!project) updateSettings({ lastProjectId: null })
    return project
  }

  async save(project: MazeProject, touchUpdatedAt = true): Promise<MazeProject> {
    const saved = structuredClone(project)
    if (touchUpdatedAt) saved.updatedAt = new Date().toISOString()
    await this.repository.put(saved)
    updateSettings({ lastProjectId: saved.id })
    return saved
  }

  async duplicate(
    source: MazeProject,
    title = `${source.title} 복사본`,
  ): Promise<MazeProject> {
    const now = new Date().toISOString()
    const copy = structuredClone(source)
    copy.id = randomId()
    copy.title = title
    copy.createdAt = now
    copy.updatedAt = now
    copy.creatorReplay = null
    copy.attribution = null
    await this.repository.put(copy)
    updateSettings({ lastProjectId: copy.id })
    return copy
  }

  async remove(
    project: MazeProject,
    confirmation: DeleteConfirmation = () =>
      typeof window !== 'undefined'
        ? window.confirm(`“${project.title}” 프로젝트를 삭제할까요?`)
        : false,
  ): Promise<boolean> {
    if (!(await confirmation(project))) return false
    await this.repository.delete(project.id)
    if (readSettings().lastProjectId === project.id) {
      updateSettings({ lastProjectId: null })
    }
    return true
  }

  async import(file: Blob, keepId = false): Promise<MazeProject> {
    const imported = await readProjectFile(file)
    const existing = await this.repository.get(imported.id)
    if (!keepId || existing) imported.id = randomId()
    const now = new Date().toISOString()
    imported.createdAt = keepId && !existing ? imported.createdAt : now
    imported.updatedAt = now
    await this.repository.put(imported)
    updateSettings({ lastProjectId: imported.id })
    return imported
  }
}
