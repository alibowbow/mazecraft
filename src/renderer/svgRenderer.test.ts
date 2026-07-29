import { describe, expect, it } from 'vitest'
import { createTestProject } from '../test/projectFixture'
import { renderMazeSvg } from './svgRenderer'
import { renderModelFromProject } from './types'

describe('SVG renderer', () => {
  it('exports walls, endpoints, and a vector solution without remote dependencies', () => {
    const project = createTestProject()
    const svg = renderMazeSvg(renderModelFromProject(project), {
      title: '테스트 미로',
      includeTitle: true,
      solution: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 1 },
        { row: 1, col: 0 },
      ],
    })

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('class="maze-start"')
    expect(svg).toContain('class="maze-end"')
    expect(svg).toContain('stroke-linejoin="round"')
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//)
  })

  it('escapes user-controlled title and description', () => {
    const project = createTestProject()
    const svg = renderMazeSvg(renderModelFromProject(project), {
      title: '<script>alert("x")</script>',
      description: '<img src=x onerror=alert(1)>',
    })

    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&lt;img')
  })
})
