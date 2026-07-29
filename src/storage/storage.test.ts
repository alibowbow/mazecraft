import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestProject } from '../test/projectFixture'
import { createAutosave } from './autosave'
import { IndexedDbProjectRepository } from './indexedDb'
import { MemoryProjectRepository } from './projectRepository'
import {
  defaultSettings,
  readSettings,
  resetSettings,
  updateSettings,
} from './settings'

describe('로컬 프로젝트 저장', () => {
  it('메모리 저장소가 복제본을 저장하고 최신순으로 반환한다', async () => {
    const repository = new MemoryProjectRepository()
    const first = createTestProject({
      id: 'first',
      updatedAt: '2026-07-30T01:00:00.000Z',
    })
    const second = createTestProject({
      id: 'second',
      updatedAt: '2026-07-30T02:00:00.000Z',
    })
    await repository.put(first)
    await repository.put(second)
    first.title = '외부 변경'
    expect((await repository.list()).map((project) => project.id)).toEqual([
      'second',
      'first',
    ])
    expect((await repository.get('first'))?.title).toBe('작은 미로')
  })

  it('IndexedDB가 없으면 메모리 폴백으로 동작한다', async () => {
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
    const repository = new IndexedDbProjectRepository()
    const project = createTestProject()
    await repository.put(project)
    expect(await repository.get(project.id)).toEqual(project)
    expect(repository.isMemoryFallback).toBe(true)
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: original,
    })
  })

  it('자동 저장은 연속 변경 중 마지막 프로젝트를 저장한다', async () => {
    vi.useFakeTimers()
    const repository = new MemoryProjectRepository()
    const states: string[] = []
    const autosave = createAutosave(
      repository,
      (status) => states.push(status.state),
      300,
    )
    autosave.schedule(createTestProject({ title: '첫 변경' }))
    autosave.schedule(createTestProject({ title: '마지막 변경' }))
    await vi.advanceTimersByTimeAsync(300)
    await autosave.flush()
    expect((await repository.get('test-maze'))?.title).toBe('마지막 변경')
    expect(states).toEqual(['saving', 'saved'])
    autosave.dispose()
    vi.useRealTimers()
  })

  it('페이지를 떠날 때 debounce 대기 중인 변경을 즉시 저장한다', async () => {
    const repository = new MemoryProjectRepository()
    const autosave = createAutosave(repository, undefined, 10_000)
    autosave.schedule(createTestProject({ title: '닫기 직전 변경' }))
    window.dispatchEvent(new Event('pagehide'))
    await autosave.flush()
    expect((await repository.get('test-maze'))?.title).toBe('닫기 직전 변경')
    autosave.dispose()
  })
})

describe('앱 설정', () => {
  beforeEach(() => localStorage.clear())

  it('검증된 설정만 읽고 기본값으로 복구한다', () => {
    localStorage.setItem(
      'mazecraft.settings.v1',
      JSON.stringify({ theme: 'neon', soundEnabled: false }),
    )
    expect(readSettings()).toMatchObject({
      theme: defaultSettings.theme,
      soundEnabled: false,
    })
  })

  it('부분 설정을 안전하게 갱신하고 초기화한다', () => {
    updateSettings({ theme: 'dark', lastProjectId: 'maze-1' })
    expect(readSettings()).toMatchObject({
      theme: 'dark',
      lastProjectId: 'maze-1',
    })
    expect(resetSettings()).toEqual(defaultSettings)
  })
})
