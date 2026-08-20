import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDefaultProject } from '../src/core/maze'

const project = createDefaultProject({
  title: '3D 카메라 이동 검증 미로',
  seed: 'water-camera-pan-e2e',
  grid: { rows: 8, cols: 8, minimumCellPixels: 8 },
})

async function openWater(page: Page) {
  await page.goto('/')
  const importer = page.locator('input[type="file"][accept*=".mazecraft"]')
  if (await importer.count()) {
    await importer.setInputFiles({
      name: 'water-camera-pan.mazecraft',
      mimeType: 'application/vnd.mazecraft+json',
      buffer: Buffer.from(JSON.stringify(project)),
    })
  }
  await page.locator('.studio-stage-rail button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('low')
  await page.getByRole('button', { name: '3D 물 시뮬레이션 열기' }).click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', {
    timeout: 30_000,
  })
  return stage
}

const readCamera = async (canvas: Locator) =>
  canvas.evaluate((element) => ({
    x: Number((element as HTMLElement).dataset.cameraTargetX),
    y: Number((element as HTMLElement).dataset.cameraTargetY),
    distance: Number((element as HTMLElement).dataset.cameraDistance),
  }))

test('확대한 3D 미로를 한 손가락식 드래그로 이동해 화면 밖을 볼 수 있다', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const stage = await openWater(page)
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('data-camera-navigation', 'pan-zoom')
  await expect(canvas).toHaveAttribute('data-camera-drag', 'one-pointer-pan')
  await expect(canvas).toHaveAttribute('data-camera-pinch', 'dolly-pan')

  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  await expect(stage).toHaveAttribute('data-phase', 'paused')
  const pausedTime = Number(await stage.getAttribute('data-elapsed-ms'))

  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const centerX = box.x + box.width * 0.5
  const centerY = box.y + box.height * 0.5

  const initial = await readCamera(canvas)
  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, -1_400)
  await expect
    .poll(async () => (await readCamera(canvas)).distance)
    .toBeLessThan(initial.distance - 0.2)

  const afterZoom = await readCamera(canvas)
  await page.mouse.move(centerX, centerY)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(centerX + box.width * 0.2, centerY + box.height * 0.16, {
    steps: 12,
  })
  await page.mouse.up({ button: 'left' })

  await expect
    .poll(async () => {
      const afterPan = await readCamera(canvas)
      return Math.hypot(afterPan.x - afterZoom.x, afterPan.y - afterZoom.y)
    })
    .toBeGreaterThan(0.05)

  expect(Number(await stage.getAttribute('data-elapsed-ms'))).toBe(pausedTime)
})
