import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../../core/maze/serialization'
import { createTestProject } from '../../test/projectFixture'
import {
  createShareLink,
  createSharePayload,
  decodeSharePayload,
  encodeSharePayload,
  readShareHash,
} from './codec'
import { createQrSvg } from './qr'
import { createRemixProject } from './remix'

describe('공유 데이터', () => {
  it('URL-safe 압축 데이터로 왕복하며 고스트를 보존한다', () => {
    const project = createTestProject()
    const payload = createSharePayload(project, {
      includeCreatorReplay: true,
    })
    const encoded = encodeSharePayload(payload)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    const restored = decodeSharePayload(encoded).project
    expect(restored.id).toBe(project.id)
    expect(restored.mazeGraph).toEqual(project.mazeGraph)
    expect(restored.creatorReplay).toEqual(project.creatorReplay)
  })

  it('옵션에 따라 제작자 고스트를 제외한다', () => {
    const payload = createSharePayload(createTestProject(), {
      includeCreatorReplay: false,
    })
    expect(payload.project.creatorReplay).toBeNull()
  })

  it('리믹스 허용 옵션을 프로젝트 권한에 일치시킨다', () => {
    const encoded = encodeSharePayload(
      createSharePayload(createTestProject(), { allowRemix: false }),
    )
    const restored = decodeSharePayload(encoded)
    expect(restored.options.allowRemix).toBe(false)
    expect(restored.project.remixAllowed).toBe(false)
  })

  it('해답 포함 옵션에서만 정답 경로를 저장한다', () => {
    const project = createTestProject()
    const path = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 1, col: 0 },
    ]
    expect(
      createSharePayload(project, { includeSolution: false }, path)
        .solutionPath,
    ).toBeUndefined()
    const payload = createSharePayload(
      project,
      { includeSolution: true },
      path,
    )
    expect(
      decodeSharePayload(encodeSharePayload(payload)).solutionPath,
    ).toEqual(path)
  })

  it('공유 hash를 만들고 다시 읽는다', () => {
    const payload = createSharePayload(createTestProject())
    const result = createShareLink(payload, 'https://maze.test/editor#old')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toContain('https://maze.test/editor#/play?data=')
    const hash = result.url.slice(result.url.indexOf('#'))
    expect(readShareHash(hash)?.project.id).toBe('test-maze')
  })

  it('기본 24×24 미로를 안전 길이의 링크로 만든다', () => {
    const project = createDefaultProject({
      seed: 'share-size-test',
      grid: { rows: 24, cols: 24, minimumCellPixels: 8 },
    })
    const result = createShareLink(
      createSharePayload(project),
      'https://maze.test/',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url.length).toBeLessThanOrEqual(2_000)
  })

  it('안전 길이를 넘는 링크를 거부한다', () => {
    const payload = createSharePayload(
      createTestProject({ description: '길다'.repeat(2_000) }),
    )
    const result = createShareLink(payload, 'https://maze.test/', 40)
    expect(result).toMatchObject({ ok: false, reason: 'too-large' })
  })

  it('손상된 데이터는 명확히 거부한다', () => {
    expect(() => decodeSharePayload('not_valid!')).toThrow(
      '공유 데이터 형식이 올바르지 않습니다.',
    )
  })

  it('원본을 덮어쓰지 않는 리믹스를 만들고 출처를 남긴다', () => {
    const source = createTestProject()
    const remix = createRemixProject(source, {
      id: 'remix-id',
      now: '2026-07-30T03:00:00.000Z',
    })
    expect(remix.id).toBe('remix-id')
    expect(remix.creatorReplay).toBeNull()
    expect(remix.attribution).toEqual({
      sourceProjectId: source.id,
      sourceTitle: source.title,
      creatorDisplayName: source.creatorDisplayName,
    })
    expect(source.creatorReplay).not.toBeNull()
  })

  it('제작자가 금지한 프로젝트는 리믹스하지 않는다', () => {
    expect(() =>
      createRemixProject(createTestProject({ remixAllowed: false })),
    ).toThrow('리믹스를 허용하지 않았습니다')
  })

  it('외부 요청 없는 인라인 SVG QR을 만든다', async () => {
    const svg = await createQrSvg('https://maze.test/#/play?data=abc')
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('<script')
  })
})
