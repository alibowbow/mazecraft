import { expect, test } from '@playwright/test'
import { branchingWaterProject, importWaterProject, numberAttribute, openParticleWater, pauseWater, readWaterState } from './helpers/waterHarness'

test('3D 미로를 확대하고 드래그해도 멈춘 물리 상태는 변하지 않는다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await importWaterProject(page, branchingWaterProject, 'low')
  const stage = await openParticleWater(page, 'surface-3d')
  await expect.poll(() => numberAttribute(stage, 'data-particle-count')).toBeGreaterThan(0)
  await pauseWater(page, stage)
  const before = await readWaterState(stage)
  const canvas = stage.locator('canvas.water-simulation-canvas')
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  const x = bounds!.x + bounds!.width * 0.5
  const y = bounds!.y + bounds!.height * 0.5
  const initialImage = await canvas.screenshot()
  await page.mouse.move(x, y)
  await page.mouse.wheel(0, -800)
  const zoomedImage = await canvas.screenshot()
  expect(zoomedImage.equals(initialImage)).toBe(false)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(x + bounds!.width * 0.15, y + bounds!.height * 0.15, { steps: 10 })
  await page.mouse.up({ button: 'left' })
  const movedImage = await canvas.screenshot()
  expect(movedImage.equals(zoomedImage)).toBe(false)
  expect(await readWaterState(stage)).toEqual(before)
  await page.waitForTimeout(320)
  expect((await canvas.screenshot()).equals(movedImage)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('water-3d-camera-moved.png') })
  await canvas.focus()
  await page.keyboard.press('Home')
  expect((await canvas.screenshot()).equals(movedImage)).toBe(false)
  expect(await readWaterState(stage)).toEqual(before)
})
