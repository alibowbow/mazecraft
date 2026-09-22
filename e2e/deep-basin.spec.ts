import { expect, test, type Page } from '@playwright/test'

const cascadeSelector = '[data-testid="water-studio-canvas"] canvas.water-simulation-canvas'

// One browser request reads the entire snapshot. Locator.evaluate first resolves
// an ElementHandle through several extra protocol turns, each of which can wait
// behind another expensive frame on the CI software renderer.
const readCascade = (page: Page) => page.evaluate(selector => {
  const element = document.querySelector<HTMLCanvasElement>(selector)
  if (!element) throw new Error('The fountain canvas is missing')
  const data = element.dataset
  return {
    time: Number(data.basinTime), initial: Number(data.basinInitialVolume),
    stored: Number(data.basinStoredVolume), injected: Number(data.basinInjectedVolume),
    discharged: Number(data.basinOutletVolume), inletRate: Number(data.basinInletRate),
    outletRate: Number(data.basinOutletRate), wetCells: Number(data.basinWetCells),
    depths: JSON.parse(data.terraceDepths ?? '[]') as number[],
    spillRates: JSON.parse(data.terraceOutletRates ?? '[]') as number[],
  }
}, cascadeSelector)

async function openFountain(page: Page) {
  await page.goto('/')
  const stage = page.getByTestId('water-studio-canvas')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 60_000 })
  const scene = await page.evaluate(selector => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)
    if (!canvas) throw new Error('The fountain canvas is missing')
    const bounds = canvas.getBoundingClientRect()
    return {
      model: canvas.dataset.waterModel, sculpture: canvas.dataset.sculpture,
      terraces: canvas.dataset.terraceCount,
      clip: { x: bounds.x + scrollX, y: bounds.y + scrollY, width: bounds.width, height: bounds.height },
    }
  }, cascadeSelector)
  expect(scene.model).toBe('hydraulic-basin')
  expect(scene.sculpture).toBe('terraced-fountain')
  expect(scene.terraces).toBe('3')
  return { canvas: page.locator(cascadeSelector), clip: scene.clip }
}

async function pauseFountain(page: Page) {
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  // The canvas area is overlaid by transport controls. Put the pointer outside
  // that area so a button's transient hover cannot masquerade as water motion.
  await page.mouse.move(0, 0)
}

test('three porcelain terraces visibly cascade, conserve water and freeze completely when paused', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const { clip } = await openFountain(page)
  const capture = (file?: string) => page.screenshot({ clip, path: file ? testInfo.outputPath(file) : undefined })
  // Software WebGL can occupy the main thread while compiling transmission;
  // allow that first state read to finish before evaluating the same thresholds.
  const flowState = () => readCascade(page)
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(0.5)
  await pauseFountain(page)
  const flowingBefore = await flowState()
  expect(flowingBefore.wetCells).toBeGreaterThan(80)
  expect(flowingBefore.depths).toHaveLength(3)
  expect(flowingBefore.spillRates).toHaveLength(3)
  for (const depth of flowingBefore.depths) expect(depth, 'each physical terrace contains water').toBeGreaterThan(0)
  for (const rate of flowingBefore.spillRates) expect(rate, 'all three cascade outlets carry actual water').toBeGreaterThan(0)
  expect(flowingBefore.inletRate, 'the visible default inlet supplies real water').toBeGreaterThan(0)
  expect(flowingBefore.outletRate, 'the visible default outlet discharges real water').toBeGreaterThan(0)
  // Capture stable frames from the actual running simulation. Pausing only for
  // readback avoids issuing screenshot protocol work between every GPU frame.
  const flowImage = await capture('deep-basin-flow-01.png')
  const firstFrameTime = flowingBefore.time
  await page.getByRole('button', { name: '재생', exact: true }).click()
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(firstFrameTime + 0.6)
  await pauseFountain(page)
  const flowingAfter = await flowState()
  expect(flowingAfter.injected).toBeGreaterThan(flowingBefore.injected)
  expect(flowingAfter.discharged).toBeGreaterThan(flowingBefore.discharged)
  const laterFlowImage = await capture('deep-basin-flow-02.png')
  expect(laterFlowImage.equals(flowImage), 'real flow changes the rendered water, not just its clock').toBe(false)
  const secondFrameTime = flowingAfter.time
  await page.getByRole('button', { name: '재생', exact: true }).click()
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(secondFrameTime + 0.6)
  await pauseFountain(page)
  const thirdFlowImage = await capture('deep-basin-flow-03.png')
  expect(thirdFlowImage.equals(laterFlowImage), 'the cascade keeps moving across successive frames').toBe(false)
  const pausedVolume = await flowState()
  const { time, stored } = pausedVolume
  expect(pausedVolume.initial, 'the shaped terraces begin visibly filled').toBeGreaterThan(10)
  expect(stored, 'the flowing basins retain their initial water body').toBeGreaterThan(pausedVolume.initial * 0.9)
  expect(stored + pausedVolume.discharged - pausedVolume.injected, 'actual shaped-basin volume is conserved').toBeCloseTo(pausedVolume.initial, 5)
  const pausedImage = await capture()
  await page.waitForTimeout(350)
  expect((await flowState()).time).toBe(time)
  expect((await capture()).equals(pausedImage), 'pause freezes surface and flowing fixtures exactly').toBe(true)
  await testInfo.attach('default-basin-flow-measurements', {
    body: JSON.stringify({ flowingBefore, flowingAfter, firstFrameTime, secondFrameTime, pausedTime: Number(time) }, null, 2),
    contentType: 'application/json',
  })
  await page.screenshot({ path: testInfo.outputPath('deep-basin-desktop.png') })
  expect(errors).toEqual([])
})

