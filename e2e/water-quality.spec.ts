import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createDefaultProject } from '../src/core/maze'

test('연속 수면 렌더러가 시네마틱 장면을 움직이며 그린다', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
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
  await page.getByRole('button', { name: '3D 물 시뮬레이션 열기' }).click()

  const stage = page.getByTestId('water-simulation-stage')
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', {
    timeout: 15_000,
  })
  await expect(stage).toHaveAttribute(
    'data-fluid-renderer',
    'timeline-surface',
  )
  await expect(canvas).toBeVisible()
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
  await page.getByLabel('물 흐름 속도').selectOption('0.5')
  await page.getByRole('button', { name: '처음부터', exact: true }).click()
  await expect
    .poll(async () => Number(await stage.getAttribute('data-filled-cells')))
    .toBeLessThan(100)
  const restartedFilledCells = Number(
    await stage.getAttribute('data-filled-cells'),
  )
  await expect
    .poll(async () => Number(await stage.getAttribute('data-filled-cells')))
    .toBeGreaterThan(restartedFilledCells)
  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  await expect(stage).toHaveAttribute('data-phase', 'paused')
  const movingFrame = await captureStage()
  await writeFile(
    testInfo.outputPath('water-quality-mid.png'),
    movingFrame,
  )

  expect(movingFrame.byteLength).toBeGreaterThan(10_000)
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
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  expect(consoleErrors).toEqual([])
})
