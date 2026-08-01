import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestProject } from '../test/projectFixture'
import { renderModelFromProject } from '../renderer/types'
import { MazeCanvas } from './MazeCanvas'

const context = new Proxy<Record<string, unknown>>(
  {},
  {
    get(target, property) {
      if (property in target) return target[property as string]
      return vi.fn()
    },
    set(target, property, value) {
      target[property as string] = value
      return true
    },
  },
) as unknown as CanvasRenderingContext2D

describe('MazeCanvas interactions', () => {
  beforeEach(() => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number
      readonly pointerType: string

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
        this.pointerType = init.pointerType ?? 'mouse'
      }
    }
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('supports keyboard and touch-swipe play movement', () => {
    const onSwipe = vi.fn()
    const project = createTestProject()
    const { getByRole } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="play"
        onSwipe={onSwipe}
      />,
    )
    const canvas = getByRole('application')
    canvas.focus()
    fireEvent.keyDown(window, { code: 'ArrowRight' })
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 40,
      clientY: 80,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 82,
      clientY: 80,
    })

    expect(onSwipe).toHaveBeenNthCalledWith(1, 'right')
    expect(onSwipe).toHaveBeenNthCalledWith(2, 'right')
  })

  it('deduplicates the same shared wall during a drag gesture', () => {
    const onEditGesture = vi.fn()
    const project = createTestProject()
    const { getByRole } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        preferWallHit
        onEditGesture={onEditGesture}
      />,
    )
    const canvas = getByRole('img')
    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      pointerType: 'mouse',
      button: 0,
      clientX: 100,
      clientY: 52,
    })
    fireEvent.pointerMove(canvas, {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 99,
      clientY: 54,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 99,
      clientY: 54,
    })

    const activeWallEdits = onEditGesture.mock.calls
      .map(([gesture]) => gesture)
      .filter((gesture) => gesture.phase !== 'end' && gesture.hit?.kind === 'wall')
    expect(activeWallEdits).toHaveLength(1)
  })

  it.each(['touch', 'mouse'] as const)(
    'preserves the first contact and interpolates a fast %s edit drag',
    (pointerType) => {
      const onEditGesture = vi.fn()
      const project = createTestProject({
        grid: { rows: 5, cols: 1, minimumCellPixels: 24 },
        mask: { rows: 5, cols: 1, cells: Array(5).fill(true) },
        mazeGraph: {
          version: 1,
          rows: 5,
          cols: 1,
          algorithm: 'dfs',
          seed: 'vertical-edit-test',
          cells: Array.from({ length: 5 }, (_, row) => ({
            index: row,
            row,
            col: 0,
            active: true,
            walls: { top: true, right: true, bottom: true, left: true },
          })),
        },
        startCell: { row: 0, col: 0 },
        endCell: { row: 4, col: 0 },
      })
      const { getByRole } = render(
        <MazeCanvas
          model={renderModelFromProject(project)}
          mode="edit"
          preferWallHit
          onEditGesture={onEditGesture}
        />,
      )
      const canvas = getByRole('img')
      fireEvent.pointerDown(canvas, {
        pointerId: 20,
        pointerType,
        button: 0,
        clientX: 86,
        clientY: 33,
      })
      fireEvent.pointerMove(canvas, {
        pointerId: 20,
        pointerType,
        clientX: 86,
        clientY: 167,
      })
      fireEvent.pointerUp(canvas, {
        pointerId: 20,
        pointerType,
        clientX: 86,
        clientY: 167,
      })

      const editedRows = new Set(
        onEditGesture.mock.calls
          .map(([gesture]) => gesture)
          .filter(
            (gesture) =>
              gesture.phase !== 'end' &&
              gesture.hit?.kind === 'wall' &&
              gesture.hit.wall === 'left',
          )
          .map((gesture) => gesture.hit.row),
      )
      expect(editedRows).toEqual(new Set([0, 1, 2, 3, 4]))
      const editedWalls = onEditGesture.mock.calls
        .map(([gesture]) => gesture)
        .filter((gesture) => gesture.phase !== 'end' && gesture.hit?.kind === 'wall')
      expect(editedWalls.every((gesture) => gesture.hit.wall === 'left')).toBe(true)
    },
  )

  it('commits the current edit stroke before switching to a two-finger pinch', () => {
    const onEditGesture = vi.fn()
    const project = createTestProject()
    const { getByRole } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        preferWallHit
        commitEditOnPinch
        onEditGesture={onEditGesture}
      />,
    )
    const canvas = getByRole('img')

    fireEvent.pointerDown(canvas, {
      pointerId: 40,
      pointerType: 'touch',
      clientX: 88,
      clientY: 40,
    })
    fireEvent.pointerMove(canvas, {
      pointerId: 40,
      pointerType: 'touch',
      clientX: 88,
      clientY: 72,
    })
    fireEvent.pointerDown(canvas, {
      pointerId: 41,
      pointerType: 'touch',
      clientX: 130,
      clientY: 72,
    })

    const phases = onEditGesture.mock.calls.map(([gesture]) => gesture.phase)
    expect(phases).toContain('end')
    expect(phases).not.toContain('cancel')
  })

  it('cancels a generic drawing stroke before switching to a two-finger pinch', () => {
    const onEditGesture = vi.fn()
    const project = createTestProject()
    const { getByRole } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        onEditGesture={onEditGesture}
      />,
    )
    const canvas = getByRole('img')

    fireEvent.pointerDown(canvas, {
      pointerId: 50,
      pointerType: 'touch',
      clientX: 64,
      clientY: 40,
    })
    fireEvent.pointerMove(canvas, {
      pointerId: 50,
      pointerType: 'touch',
      clientX: 72,
      clientY: 72,
    })
    fireEvent.pointerDown(canvas, {
      pointerId: 51,
      pointerType: 'touch',
      clientX: 120,
      clientY: 72,
    })

    const phases = onEditGesture.mock.calls.map(([gesture]) => gesture.phase)
    expect(phases).toContain('cancel')
    expect(phases).not.toContain('end')
  })

  it('uses a wider touch wall target without treating the cell centre as a wall', () => {
    const onEditGesture = vi.fn()
    const project = createTestProject()
    const { getByRole } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        preferWallHit
        onEditGesture={onEditGesture}
      />,
    )
    const canvas = getByRole('img')

    fireEvent.pointerDown(canvas, {
      pointerId: 30,
      pointerType: 'touch',
      clientX: 88,
      clientY: 64,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 30,
      pointerType: 'touch',
      clientX: 88,
      clientY: 64,
    })
    fireEvent.pointerDown(canvas, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 64,
      clientY: 64,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 64,
      clientY: 64,
    })

    const starts = onEditGesture.mock.calls
      .map(([gesture]) => gesture)
      .filter((gesture) => gesture.phase === 'start')
    expect(starts[0].hit).toMatchObject({ kind: 'wall', wall: 'right' })
    expect(starts[1].hit).toMatchObject({ kind: 'cell', row: 0, col: 0 })
  })

  it('keeps pan and zoom tools from dispatching edit mutations', () => {
    const project = createTestProject()
    const onEditGesture = vi.fn()
    const onViewportChange = vi.fn()
    const { getByRole, rerender } = render(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        singlePointerAction="pan"
        onEditGesture={onEditGesture}
        onViewportChange={onViewportChange}
      />,
    )
    const canvas = getByRole('img')
    fireEvent.pointerDown(canvas, {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 80,
      clientY: 80,
    })
    fireEvent.pointerMove(canvas, {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 104,
      clientY: 92,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 104,
      clientY: 92,
    })
    expect(onViewportChange).toHaveBeenCalled()
    expect(onEditGesture).not.toHaveBeenCalled()

    onViewportChange.mockClear()
    rerender(
      <MazeCanvas
        model={renderModelFromProject(project)}
        mode="edit"
        singlePointerAction="zoom"
        onEditGesture={onEditGesture}
        onViewportChange={onViewportChange}
      />,
    )
    fireEvent.pointerDown(canvas, {
      pointerId: 4,
      pointerType: 'mouse',
      clientX: 90,
      clientY: 90,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 4,
      pointerType: 'mouse',
      clientX: 90,
      clientY: 90,
    })
    expect(onViewportChange).toHaveBeenCalled()
    expect(onEditGesture).not.toHaveBeenCalled()
  })
})
