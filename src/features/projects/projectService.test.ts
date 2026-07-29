import { beforeEach, describe, expect, it } from 'vitest'
import { createTestProject } from '../../test/projectFixture'
import { MemoryProjectRepository } from '../../storage/projectRepository'
import { createProjectFile } from '../export/projectFile'
import { ProjectService } from './projectService'

describe('ProjectService', () => {
  beforeEach(() => localStorage.clear())

  it('복제본을 새 ID로 저장하고 원본 기록을 제거한다', async () => {
    const repository = new MemoryProjectRepository()
    const service = new ProjectService(repository)
    const source = createTestProject()
    const copy = await service.duplicate(source)
    expect(copy.id).not.toBe(source.id)
    expect(copy.creatorReplay).toBeNull()
    expect(await repository.get(copy.id)).toEqual(copy)
  })

  it('삭제 확인을 취소하면 프로젝트를 유지한다', async () => {
    const repository = new MemoryProjectRepository()
    const service = new ProjectService(repository)
    const project = createTestProject()
    await repository.put(project)
    expect(await service.remove(project, () => false)).toBe(false)
    expect(await repository.get(project.id)).not.toBeNull()
  })

  it('마지막으로 연 프로젝트를 새로고침 뒤 복구한다', async () => {
    const repository = new MemoryProjectRepository()
    const service = new ProjectService(repository)
    const project = createTestProject()
    await service.save(project)
    expect((await service.recoverLast())?.id).toBe(project.id)
  })

  it('내보낸 파일을 다른 ID의 프로젝트로 가져온다', async () => {
    const repository = new MemoryProjectRepository()
    const service = new ProjectService(repository)
    const imported = await service.import(
      createProjectFile(createTestProject()),
    )
    expect(imported.id).not.toBe('test-maze')
    expect(await repository.get(imported.id)).toEqual(imported)
  })
})
