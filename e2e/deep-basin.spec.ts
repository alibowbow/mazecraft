import { expect, test, type Locator, type Page } from '@playwright/test'

const readCascade = (canvas: Locator) => canvas.evaluate(element => ({
  time: Number(element.getAttribute('data-basin-time')),
  initial: Number(element.getAttribute('data-basin-initial-volume')),
  stored: Number(element.getAttribute('data-basin-stored-volume')),
  injected: Number(element.getAttribute('data-basin-injected-volume')),
  discharged: Number(element.getAttribute('data-basin-outlet-volume')),
  inletRate: Number(element.getAttribute('data-basin-inlet-rate')),
  outletRate: Number(element.getAttribute('data-basin-outlet-rate')),
  depths: JSON.parse(element.getAttribute('data-terrace-depths') ?? '[]') as number[],
  spillRates: JSON.parse(element.getAttribute('data-terrace-outlet-rates') ?? '[]') as number[],
}))

async function openFountain(page: Page): Promise<Locator> {
  await page.goto('/')
  const stage = page.getByTestId('water-studio-canvas')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 60_000 })
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(canvas).toHaveAttribute('data-water-model', 'hydraulic-basin')
  await expect(canvas).toHaveAttribute('data-sculpture', 'terraced-fountain')
  await expect(canvas).toHaveAttribute('data-terrace-count', '3')
  return canvas
}

test('three porcelain terraces visibly cascade, conserve water and freeze completely when paused', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const canvas = await openFountain(page)
  // Software WebGL can occupy the main thread while compiling transmission;
  // allow that first state read to finish before evaluating the same thresholds.
  await expect.poll(async () => Number(await canvas.getAttribute('data-basin-wet-cells')), { timeout: 30_000 }).toBeGreaterThan(80)
  await expect.poll(async () => Number(await canvas.getAttribute('data-basin-time')), { timeout: 30_000 }).toBeGreaterThan(0.5)
  const flowState = () => readCascade(canvas)
  const flowingBefore = await flowState()
  expect(flowingBefore.depths).toHaveLength(3)
  expect(flowingBefore.spillRates).toHaveLength(3)
  for (const depth of flowingBefore.depths) expect(depth, 'each physical terrace contains water').toBeGreaterThan(0)
  for (const rate of flowingBefore.spillRates) expect(rate, 'all three cascade outlets carry actual water').toBeGreaterThan(0)
  expect(flowingBefore.inletRate, 'the visible default inlet supplies real water').toBeGreaterThan(0)
  expect(flowingBefore.outletRate, 'the visible default outlet discharges real water').toBeGreaterThan(0)
  const flowImage = await canvas.screenshot({ path: testInfo.outputPath('deep-basin-flow-01.png') })
  const firstFrameTime = (await flowState()).time
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(firstFrameTime + 0.6)
  const flowingAfter = await flowState()
  expect(flowingAfter.injected).toBeGreaterThan(flowingBefore.injected)
  expect(flowingAfter.discharged).toBeGreaterThan(flowingBefore.discharged)
  const laterFlowImage = await canvas.screenshot({ path: testInfo.outputPath('deep-basin-flow-02.png') })
  expect(laterFlowImage.equals(flowImage), 'real flow changes the rendered water, not just its clock').toBe(false)
  const secondFrameTime = (await flowState()).time
  await expect.poll(async () => (await flowState()).time, { timeout: 30_000 }).toBeGreaterThan(secondFrameTime + 0.6)
  const thirdFlowImage = await canvas.screenshot({ path: testInfo.outputPath('deep-basin-flow-03.png') })
  expect(thirdFlowImage.equals(laterFlowImage), 'the cascade keeps moving across successive frames').toBe(false)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  const time = await canvas.getAttribute('data-basin-time')
  const stored = Number(await canvas.getAttribute('data-basin-stored-volume'))
  const pausedVolume = await flowState()
  expect(pausedVolume.initial, 'the shaped terraces begin visibly filled').toBeGreaterThan(10)
  expect(stored, 'the flowing basins retain their initial water body').toBeGreaterThan(pausedVolume.initial * 0.9)
  expect(stored + pausedVolume.discharged - pausedVolume.injected, 'actual shaped-basin volume is conserved').toBeCloseTo(pausedVolume.initial, 5)
  const pausedImage = await canvas.screenshot()
  await page.waitForTimeout(350)
  expect(await canvas.getAttribute('data-basin-time')).toBe(time)
  expect((await canvas.screenshot()).equals(pausedImage), 'pause freezes surface and flowing fixtures exactly').toBe(true)
  await testInfo.attach('default-basin-flow-measurements', {
    body: JSON.stringify({ flowingBefore, flowingAfter, firstFrameTime, secondFrameTime, pausedTime: Number(time) }, null, 2),
    contentType: 'application/json',
  })
  await page.screenshot({ path: testInfo.outputPath('deep-basin-desktop.png') })
  await page.getByRole('tab', { name: '재질', exact: true }).click()
  const height = page.getByRole('slider', { name: '벽 높이', exact: true })
  await height.focus(); await height.press('End')
  await expect(height).toHaveValue('1.75')
  expect(await canvas.getAttribute('data-basin-time')).toBe(time)
  await page.screenshot({ path: testInfo.outputPath('deep-basin-high-walls.png') })
  await height.press('Home')
  await page.getByRole('button', { name: '물 붓기 켜짐', exact: true }).click()
  await page.getByRole('button', { name: '재생', exact: true }).click()
  await expect.poll(async () => Number(await canvas.getAttribute('data-basin-stored-volume')), { timeout: 30_000 }).toBeLessThan(stored - 0.01)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
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
  const canvas = await openFountain(page)
  await expect.poll(async () => Number(await canvas.getAttribute('data-basin-time')), { timeout: 30_000 }).toBeGreaterThan(0.3)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
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
  const canvas = await openFountain(page)
  await expect.poll(async () => (await readCascade(canvas)).time, { timeout: 30_000 }).toBeGreaterThan(0.3)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  const state = await readCascade(canvas)
  const original = await canvas.screenshot({ path: testInfo.outputPath('fountain-material-porcelain-aqua.png') })

  await page.getByRole('button', { name: '물 색상 분홍', exact: true }).click()
  await expect(page.getByRole('button', { name: '물 색상 분홍', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await canvas.screenshot()).equals(original), { timeout: 30_000 }).toBe(false)
  await canvas.screenshot({ path: testInfo.outputPath('fountain-material-porcelain-pink.png') })
  expect(await readCascade(canvas)).toEqual(state)

  await page.getByRole('button', { name: '물 색상 청록', exact: true }).click()
  await expect.poll(async () => (await canvas.screenshot()).equals(original), { timeout: 30_000 }).toBe(true)
  await page.getByRole('tab', { name: '재질', exact: true }).click()
  await page.getByRole('button', { name: '글레이셔', exact: true }).click()
  await expect(page.getByTestId('water-studio')).toHaveAttribute('data-theme-name', 'glacier')
  await expect.poll(async () => (await canvas.screenshot()).equals(original), { timeout: 30_000 }).toBe(false)
  await canvas.screenshot({ path: testInfo.outputPath('fountain-material-glacier-aqua.png') })
  expect(await readCascade(canvas)).toEqual(state)

  await page.getByRole('button', { name: '포슬린', exact: true }).click()
  await expect.poll(async () => (await canvas.screenshot()).equals(original), { timeout: 30_000 }).toBe(true)
  expect(await readCascade(canvas)).toEqual(state)
  expect(errors).toEqual([])
})
