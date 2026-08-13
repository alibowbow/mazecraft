import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDefaultProject, type MazeProject } from '../src/core/maze'

const fixtureProject = createDefaultProject({
  title: '동적 수리 품질 검증 미로',
  seed: 'water-dynamics-2-e2e',
  grid: { rows: 8, cols: 8, minimumCellPixels: 8 },
})

const comparisonProject = createDefaultProject({
  title: '품질 간 동일 물리 검증 수로',
  seed: 'water-dynamics-2-quality-comparison',
  grid: { rows: 4, cols: 1, minimumCellPixels: 8 },
})

async function openWater(
  page: Page,
  project: MazeProject,
  quality: 'low' | 'high',
) {
  await page.goto('/')
  const importer = page.locator('input[type="file"][accept*=".mazecraft"]')
  if (await importer.count()) {
    await importer.setInputFiles({
      name: `${quality}-water.mazecraft`,
      mimeType: 'application/vnd.mazecraft+json',
      buffer: Buffer.from(JSON.stringify(project)),
    })
  } else {
    await expect(page.getByLabel('프로젝트 제목')).toHaveValue(project.title)
  }
  await page.locator('.studio-stage-rail button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption(quality)
  await page.getByRole('button', { name: '3D 물 시뮬레이션 열기' }).click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', {
    timeout: 20_000,
  })
  return stage
}

const numericAttribute = async (stage: Locator, name: string) =>
  Number(await stage.getAttribute(name))

