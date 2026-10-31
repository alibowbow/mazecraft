import { e2eTimeout } from './helpers/runtimeBudget'
import { expect, test } from '@playwright/test'
import {
  fallingWaterProject, importWaterProject, installWorkerProbe, numberAttribute,
  openParticleWater, readWorkerProbe,
} from './helpers/waterHarness'

// The conserved 3D basin's real-browser shader gate: it runs beside the 2D
// particle Worker without starting a second simulation Worker.
test('고화질 3D 수조는 2D Worker를 보존하고 오류 없이 렌더링된다', async ({ page }, testInfo) => {
  test.setTimeout(e2eTimeout(60_000))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await installWorkerProbe(page)
  await importWaterProject(page, fallingWaterProject, 'high')
  const stage = await openParticleWater(page, 'surface-3d')
  await expect.poll(() => numberAttribute(stage, 'data-filled-cells'), { timeout: 20_000 }).toBeGreaterThan(1)
  await expect(stage).toHaveAttribute('data-view-mode', 'surface-3d')
  await expect(stage).toHaveAttribute('data-fluid-model', 'hydraulic-basin')
  const probe = await readWorkerProbe(page)
  expect(probe.fluidLayouts).toHaveLength(1)
  expect(probe.urls.filter(url => /fluid\.worker/.test(url))).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('water-3d-runtime.png') })
  expect(errors).toEqual([])
})
