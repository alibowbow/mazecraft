import { expect, test, type Page } from '@playwright/test'
import { createDefaultProject } from '../src/core/maze'

const project = createDefaultProject({
  title: 'Blender 수면 atlas 검증 미로',
  seed: 'blender-water-e2e',
  grid: { rows: 6, cols: 6, minimumCellPixels: 8 },
})

async function openHighQualityWater(page: Page) {
  await page.goto('/')
  const importer = page.locator('input[type="file"][accept*=".mazecraft"]')
  if (await importer.count()) {
    await importer.setInputFiles({
      name: 'blender-water.mazecraft',
      mimeType: 'application/vnd.mazecraft+json',
      buffer: Buffer.from(JSON.stringify(project)),
    })
  }
  await page.locator('.studio-stage-rail button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('high')
  await page.getByRole('button', { name: '물 시뮬레이션 열기' }).click()
  await page.getByRole('button', { name: '3D 수면', exact: true }).click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(stage).toHaveAttribute('data-fluid-model', 'dynamic-head-discharge-network')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', {
    timeout: 30_000,
  })
  return stage
}

test('Blender atlas가 실시간 수리 수면에 로드되고 셰이더 오류 없이 동작한다', async ({
  page,
}) => {
  test.setTimeout(120_000)
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

  const stage = await openHighQualityWater(page)
  await expect(stage.locator('canvas.water-simulation-canvas')).toBeVisible()
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.dataset.blenderWaterAtlas ?? 'idle',
        ),
      { timeout: 30_000 },
    )
    .toBe('ready')

  await page.getByLabel('물 흐름 속도').selectOption('4')
  await expect
    .poll(
      () => Number(stage.getAttribute('data-filled-cells')),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(1)

  expect(externalRequests).toEqual([])
  expect(consoleErrors).toEqual([])
})
