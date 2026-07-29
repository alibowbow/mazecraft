import { describe, expect, it } from 'vitest'
import { createTestProject } from '../../test/projectFixture'
import { createPrintHtml } from './print'
import {
  createProjectFile,
  projectFileName,
  readProjectFile,
  sanitizeFilename,
} from './projectFile'
import {
  createStandaloneHtml,
  safeJsonForScript,
} from './standaloneHtml'
import { renderMazeSvg } from './svg'

describe('프로젝트 파일', () => {
  it('JSON 프로젝트 파일을 내보내고 다시 불러온다', async () => {
    const project = createTestProject()
    const restored = await readProjectFile(createProjectFile(project))
    expect(restored.id).toBe(project.id)
    expect(restored.mazeGraph).toEqual(project.mazeGraph)
    expect(restored.creatorReplay).toEqual(project.creatorReplay)
    expect(restored.mazeMetrics.solvable).toBe(true)
    expect(projectFileName(project)).toBe('작은 미로.mazecraft')
  })

  it('유효하지 않은 JSON을 거부한다', async () => {
    await expect(
      readProjectFile(new Blob(['{broken'], { type: 'application/json' })),
    ).rejects.toThrow('프로젝트 JSON을 읽을 수 없습니다.')
  })

  it('이전 JSON 구조를 현재 스키마로 마이그레이션한다', async () => {
    const project = createTestProject()
    const legacy = {
      schemaVersion: 0,
      id: 'legacy',
      title: '예전 미로',
      maze: project.mazeGraph,
      start: project.startCell,
      end: project.endCell,
    }
    const restored = await readProjectFile(
      new Blob([JSON.stringify(legacy)], { type: 'application/json' }),
    )
    expect(restored.schemaVersion).toBe(1)
    expect(restored.id).toBe('legacy')
    expect(restored.title).toBe('예전 미로')
  })

  it('운영체제에서 금지된 파일명 문자를 제거한다', () => {
    expect(sanitizeFilename('  a/b:c*?  ')).toBe('a-b-c--')
  })
})

describe('SVG·HTML 내보내기', () => {
  it('벽을 벡터 path로 만들고 제목을 XML 이스케이프한다', () => {
    const svg = renderMazeSvg(
      createTestProject({ title: '<script>alert(1)</script>' }),
      { includeTitle: true },
    )
    expect(svg).toContain('<path')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).not.toContain('<script>')
  })

  it('색상 필드가 외부 리소스 요청으로 바뀌지 않게 제한한다', () => {
    const project = createTestProject({
      visualTheme: {
        ...createTestProject().visualTheme,
        wallColor: 'url(https://tracker.invalid/pixel)',
      },
    })
    const svg = renderMazeSvg(project)
    expect(svg).not.toContain('tracker.invalid')
    expect(svg).toContain('stroke="#172033"')
  })

  it('독립 HTML에 외부 스크립트나 API 호출을 넣지 않는다', () => {
    const html = createStandaloneHtml(createTestProject())
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toMatch(/<script\s+src=/)
    expect(html).toContain('const project=')
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script ?? '')).not.toThrow()
  })

  it('사용자 텍스트가 script 요소를 탈출하지 못한다', () => {
    const escaped = safeJsonForScript({
      message: '</script><script>alert(1)</script>',
    })
    expect(escaped).not.toContain('</script>')
    const html = createStandaloneHtml(
      createTestProject({
        secretReveal: {
          content: {
            kind: 'message',
            message: '</script><script>alert(1)</script>',
          },
          mode: 'on-complete',
          animation: 'none',
        },
      }),
    )
    expect(html.match(/<script>/g)).toHaveLength(1)
  })

  it('인쇄 문서에 정답지와 이름란을 포함한다', () => {
    const html = createPrintHtml(createTestProject(), {
      includeAnswerSheet: true,
      solutionPath: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 1 },
        { row: 1, col: 0 },
      ],
    })
    expect(html).toContain('이름:')
    expect(html).toContain('정답')
    expect(html).toContain('<polyline')
    expect(html).toContain('@page{size:A4 portrait')
  })
})
