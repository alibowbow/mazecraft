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

  await expect(canvas).toHaveAttribute('data-water-optics', 'clear')
  await page.screenshot({ path: testInfo.outputPath('water-colorless-desktop.png') })
  await palette.getByRole('button', { name: '물 색상 청록', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-water-optics', 'aqua')
  const aqua = await canvas.screenshot()
  await page.screenshot({ path: testInfo.outputPath('water-original-aqua-desktop.png') })
  // Compare actual water pixels, selected by their cyan tint in the aqua
  // rendering. Clear water may refract the warm backing, but must not be dyed.
  const chroma = await page.evaluate(async ({ clear, aqua }) => {
    const pixels = async (encoded: string) => {
      const source = new Image()
      source.src = 'data:image/png;base64,' + encoded
      await source.decode()
      const image = document.createElement('canvas')
      image.width = source.naturalWidth; image.height = source.naturalHeight
      const context = image.getContext('2d')!
      context.drawImage(source, 0, 0)
      return context.getImageData(0, 0, image.width, image.height).data
    }
    const [neutral, tinted] = await Promise.all([pixels(clear), pixels(aqua)])
    let count = 0, neutralChroma = 0, aquaChroma = 0
    for (let i = 0; i < neutral.length; i += 4) {
      if (tinted[i + 1] - tinted[i] < 25 || Math.abs(neutral[i] - tinted[i]) < 15) continue
      count++
      neutralChroma += Math.max(neutral[i], neutral[i + 1], neutral[i + 2]) - Math.min(neutral[i], neutral[i + 1], neutral[i + 2])
      aquaChroma += tinted[i + 1] - tinted[i]
    }
    return { count, neutral: neutralChroma / Math.max(1, count), aqua: aquaChroma / Math.max(1, count) }
  }, { clear: clear.toString('base64'), aqua: aqua.toString('base64') })
  expect(chroma.count).toBeGreaterThan(200)
  // Clear water transmits the pastel peach backing without additional dye.
  expect(chroma.neutral).toBeLessThan(45)
  expect(chroma.aqua).toBeGreaterThan(25)
  expect(await readWaterState(stage)).toEqual(state)
  await expect(canvas).toHaveAttribute('data-surface-builds', initialFieldBuilds!)

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

  await page.getByRole('button', { name: '3D 수면', exact: true }).click()
  await expect(stage).toHaveAttribute('data-water-color', '#ed2f79')
  const threeDColored = await canvas.screenshot()
  await page.screenshot({ path: testInfo.outputPath('water-custom-3d-desktop.png') })
  const threeDFieldBuilds = await canvas.getAttribute('data-surface-builds')
  const threeDOpticalBuilds = Number(await canvas.getAttribute('data-optical-builds'))
  await expect(canvas).toHaveAttribute('data-water-detail', 'multiband-ripples')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 3 })
  await page.mouse.up()
  await expect(canvas).toHaveAttribute('data-surface-builds', threeDFieldBuilds!)
  expect(Number(await canvas.getAttribute('data-optical-builds'))).toBeGreaterThan(threeDOpticalBuilds)
  await palette.getByRole('button', { name: '물 색상 투명 물', exact: true }).click()
  await expect(stage).toHaveAttribute('data-water-color', 'clear')
  await expect(canvas).toHaveAttribute('data-surface-builds', threeDFieldBuilds!)
  expect((await canvas.screenshot()).equals(threeDColored)).toBe(false)
  const clearThreeD = await canvas.screenshot()
  await page.screenshot({ path: testInfo.outputPath('water-colorless-ripple-3d-desktop.png') })
  await page.waitForTimeout(320)
  expect((await canvas.screenshot()).equals(clearThreeD)).toBe(true)
  await page.getByRole('button', { name: '2D 물 흐름', exact: true }).click()
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
    const controlsFit = await page.locator('.water-simulation-controls button, .water-simulation-controls select').evaluateAll(controls => {
      const boxes = controls.map(control => control.getBoundingClientRect())
      return boxes.every((box, index) => box.width >= 44 && box.height >= 44
        && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        && boxes.slice(index + 1).every(other =>
          Math.min(box.right, other.right) - Math.max(box.left, other.left) <= 0.5
          || Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) <= 0.5))
    })
    expect(controlsFit).toBe(true)
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
