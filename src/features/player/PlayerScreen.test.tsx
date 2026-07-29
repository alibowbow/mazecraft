import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MazeCanvasHandle } from '../../components/MazeCanvas'
import type { MoveDirection } from '../../core/maze/types'
import type { MazeRenderFrame } from '../../renderer/types'
import { createTestProject } from '../../test/projectFixture'
import { PlayerScreen } from './PlayerScreen'

vi.mock('../../components/MazeCanvas', () => ({
  MazeCanvas: forwardRef<
    MazeCanvasHandle,
    { frame?: MazeRenderFrame; onSwipe?: (direction: MoveDirection) => void }
  >(function MockMazeCanvas({ frame, onSwipe }, ref) {
    useImperativeHandle(ref, () => ({
      fit: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      draw: vi.fn(),
      getCanvas: () => null,
      getRenderer: () => null,
    }))
    return (
      <div data-testid="maze-canvas" data-solution-count={frame?.solution?.length ?? 0}>
        {(['right', 'down', 'left'] as const).map((direction) => (
          <button key={direction} onClick={() => onSwipe?.(direction)}>
            mock-{direction}
          </button>
        ))}
      </div>
    )
  }),
}))

vi.mock('../../components/DPad', () => ({
  DPad: () => <div data-testid="dpad" />,
}))

describe('PlayerScreen solution visibility', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
  })

  it('keeps the full solution separate from hints and exposes an accessible toggle', () => {
    render(
      <PlayerScreen
        project={createTestProject()}
        allowSolution
        onExit={vi.fn()}
      />,
    )

    const canvas = screen.getByTestId('maze-canvas')
    expect(canvas).toHaveAttribute('data-solution-count', '0')

    fireEvent.click(screen.getByRole('button', { name: '정답 경로 보기' }))
    expect(canvas).toHaveAttribute('data-solution-count', '4')
    expect(screen.getByRole('button', { name: '정답 경로 숨기기' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    fireEvent.click(screen.getByRole('button', { name: '정답 경로 숨기기' }))
    expect(canvas).toHaveAttribute('data-solution-count', '0')
  })

  it('does not expose the solution toggle without permission', () => {
    const props: ComponentProps<typeof PlayerScreen> = {
      project: createTestProject(),
      onExit: vi.fn(),
    }
    render(<PlayerScreen {...props} />)

    expect(screen.queryByRole('button', { name: '정답 경로 보기' })).not.toBeInTheDocument()
  })

  it('ends a time attack when its configured limit expires', async () => {
    vi.useFakeTimers()
    const base = createTestProject()
    const project = createTestProject({
      gameRules: {
        ...base.gameRules,
        mode: 'time-attack',
        timeLimitSeconds: 0.1,
      },
    })
    render(<PlayerScreen project={project} onExit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '혼자 플레이' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(160)
    })

    expect(screen.getByRole('heading', { name: '제한 시간이 끝났습니다' })).toBeVisible()
    expect(screen.queryByText('이야기가 열렸습니다')).not.toBeInTheDocument()
  })

  it('renders only safe completed secret links as real link buttons', () => {
    const base = createTestProject()
    render(
      <PlayerScreen
        project={createTestProject({
          secretReveal: {
            ...base.secretReveal,
            content: {
              kind: 'link',
              label: '다음 이야기 열기',
              url: 'https://example.com/next',
            },
          },
        })}
        onExit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '혼자 플레이' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-right' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-down' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-left' }))

    expect(screen.getByRole('link', { name: '다음 이야기 열기' })).toHaveAttribute(
      'href',
      'https://example.com/next',
    )
  })

  it('does not turn an unsafe completed secret link into navigation', () => {
    const base = createTestProject()
    render(
      <PlayerScreen
        project={createTestProject({
          secretReveal: {
            ...base.secretReveal,
            content: {
              kind: 'link',
              label: '위험한 링크',
              url: 'javascript:alert(1)',
            },
          },
        })}
        onExit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '혼자 플레이' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-right' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-down' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock-left' }))

    expect(screen.queryByRole('link', { name: '위험한 링크' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('안전한 링크 주소를 확인해 주세요.')
  })
})