test('동적 수리 네트워크가 Worker 스냅샷과 보존 진단을 렌더링한다', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const consoleErrors: string[] = []
  const externalRequests: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      externalRequests.push(request.url())
    }
  })

  const stage = await openWater(page, fixtureProject, 'high')
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(canvas).toBeVisible()
  await expect(stage).toHaveAttribute(
    'data-fluid-model',
    'dynamic-head-discharge-network',
  )
  await expect(stage).toHaveAttribute(
    'data-fluid-renderer',
    'dynamic-topology-depth-velocity-foam',
  )
  await expect(stage).toHaveAttribute(
    'data-solver-mode',
    /^(worker|main-thread-fallback)$/,
  )
  await expect(stage).toHaveAttribute(
    'data-water-surface-renderer',
    'directional-multi-band',
  )
  await expect(stage).toHaveAttribute('data-water-surface-style', 'natural')
  await expect(stage).toHaveAttribute('data-wave-bands', '3')
  await expect(stage).toHaveAttribute('data-foam-mode', 'history')
  expect(await numericAttribute(stage, 'data-physics-step-hz')).toBe(120)
  expect(await numericAttribute(stage, 'data-closed-wall-leak-texels')).toBe(0)
  expect(await numericAttribute(stage, 'data-snapshot-hz')).toBeGreaterThanOrEqual(20)
  expect(await numericAttribute(stage, 'data-snapshot-hz')).toBeLessThanOrEqual(30)

  for (const attribute of [
    'data-injected-volume',
    'data-outlet-volume',
    'data-stored-volume',
    'data-mass-absolute-error',
    'data-mass-relative-error',
    'data-max-velocity',
  ]) {
    expect(Number.isFinite(await numericAttribute(stage, attribute))).toBe(true)
  }
  await expect
    .poll(() => numericAttribute(stage, 'data-elapsed-ms'), { timeout: 15_000 })
    .toBeGreaterThan(0)
  await expect
    .poll(() => numericAttribute(stage, 'data-injected-volume'), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  await expect
    .poll(() => numericAttribute(stage, 'data-active-flow-edges'), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  expect(await numericAttribute(stage, 'data-mass-relative-error')).toBeLessThan(1e-5)

  await canvas.evaluate((element) => {
    element.dataset.e2eCanvasIdentity = 'original'
  })
  await page.getByLabel('수면 표현').selectOption('dynamic')
  await expect(stage).toHaveAttribute('data-water-surface-style', 'dynamic')
  await expect(canvas).toHaveAttribute('data-e2e-canvas-identity', 'original')

  await page.getByLabel('물 흐름 속도').selectOption('4')
  await expect(stage).toHaveAttribute('data-reached-exit', 'true', {
    timeout: 40_000,
  })
  await expect(stage).toHaveAttribute('data-outlet-visible', 'true')
  expect(await numericAttribute(stage, 'data-outlet-volume')).toBeGreaterThan(0)
  expect(await numericAttribute(stage, 'data-outlet-discharge')).toBeGreaterThan(0)

  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  const pausedTime = await numericAttribute(stage, 'data-elapsed-ms')
  const firstPausedFrame = await stage.screenshot({ animations: 'disabled' })
  await page.waitForTimeout(320)
  const secondPausedFrame = await stage.screenshot({ animations: 'disabled' })
  expect(await numericAttribute(stage, 'data-elapsed-ms')).toBe(pausedTime)
  expect(secondPausedFrame.equals(firstPausedFrame)).toBe(true)

  await page.getByLabel('물 흐름 속도').selectOption('0.1')
  await page.getByRole('button', { name: '처음부터', exact: true }).click()
  const resetState = await stage.evaluate((element) => ({
    simulationTime: Number(element.getAttribute('data-elapsed-ms')),
    injected: Number(element.getAttribute('data-injected-volume')),
    outlet: Number(element.getAttribute('data-outlet-volume')),
    stored: Number(element.getAttribute('data-stored-volume')),
  }))
  expect(resetState).toEqual({
    simulationTime: 0,
    injected: 0,
    outlet: 0,
    stored: 0,
  })
  await page.getByLabel('물 흐름 속도').selectOption('4')
  await expect
    .poll(() => numericAttribute(stage, 'data-elapsed-ms'), { timeout: 15_000 })
    .toBeGreaterThan(0)

  expect(await numericAttribute(stage, 'data-draw-calls')).toBeLessThan(80)
  expect(await numericAttribute(stage, 'data-triangles')).toBeLessThan(500_000)
  expect(await numericAttribute(stage, 'data-filled-cells')).toBeLessThanOrEqual(
    await numericAttribute(stage, 'data-active-cells'),
  )
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
  expect(externalRequests).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('low/high 품질은 같은 물리를 사용하고 low는 절차적 포말을 쓴다', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const sample = async (quality: 'low' | 'high') => {
    const stage = await openWater(page, comparisonProject, quality)
    await page.getByLabel('물 흐름 속도').selectOption('2')
    await page.getByRole('button', { name: '처음부터', exact: true }).click()
    await expect
      .poll(() => numericAttribute(stage, 'data-elapsed-ms'), {
        timeout: 20_000,
      })
      .toBeGreaterThan(10_500)
    // Approach the comparison instant slowly so both render modes pause on
    // neighboring 25 Hz physics snapshots even if a high-quality frame stalls.
    await page.getByLabel('물 흐름 속도').selectOption('0.1')
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 25_000
        const pauseAtTarget = () => {
          const stageElement = document.querySelector<HTMLElement>(
            '[data-testid="water-simulation-stage"]',
          )
          const simulationTime = Number(
            stageElement?.getAttribute('data-elapsed-ms'),
          )
          const reachedExit =
            stageElement?.getAttribute('data-reached-exit') === 'true'
          if (simulationTime > 12_000 && reachedExit) {
            document
              .querySelector<HTMLButtonElement>(
                '[aria-label="물 시뮬레이션 일시정지"]',
              )
              ?.click()
            requestAnimationFrame(() => resolve())
            return
          }
          if (performance.now() > deadline) {
            reject(new Error('Water simulation did not reach the comparison time.'))
            return
          }
          requestAnimationFrame(pauseAtTarget)
        }
        pauseAtTarget()
      })
    })
    await expect(stage).toHaveAttribute('data-phase', 'paused')
    const result = await stage.evaluate((element) => ({
      simulationTime: Number(element.getAttribute('data-elapsed-ms')),
      injected: Number(element.getAttribute('data-injected-volume')),
      outlet: Number(element.getAttribute('data-outlet-volume')),
      stored: Number(element.getAttribute('data-stored-volume')),
      maxVelocity: Number(element.getAttribute('data-max-velocity')),
      activeFlowEdges: Number(
        element.getAttribute('data-active-flow-edges'),
      ),
      physicsStepHz: Number(element.getAttribute('data-physics-step-hz')),
      foam: element.getAttribute('data-foam-mode'),
    }))
    await page.getByRole('button', { name: '3D 물 시뮬레이션 닫기' }).click()
    return result
  }

  const low = await sample('low')
  const high = await sample('high')
  expect(low.foam).toBe('procedural')
  expect(high.foam).toBe('history')
  expect(low.injected).toBeGreaterThan(0)
  expect(high.injected).toBeGreaterThan(0)
  expect(low.outlet).toBeGreaterThan(0)
  expect(high.outlet).toBeGreaterThan(0)
  expect(low.activeFlowEdges).toBeGreaterThan(0)
  expect(high.activeFlowEdges).toBeGreaterThan(0)
  expect(low.physicsStepHz).toBe(120)
  expect(high.physicsStepHz).toBe(120)
  expect(low.simulationTime).toBeGreaterThan(12_000)
  expect(high.simulationTime).toBeGreaterThan(12_000)
  // Compare both visual modes after actual outlet breakthrough. High-quality
  // GPU work can make the observed snapshot cross the target later, so compare
  // steady hydraulic invariants and time-normalized throughput rather than
  // cumulative volumes at unequal timestamps.
  const expectedRampVolume = (sample: typeof low) => {
    const seconds = sample.simulationTime / 1_000
    return seconds <= 0.75
      ? (0.5 * 0.018 * seconds * seconds) / 0.75
      : 0.018 * (seconds - 0.375)
  }
  for (const sample of [low, high]) {
    expect(Math.abs(sample.injected - expectedRampVolume(sample))).toBeLessThan(
      0.0003,
    )
    expect(
      Math.abs(sample.stored - (sample.injected - sample.outlet)),
    ).toBeLessThan(1e-8)
  }
  expect(Math.abs(low.stored - high.stored)).toBeLessThan(1e-7)
  expect(Math.abs(low.maxVelocity - high.maxVelocity)).toBeLessThan(0.2)
  expect(low.activeFlowEdges).toBe(high.activeFlowEdges)
  const averageOutletRate = (sample: typeof low) =>
    sample.outlet / Math.max(1e-6, sample.simulationTime / 1_000 - 0.375)
  expect(
    Math.abs(averageOutletRate(low) - averageOutletRate(high)),
  ).toBeLessThan(0.0003)
})

