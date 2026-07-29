import type { MazeProject } from '../core/maze/types'

export interface ProjectRepository {
  list(): Promise<MazeProject[]>
  get(id: string): Promise<MazeProject | null>
  put(project: MazeProject): Promise<void>
  delete(id: string): Promise<void>
  clear(): Promise<void>
}

export interface ProjectAssetRepository {
  putAsset(id: string, value: Blob): Promise<void>
  getAsset(id: string): Promise<Blob | null>
  deleteAsset(id: string): Promise<void>
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function updatedAt(project: MazeProject): number {
  const value = Date.parse(String(project.updatedAt))
  return Number.isFinite(value) ? value : 0
}

export class MemoryProjectRepository
  implements ProjectRepository, ProjectAssetRepository
{
  private readonly projects = new Map<string, MazeProject>()
  private readonly assets = new Map<string, Blob>()

  async list(): Promise<MazeProject[]> {
    return [...this.projects.values()]
      .sort((a, b) => updatedAt(b) - updatedAt(a))
      .map(cloneValue)
  }

  async get(id: string): Promise<MazeProject | null> {
    const project = this.projects.get(id)
    return project ? cloneValue(project) : null
  }

  async put(project: MazeProject): Promise<void> {
    this.projects.set(project.id, cloneValue(project))
  }

  async delete(id: string): Promise<void> {
    this.projects.delete(id)
  }

  async clear(): Promise<void> {
    this.projects.clear()
    this.assets.clear()
  }

  async putAsset(id: string, value: Blob): Promise<void> {
    this.assets.set(id, value.slice(0, value.size, value.type))
  }

  async getAsset(id: string): Promise<Blob | null> {
    const asset = this.assets.get(id)
    return asset ? asset.slice(0, asset.size, asset.type) : null
  }

  async deleteAsset(id: string): Promise<void> {
    this.assets.delete(id)
  }
}