test('fountain walls, drainage and view changes preserve the real cascade', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const { canvas } = await openFountain(page)
  const flowState = () => readCascade(page)
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(0.5)
  await pauseFountain(page)
  const { time, stored } = await flowState()
  await page.getByRole('tab', { name: '색상', exact: true }).click()
  const height = page.getByRole('slider', { name: '벽 높이', exact: true })
  await height.focus(); await height.press('End')
  await expect(height).toHaveValue('1.75')
  expect((await flowState()).time).toBe(time)
  await page.screenshot({ path: testInfo.outputPath('deep-basin-high-walls.png') })
  await height.press('Home')
  await page.getByRole('button', { name: '물 붓기 켜짐', exact: true }).click()
  await page.getByRole('button', { name: '재생', exact: true }).click()
  await expect.poll(async () => (await flowState()).stored, { timeout: 30_000 }).toBeLessThan(stored - 0.01)
  await pauseFountain(page)
  const pausedCascade = await flowState()
  await page.getByRole('button', { name: '2D', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-water-model', 'position-based-free-surface')
  await page.getByRole('button', { name: '3D', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-water-model', 'hydraulic-basin')
  await expect(canvas).toHaveAttribute('data-sculpture', 'terraced-fountain')
  await expect.poll(flowState, { timeout: 30_000 }).toEqual(pausedCascade)
  expect(errors).toEqual([])
})

test('15.7 all three fountain terraces stay visible on a compact screen', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await openFountain(page)
  await expect.poll(async () => (await readCascade(page)).time, { timeout: 30_000 }).toBeGreaterThan(0.3)
  await pauseFountain(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('deep-basin-mobile.png') })
  await page.getByRole('button', { name: '튜닝 열기', exact: true }).click()
  await expect(page.getByRole('tab', { name: '물', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: testInfo.outputPath('deep-basin-mobile-controls.png') })
})

test('fountain water tint and ceramic glaze visibly change without resetting the paused cascade', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const { clip } = await openFountain(page)
  const capture = (file?: string) => page.screenshot({ clip, path: file ? testInfo.outputPath(file) : undefined })
  await expect.poll(async () => (await readCascade(page)).time, { timeout: 30_000 }).toBeGreaterThan(0.3)
  await pauseFountain(page)
  const state = await readCascade(page)
  const original = await capture('fountain-material-porcelain-aqua.png')

  await page.getByRole('tab', { name: '색상', exact: true }).click()
  await page.getByRole('button', { name: '물 색상 분홍', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect(page.getByRole('button', { name: '물 색상 분홍', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await capture()).equals(original), { timeout: 30_000 }).toBe(false)
  await capture('fountain-material-porcelain-pink.png')
  expect(await readCascade(page)).toEqual(state)

  await page.getByRole('button', { name: '물 색상 청록', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect.poll(async () => (await capture()).equals(original), { timeout: 30_000 }).toBe(true)
  await page.getByRole('tab', { name: '색상', exact: true }).click()
  await page.getByRole('button', { name: '스카이', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect(page.getByTestId('water-studio')).toHaveAttribute('data-theme-name', 'glacier')
  await expect.poll(async () => (await capture()).equals(original), { timeout: 30_000 }).toBe(false)
  await capture('fountain-material-glacier-aqua.png')
  expect(await readCascade(page)).toEqual(state)

  await page.getByRole('button', { name: '포슬린', exact: true }).click()
  await page.mouse.move(0, 0)
  await expect.poll(async () => (await capture()).equals(original), { timeout: 30_000 }).toBe(true)
  expect(await readCascade(page)).toEqual(state)
  expect(errors).toEqual([])
})
