import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDefaultProject, type MazeProject } from '../src/core/maze'

const maze = createDefaultProject({
  title: '자유수면 분기 검증 미로',
  seed: 'free-surface-water-e2e',
  grid: { rows: 6, cols: 6, minimumCellPixels: 8 },
})

const verticalChannel = createDefaultProject({
  title: '중력 낙하와 출구 검증 수로',
  seed: 'free-surface-water-outlet-e2e',
  grid: { rows: 4, cols: 1, minimumCellPixels: 8 },
})

async function importProject(page: Page, project: MazeProject, mobile = false) {
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".mazecraft"]').setInputFiles({
    name: 'free-surface-water.mazecraft',
    mimeType: 'application/vnd.mazecraft+json',
    buffer: Buffer.from(JSON.stringify(project)),
  })
  const tabs = mobile ? '.mobile-tabs button' : '.studio-stage-rail button'
  await page.locator(tabs).filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('low')
  if (mobile) await page.getByRole('button', { name: '설정 닫기' }).click()
}

async function openDefaultWater(page: Page) {
  await page.getByRole('button', { name: '물 시뮬레이션 열기' }).click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(page.getByRole('button', { name: '2D 물 흐름', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '3D 수면', exact: true })).toBeVisible()
  await expect(stage).toHaveAttribute('data-fluid-model', 'position-based-free-surface')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 20_000 })
  await expect(stage).toHaveAttribute('data-solver-mode', 'worker')
  await expect(stage.locator('canvas.water-simulation-canvas')).toBeVisible()
  return stage
}

const numberAttribute = async (stage: Locator, name: string) =>
  Number(await stage.getAttribute(name))

async function pause(page: Page, stage: Locator) {
  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  await expect(stage).toHaveAttribute('data-phase', 'paused')
}

test('자유수면 입자가 실제로 흐르고 공급 중지·일시정지·재시작이 구분된다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await importProject(page, maze)
  const stage = await openDefaultWater(page)
  await expect(stage).toHaveAttribute('data-inflow', 'enabled')
  await expect.poll(() => numberAttribute(stage, 'data-particle-count')).toBeGreaterThan(0)
  await expect.poll(() => numberAttribute(stage, 'data-filled-cells'), {
    timeout: 15_000,
  }).toBeGreaterThan(1)
  await page.screenshot({ path: testInfo.outputPath('free-surface-flow.png') })
  await page.getByLabel('물 흐름 속도').selectOption('4')
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms'), {
    timeout: 20_000,
  }).toBeGreaterThan(12_000)
  await page.getByLabel('물 흐름 속도').selectOption('1')
  await page.screenshot({ path: testInfo.outputPath('free-surface-pooled.png') })

  await pause(page, stage)
  const pausedTime = await numberAttribute(stage, 'data-elapsed-ms')
  const firstFrame = await stage.screenshot({ animations: 'disabled' })
  await page.waitForTimeout(320)
  const secondFrame = await stage.screenshot({ animations: 'disabled' })
  expect(secondFrame.equals(firstFrame)).toBe(true)
  expect(await numberAttribute(stage, 'data-elapsed-ms')).toBe(pausedTime)

  await page.getByRole('button', { name: '물 시뮬레이션 재생' }).click()
  await page.getByRole('button', { name: '물 공급 멈추기' }).click()
  await expect(stage).toHaveAttribute('data-inflow', 'disabled')
  await expect(page.getByRole('button', { name: '물 시뮬레이션 일시정지' })).toBeVisible()
  // Let any worker request already in flight finish before measuring the
  // stopped supply. Existing water must keep moving without fresh injection.
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(pausedTime + 250)
  const stoppedInjected = await numberAttribute(stage, 'data-injected-volume')
  const runningTime = await numberAttribute(stage, 'data-elapsed-ms')
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(runningTime + 400)
  expect(await numberAttribute(stage, 'data-injected-volume')).toBe(stoppedInjected)
  await expect(page.getByRole('button', { name: '물 시뮬레이션 일시정지' })).toBeVisible()

  await pause(page, stage)
  await page.getByLabel('물 흐름 속도').selectOption('0.1')
  // Arm observation before clicking: reset is acknowledged asynchronously by
  // the worker. Capture its exact zero snapshot without racing the next frame.
  const resetPromise = stage.evaluate(element => new Promise<{
    elapsed: number; injected: number; discharged: number; escaped: number; particles: number
  }>((resolve, reject) => {
    const deadline = setTimeout(() => {
      observer.disconnect()
      reject(new Error('Worker did not publish the zero reset snapshot'))
    }, 5_000)
    const observer = new MutationObserver(() => {
      const state = {
        elapsed: Number(element.getAttribute('data-elapsed-ms')),
        injected: Number(element.getAttribute('data-injected-volume')),
        discharged: Number(element.getAttribute('data-outlet-volume')),
        escaped: Number(element.getAttribute('data-escaped-volume')),
        particles: Number(element.getAttribute('data-particle-count')),
      }
      if (Object.values(state).every(value => value === 0)) {
        clearTimeout(deadline)
        observer.disconnect()
        resolve(state)
      }
    })
    observer.observe(element, { attributes: true })
  }))
  await page.getByRole('button', { name: '물 시뮬레이션 처음부터', exact: true }).click()
  await expect(stage).toHaveAttribute('data-inflow', 'enabled')
  const reset = await resetPromise
  expect(reset).toEqual({ elapsed: 0, injected: 0, discharged: 0, escaped: 0, particles: 0 })
  await page.getByLabel('물 흐름 속도').selectOption('1')
  await expect.poll(() => numberAttribute(stage, 'data-particle-count')).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('수직 수로에서 물이 출구로 떨어지고 입자 질량이 보존된다', async ({ page }) => {
  test.setTimeout(45_000)
  await importProject(page, verticalChannel)
  const stage = await openDefaultWater(page)
  await expect(stage).toHaveAttribute('data-start-edge', 'top')
  await expect(stage).toHaveAttribute('data-end-edge', 'bottom')
  await expect(stage).toHaveAttribute('data-reached-exit', 'true', { timeout: 20_000 })
  await expect.poll(() => numberAttribute(stage, 'data-outlet-volume'), {
    timeout: 10_000,
  }).toBeGreaterThan(0)
  await pause(page, stage)
  const state = await stage.evaluate(element => ({
    injected: Number(element.getAttribute('data-injected-volume')),
    discharged: Number(element.getAttribute('data-outlet-volume')),
    escaped: Number(element.getAttribute('data-escaped-volume')),
    stored: Number(element.getAttribute('data-stored-volume')),
    error: Number(element.getAttribute('data-mass-absolute-error')),
    relativeError: Number(element.getAttribute('data-mass-relative-error')),
  }))
  Object.values(state).forEach(value => expect(Number.isFinite(value)).toBe(true))
  expect(state.injected).toBeGreaterThan(0)
  expect(state.discharged).toBeGreaterThan(0)
  expect(state.escaped).toBeGreaterThanOrEqual(0)
  expect(Math.abs(state.injected - state.discharged - state.escaped - state.stored)).toBeLessThan(1e-5)
  expect(state.error).toBeLessThan(1e-5)
  expect(state.relativeError).toBeLessThan(1e-5)
  // An occupied emitter lane can legitimately throttle active supply. Its
  // backpressure indicator must clear once the inlet is switched off.
  const pausedTime = await numberAttribute(stage, 'data-elapsed-ms')
  await page.getByRole('button', { name: '물 공급 멈추기' }).click()
  await page.getByRole('button', { name: '물 시뮬레이션 재생' }).click()
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(pausedTime + 150)
  await expect(stage).toHaveAttribute('data-saturated', 'false')
})

