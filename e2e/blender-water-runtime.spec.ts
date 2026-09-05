import { expect, test } from '@playwright/test'
import {
  fallingWaterProject, importWaterProject, installWorkerProbe, numberAttribute,
  openParticleWater, readWorkerProbe,
} from './helpers/waterHarness'

// The historical atlas UI was replaced by a second view of the particle water.
// Keep its real-browser shader/asset-loading gate on the current visible mode.
test('고화질 3D 물은 입자 Worker를 사용하고 레거시 atlas 없이 렌더링된다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  const legacyRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    if (/blender.*(?:atlas|water)|hydraulic\.worker/i.test(request.url())) legacyRequests.push(request.url())
  })
  await installWorkerProbe(page)
  await importWaterProject(page, fallingWaterProject, 'high')
  const stage = await openParticleWater(page, 'surface-3d')
  await expect.poll(() => numberAttribute(stage, 'data-filled-cells'), { timeout: 20_000 }).toBeGreaterThan(1)
  await expect(stage).toHaveAttribute('data-view-mode', 'surface-3d')
  await expect(stage).toHaveAttribute('data-fluid-model', 'position-based-free-surface')
  const probe = await readWorkerProbe(page)
  expect(probe.fluidLayouts).toHaveLength(1)
  expect(probe.urls.filter(url => /fluid\.worker/.test(url))).toHaveLength(1)
  expect(probe.urls.some(url => /hydraulic\.worker/.test(url))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('water-3d-runtime.png') })
  expect(legacyRequests).toEqual([])
  expect(errors).toEqual([])
})
