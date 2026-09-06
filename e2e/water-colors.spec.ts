import { expect, test } from '@playwright/test'
import {
  branchingWaterProject, fallingWaterProject, importWaterProject, installWorkerProbe,
  numberAttribute, openParticleWater, pauseWater, readWaterState, readWorkerProbe,
} from './helpers/waterHarness'

test('물 색상이 정지된 실제 수면에 적용되고 투명 물로 되돌리면 동일한 화면을 복원한다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await installWorkerProbe(page)
  await importWaterProject(page, branchingWaterProject, 'high')
  const stage = await openParticleWater(page)
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(2_000)
  await pauseWater(page, stage)
  const state = await readWaterState(stage)
  const workers = await readWorkerProbe(page)
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await canvas.evaluate(element => { element.dataset.colorTestIdentity = 'same-water' })
  const palette = page.getByRole('group', { name: '물 색상', exact: true })
  await expect(palette.getByRole('button')).toHaveCount(7)
  await expect(palette.getByRole('button', { name: '물 색상 투명 물', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(stage).toHaveAttribute('data-water-color', 'clear')
  const clear = await canvas.screenshot()
  const initialFieldBuilds = await canvas.getAttribute('data-surface-builds')
  expect(Number(initialFieldBuilds)).toBeGreaterThan(0)

  await palette.getByRole('button', { name: '물 색상 파랑', exact: true }).click()
  await expect(stage).toHaveAttribute('data-water-color-preset', 'blue')
  await expect(stage).toHaveAttribute('data-water-color', '#3786e8')
  const blue = await canvas.screenshot()
  expect(blue.equals(clear)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('water-blue-desktop.png') })
  expect(await readWaterState(stage)).toEqual(state)

  // Native color pickers are outside the page in headless Chromium. Dispatch
  // the input/change pair they produce; all preset choices use real clicks.
  await page.getByLabel('물 색상 직접 선택', { exact: true }).evaluate(element => {
    const input = element as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#ed2f79')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(stage).toHaveAttribute('data-water-color-preset', 'custom')
  await expect(stage).toHaveAttribute('data-water-color', '#ed2f79')
  const custom = await canvas.screenshot()
  expect(custom.equals(clear)).toBe(false)
  expect(custom.equals(blue)).toBe(false)
  expect(await readWaterState(stage)).toEqual(state)
  await expect(canvas).toHaveAttribute('data-surface-builds', initialFieldBuilds!)

  await page.getByLabel('물 시뮬레이션 방식').selectOption('surface-3d')
  await expect(stage).toHaveAttribute('data-water-color', '#ed2f79')
  const threeDColored = await canvas.screenshot()
  await page.screenshot({ path: testInfo.outputPath('water-custom-3d-desktop.png') })
  const threeDFieldBuilds = await canvas.getAttribute('data-surface-builds')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 3 })
  await page.mouse.up()
  await expect(canvas).toHaveAttribute('data-surface-builds', threeDFieldBuilds!)
  await palette.getByRole('button', { name: '물 색상 투명 물', exact: true }).click()
  await expect(stage).toHaveAttribute('data-water-color', 'clear')
  await expect(canvas).toHaveAttribute('data-surface-builds', threeDFieldBuilds!)
  expect((await canvas.screenshot()).equals(threeDColored)).toBe(false)
  await page.getByLabel('물 시뮬레이션 방식').selectOption('free-surface')
  expect((await canvas.screenshot()).equals(clear)).toBe(true)
  expect(await readWaterState(stage)).toEqual(state)
  expect(await readWorkerProbe(page)).toEqual(workers)
  await expect(canvas).toHaveAttribute('data-color-test-identity', 'same-water')
  await expect(stage).toHaveAttribute('data-phase', 'paused')
  expect(state.error).toBeLessThan(1e-5)
})

test('15. 물 색상과 수면 표현이 모바일과 태블릿에서 바로 보이고 터치할 수 있다', async ({ page }, testInfo) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 360, height: 800 })
  await importWaterProject(page, fallingWaterProject, 'low', true)
  const stage = await openParticleWater(page)
  await expect.poll(() => numberAttribute(stage, 'data-particle-count')).toBeGreaterThan(0)
  await pauseWater(page, stage)
  const state = await readWaterState(stage)
  for (const [width, height] of [[360, 800], [320, 640], [768, 800], [800, 390]]) {
    await page.setViewportSize({ width, height })
    const palette = page.getByRole('group', { name: '물 색상', exact: true })
    const styles = page.getByRole('group', { name: '수면 표현', exact: true })
    await expect(palette).toBeVisible()
    await expect(styles).toBeVisible()
    const layout = await page.locator('.water-appearance-controls').evaluate(element => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      invalidTargets: [...element.querySelectorAll('button, input')].flatMap(control => {
        const box = control.getBoundingClientRect()
        const invalid = box.width < 44 || box.height < 44 || box.left < 0 || box.top < 0
          || box.right > window.innerWidth || box.bottom > window.innerHeight
        return invalid ? [{ name: control.getAttribute('aria-label') || control.textContent, box: box.toJSON() }] : []
      }),
    }))
    await page.screenshot({ path: testInfo.outputPath(`water-palette-layout-${width}-${height}.png`) })
    expect(layout).toEqual({ overflow: false, invalidTargets: [] })
    await palette.getByRole('button', { name: '물 색상 주황', exact: true }).click()
    await expect(stage).toHaveAttribute('data-water-color-preset', 'amber')
    await styles.getByRole('button', { name: '잔잔함', exact: true }).click()
    await expect(stage).toHaveAttribute('data-water-surface-style', 'calm')
    await expect(styles.getByRole('button', { name: '잔잔함', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await readWaterState(stage)).toEqual(state)
    await page.screenshot({ path: testInfo.outputPath(`water-palette-${width}-${height}.png`) })
  }
})