test('15. 좁은 모바일 자유수면 화면이 잘리지 않고 반복 열기에서 Worker를 회수한다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.addInitScript(() => {
    const state = { active: 0, created: 0, terminated: 0 }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker
        state.active++
        state.created++
        let active = true
        const terminate = worker.terminate.bind(worker)
        worker.terminate = () => {
          if (active) {
            state.active--
            state.terminated++
            active = false
          }
          terminate()
        }
        return worker
      },
    })
    Object.defineProperty(window, '__freeSurfaceWorkers', { get: () => ({ ...state }) })
  })
  const workers = () => page.evaluate(() => (window as Window & {
    __freeSurfaceWorkers: { active: number; created: number; terminated: number }
  }).__freeSurfaceWorkers)
  await importProject(page, verticalChannel, true)
  const before = await workers()
  for (let repeat = 0; repeat < 2; repeat++) {
    const stage = await openDefaultWater(page)
    await expect.poll(() => numberAttribute(stage, 'data-particle-count')).toBeGreaterThan(0)
    expect((await workers()).active).toBe(before.active + 1)
    await expect(stage.locator('canvas.water-simulation-canvas')).toHaveCount(1)
    // The backdrop can clip an oversized dialog without increasing the root
    // scroll width, so measure the actual fixed-position modal rectangle too.
    const dialog = await page.getByRole('dialog').boundingBox()
    expect(dialog).not.toBeNull()
    const viewport = page.viewportSize()!
    expect(dialog!.x).toBeGreaterThanOrEqual(0)
    expect(dialog!.y).toBeGreaterThanOrEqual(0)
    expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(viewport.width)
    expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(viewport.height)
    const layout = await page.locator('.water-simulation-controls').evaluate(element => {
      const controls = [...element.querySelectorAll('button, select')]
      return {
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        smallTargets: controls.filter(control => {
          const box = control.getBoundingClientRect()
          return box.width < 44 || box.height < 44
        }).length,
        controlsOutsideViewport: controls.filter(control => {
          const box = control.getBoundingClientRect()
          return box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight
        }).length,
      }
    })
    expect(layout).toEqual({ pageOverflows: false, smallTargets: 0, controlsOutsideViewport: 0 })
    if (repeat === 0) {
      await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(2_000)
      await page.screenshot({ path: testInfo.outputPath('free-surface-mobile.png') })
    }
    await page.getByRole('button', { name: '물 시뮬레이션 닫기' }).click()
    await expect(stage).toHaveCount(0)
    await expect.poll(workers).toEqual({
      active: before.active,
      created: before.created + repeat + 1,
      terminated: before.terminated + repeat + 1,
    })
  }
})
