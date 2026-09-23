import { expect, test } from '@playwright/test'
import { waterStartupTimeout, e2eTimeout } from './helpers/runtimeBudget'

const canvasSelector = '[data-testid="water-studio-canvas"] canvas.water-simulation-canvas'
const presets = [['포슬린 가든', 'atelier'], ['캐스케이드', 'cascade'], ['트윈 플로우', 'split'], ['리본', 'serpentine'], ['워터 가든', 'garden']] as const

async function gardenState(page: import('@playwright/test').Page) {
  return page.evaluate(selector => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)!
    return {
      garden: canvas.dataset.garden, sculpture: canvas.dataset.sculpture, time: Number(canvas.dataset.basinTime),
      levels: JSON.parse(canvas.dataset.poolLevels ?? '[]') as number[], spills: JSON.parse(canvas.dataset.spillRates ?? '[]') as number[],
    }
  }, canvasSelector)
}

for (const [label, id] of presets) {
  test(`${label} renders its own flowing water garden without shader errors`, async ({ page }) => {
    test.setTimeout(e2eTimeout(180_000))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) errors.push(message.text()) })
    await page.goto('/')
    await page.getByRole('group', { name: '미로 프리셋' }).getByRole('button', { name: new RegExp(label) }).click()
    await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: waterStartupTimeout })
    await expect(page.locator(canvasSelector)).toHaveAttribute('data-garden', id, { timeout: waterStartupTimeout })
    await expect.poll(async () => (await gardenState(page)).time, { timeout: waterStartupTimeout }).toBeGreaterThan(0.3)
    const state = await gardenState(page)
    expect(state.sculpture).toBe('garden')
    expect(state.levels.length).toBeGreaterThanOrEqual(3)
    expect(state.spills.every(rate => rate > 0), 'every weir and spout carries water').toBe(true)
    expect(errors).toEqual([])
  })
}