test('반복 열기와 닫기가 canvas/Worker 수명을 정리한다', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    const state = {
      activeWorkers: 0,
      createdWorkers: 0,
      terminatedWorkers: 0,
      lostWebglContexts: 0,
    }
    type LoseContextExtension = { loseContext: () => void }
    type ExtensionContext = {
      getExtension: (name: string) => unknown
    }
    const wrappedExtensions = new WeakSet<object>()
    const contextPrototypes: ExtensionContext[] = [
      window.WebGLRenderingContext.prototype as unknown as ExtensionContext,
      window.WebGL2RenderingContext.prototype as unknown as ExtensionContext,
    ]
    for (const prototype of contextPrototypes) {
      const nativeGetExtension = prototype.getExtension
      prototype.getExtension = function getTrackedExtension(name: string) {
        const extension = nativeGetExtension.call(this, name)
        if (
          name === 'WEBGL_lose_context' &&
          extension !== null &&
          typeof extension === 'object' &&
          'loseContext' in extension &&
          typeof (extension as LoseContextExtension).loseContext === 'function' &&
          !wrappedExtensions.has(extension)
        ) {
          wrappedExtensions.add(extension)
          const nativeLoseContext = (
            extension as LoseContextExtension
          ).loseContext.bind(extension)
          Object.defineProperty(extension, 'loseContext', {
            configurable: true,
            value: () => {
              state.lostWebglContexts += 1
              nativeLoseContext()
            },
          })
        }
        return extension
      }
    }
    const TrackingWorker = new Proxy(NativeWorker, {
      construct(target, argumentsList) {
        const worker = Reflect.construct(target, argumentsList) as Worker
        const nativeTerminate = worker.terminate.bind(worker)
        let active = true
        state.activeWorkers += 1
        state.createdWorkers += 1
        worker.terminate = () => {
          if (active) {
            active = false
            state.activeWorkers -= 1
            state.terminatedWorkers += 1
          }
          nativeTerminate()
        }
        return worker
      },
    })
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: TrackingWorker,
    })
    Object.defineProperty(window, '__waterE2ELifecycle', {
      configurable: true,
      get: () => ({ ...state }),
    })
  })
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".mazecraft"]').setInputFiles({
    name: 'repeat-water.mazecraft',
    mimeType: 'application/vnd.mazecraft+json',
    buffer: Buffer.from(JSON.stringify(fixtureProject)),
  })
  await page.locator('.mobile-tabs button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('low')
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await expect(page.locator('#maze-settings-panel')).toHaveAttribute(
    'aria-hidden',
    'true',
  )

  for (let index = 0; index < 3; index += 1) {
    const before = await page.evaluate(
      () =>
        (window as Window & {
          __waterE2ELifecycle: {
            activeWorkers: number
            createdWorkers: number
            terminatedWorkers: number
            lostWebglContexts: number
          }
        }).__waterE2ELifecycle,
    )
    await page.getByRole('button', { name: '3D 물 시뮬레이션 열기' }).click()
    const stage = page.getByTestId('water-simulation-stage')
    await expect(stage).toHaveAttribute('data-renderer', 'ready', {
      timeout: 20_000,
    })
    await expect(stage.locator('canvas.water-simulation-canvas')).toHaveCount(1)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & {
              __waterE2ELifecycle: { createdWorkers: number }
            }).__waterE2ELifecycle.createdWorkers,
        ),
      )
      .toBeGreaterThan(before.createdWorkers)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    await page.getByRole('button', { name: '3D 물 시뮬레이션 닫기' }).click()
    await expect(stage).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & {
              __waterE2ELifecycle: {
                activeWorkers: number
                terminatedWorkers: number
              }
            }).__waterE2ELifecycle,
        ),
      )
      .toMatchObject({
        activeWorkers: before.activeWorkers,
        terminatedWorkers: before.terminatedWorkers + 1,
      })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & {
              __waterE2ELifecycle: { lostWebglContexts: number }
            }).__waterE2ELifecycle.lostWebglContexts,
        ),
      )
      .toBeGreaterThan(before.lostWebglContexts)
  }
})
