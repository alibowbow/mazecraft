import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createDefaultProject } from '../src/core/maze'
import { WATER_INLET_IMPACT_MS } from '../src/features/waterSimulation/waterInletVisual'

test('연속 수면 렌더러가 시네마틱 장면을 움직이며 그린다', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const project = createDefaultProject({
    title: '유체 품질 검증 미로',
    seed: 'fluid-quality-verification',
    grid: { rows: 10, cols: 10, minimumCellPixels: 8 },
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".mazecraft"]').setInputFiles({
    name: 'fluid-quality.mazecraft',
    mimeType: 'application/vnd.mazecraft+json',
    buffer: Buffer.from(JSON.stringify(project)),
  })
  await page.locator('.studio-workflow button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('high')
  await page.getByRole('button', { name: '3D 물 시뮬레이션 열기' }).click()

  const stage = page.getByTestId('water-simulation-stage')
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', {
    timeout: 15_000,
  })
  await expect(stage).toHaveAttribute(
    'data-fluid-renderer',
    'bottom-up-hydraulic-surface',
  )
  await expect(stage).toHaveAttribute(
    'data-fluid-model',
    'mass-conserving-finite-volume',
  )
  await expect(stage).toHaveAttribute(
    'data-flow-mode',
    'continuous-until-user-pauses',
  )
  await expect(stage).toHaveAttribute(
    'data-inlet-renderer',
    'coupled-gravity-jet',
  )
  await expect(stage).toHaveAttribute(
    'data-water-continuity',
    'coupled-source-surface',
  )
  await expect(stage).toHaveAttribute('data-quality', 'high')
  await expect(canvas).toBeVisible()
  const activeCells = Number(await stage.getAttribute('data-active-cells'))
  const wettableCells = Number(
    await stage.getAttribute('data-wettable-cells'),
  )
  expect(activeCells).toBeGreaterThan(0)
  expect(wettableCells).toBeGreaterThan(0)
  expect(wettableCells).toBeLessThanOrEqual(activeCells)
  expect(
    Number(await stage.getAttribute('data-conservation-error')),
  ).toBeLessThan(1e-8)
  await expect
    .poll(async () => Number(await stage.getAttribute('data-draw-calls')))
    .toBeGreaterThan(0)

  const stageBounds = await stage.boundingBox()
  expect(stageBounds).not.toBeNull()
  const cdp = await page.context().newCDPSession(page)
  const captureStage = async () => {
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: {
        x: stageBounds?.x ?? 0,
        y: stageBounds?.y ?? 0,
        width: stageBounds?.width ?? 1,
        height: stageBounds?.height ?? 1,
        scale: 1,
      },
    })
    return Buffer.from(screenshot.data, 'base64')
  }
  const analyzeCyanWater = async (frame: Buffer) =>
    page.evaluate(async (encoded) => {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Captured water frame did not decode.'))
        image.src = `data:image/png;base64,${encoded}`
      })
      const bitmap = document.createElement('canvas')
      bitmap.width = image.naturalWidth
      bitmap.height = image.naturalHeight
      const context = bitmap.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('2D analysis context is unavailable.')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      let cyanPixels = 0
      let minimumY = bitmap.height
      let maximumY = -1
      const left = Math.floor(bitmap.width * 0.3)
      const right = Math.ceil(bitmap.width * 0.7)
      for (let y = 0; y < bitmap.height; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * bitmap.width + x) * 4
          const red = pixels[offset]
          const green = pixels[offset + 1]
          const blue = pixels[offset + 2]
          if (blue > 150 && green > 105 && blue - red > 35 && green - red > 12) {
            cyanPixels += 1
            minimumY = Math.min(minimumY, y)
            maximumY = Math.max(maximumY, y)
          }
        }
      }
      return {
        cyanPixels,
        verticalSpan: maximumY < 0 ? 0 : maximumY - minimumY,
        height: bitmap.height,
      }
    }, frame.toString('base64'))
  await page.getByLabel('물 흐름 속도').selectOption('0.1')
  await page.getByRole('button', { name: '처음부터', exact: true }).click()
  await expect(stage).toHaveAttribute('data-inlet-visible', 'true')
  expect(
    Number(await stage.getAttribute('data-inlet-drop-height')),
  ).toBeGreaterThan(2)
  expect(
    Number(await stage.getAttribute('data-inlet-contact-gap')),
  ).toBeLessThanOrEqual(0.001)

  await expect
    .poll(async () => Number(await stage.getAttribute('data-elapsed-ms')), {
      timeout: 20_000,
    })
    .toBeGreaterThan(WATER_INLET_IMPACT_MS + 160)
  await expect(stage).toHaveAttribute('data-inlet-state', /^(impact|steady)$/)
  await page
    .getByRole('button', { name: '물 시뮬레이션 일시정지' })
    .click()
  const impactFrame = await captureStage()
  await writeFile(
    testInfo.outputPath('water-inlet-impact.png'),
    impactFrame,
  )
  expect(impactFrame.byteLength).toBeGreaterThan(10_000)
  const waterPixels = await analyzeCyanWater(impactFrame)
  expect(waterPixels.cyanPixels).toBeGreaterThan(1_000)
  expect(waterPixels.verticalSpan).toBeGreaterThan(waterPixels.height * 0.3)
  // Passage topology is asserted against the deterministic GPU atlas in
  // waterSurfaceTimeline.test.ts. Shader color segmentation varies by GPU.
  await page.waitForTimeout(320)
  const pausedFrame = await captureStage()
  expect(pausedFrame.equals(impactFrame)).toBe(true)

  const impactedFilledCells = Number(
    await stage.getAttribute('data-filled-cells'),
  )
  await page.getByLabel('물 흐름 속도').selectOption('1')
  await page.getByRole('button', { name: '물 시뮬레이션 재생' }).click()
  await expect
    .poll(async () => Number(await stage.getAttribute('data-filled-cells')))
    .toBeGreaterThan(impactedFilledCells)
  expect(Number(await stage.getAttribute('data-atlas-width'))).toBeGreaterThan(
    0,
  )
  expect(Number(await stage.getAttribute('data-atlas-height'))).toBeGreaterThan(
    0,
  )
  expect(Number(await stage.getAttribute('data-draw-calls'))).toBeLessThan(80)
  expect(Number(await stage.getAttribute('data-triangles'))).toBeLessThan(
    500_000,
  )
  await page.getByLabel('물 흐름 속도').selectOption('4')
  await expect(stage).toHaveAttribute('data-reached-exit', 'true', {
    timeout: 30_000,
  })
  await expect(stage).toHaveAttribute('data-outlet-visible', 'true')
  await expect(stage).toHaveAttribute(
    'data-outlet-renderer',
    'continuous-waterfall-and-catch-basin',
  )
  expect(
    Number(await stage.getAttribute('data-outlet-drop-height')),
  ).toBeGreaterThan(1.4)
  await expect(stage).toHaveAttribute('data-settled', 'true', {
    timeout: 30_000,
  })
  const steadyElapsed = Number(await stage.getAttribute('data-elapsed-ms'))
  await expect
    .poll(
      async () => Number(await stage.getAttribute('data-elapsed-ms')),
      { timeout: 3_000 },
    )
    .toBeGreaterThan(steadyElapsed)
  const breakthroughFrame = await captureStage()
  await writeFile(
    testInfo.outputPath('water-hydraulic-breakthrough.png'),
    breakthroughFrame,
  )
  expect(breakthroughFrame.byteLength).toBeGreaterThan(10_000)
  expect(
    Number(await stage.getAttribute('data-filled-cells')),
  ).toBeLessThanOrEqual(activeCells)
  await expect(page.locator('.water-status-copy small')).not.toContainText(
    '흐름 100%',
  )
  await page
    .getByRole('button', { name: '물 시뮬레이션 일시정지' })
    .click()
  const manuallyPausedAt = Number(await stage.getAttribute('data-elapsed-ms'))
  await page.waitForTimeout(320)
  expect(Number(await stage.getAttribute('data-elapsed-ms'))).toBe(
    manuallyPausedAt,
  )
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  expect(consoleErrors).toEqual([])
})
