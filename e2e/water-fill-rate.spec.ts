import { expect, test } from '@playwright/test'
import {
  branchingWaterProject, importWaterProject, numberAttribute, openParticleWater,
  pauseWater, readWaterState,
} from './helpers/waterHarness'

test('화면이 8fps로 느려져도 물리 시간을 버리지 않고 미로에 물을 채운다', async ({ page }) => {
  test.setTimeout(45_000)
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    let nextId = 1
    const pending = new Map<number, { frame: number; timer?: number }>()
    // Slow presentation deliberately, without slowing timers or Worker replies.
    // Preserve cancellation so dialog cleanup exercises the real lifecycle.
    window.requestAnimationFrame = callback => {
      const id = nextId++
      const state: { frame: number; timer?: number } = { frame: 0 }
      pending.set(id, state)
      state.frame = request(() => {
        state.timer = window.setTimeout(() => {
          if (!pending.delete(id)) return
          callback(performance.now())
        }, 125)
      })
      return id
    }
    window.cancelAnimationFrame = id => {
      const state = pending.get(id)
      if (!state) return
      pending.delete(id)
      cancel(state.frame)
      if (state.timer !== undefined) clearTimeout(state.timer)
    }
  })
  await importWaterProject(page, branchingWaterProject, 'low')
  const stage = await openParticleWater(page)
  await expect.poll(() => numberAttribute(stage, 'data-filled-cells')).toBeGreaterThan(1)
  const progress = await stage.evaluate(async element => {
    const read = (name: string) => Number(element.getAttribute(name))
    const time = read('data-elapsed-ms')
    const stored = read('data-stored-volume')
    const start = performance.now()
    await new Promise(resolve => setTimeout(resolve, 3_500))
    return {
      wallMs: performance.now() - start,
      simulatedMs: read('data-elapsed-ms') - time,
      storedGain: read('data-stored-volume') - stored,
    }
  })
  // The former 50 ms/frame clock advanced at <40% of real time here. Allow
  // normal Worker/render scheduling jitter without accepting that regression.
  expect(progress.simulatedMs).toBeGreaterThan(progress.wallMs * 0.72)
  expect(progress.simulatedMs).toBeLessThan(progress.wallMs * 1.15)
  expect(progress.storedGain).toBeGreaterThan(0.5)
  await pauseWater(page, stage)
  const paused = await readWaterState(stage)
  const image = await stage.locator('canvas').screenshot()
  await page.waitForTimeout(350)
  expect(await readWaterState(stage)).toEqual(paused)
  expect((await stage.locator('canvas').screenshot()).equals(image)).toBe(true)
  expect(paused.error).toBeLessThan(1e-5)
})
