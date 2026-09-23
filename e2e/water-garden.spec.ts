import { expect, test } from '@playwright/test'
import { waterStartupTimeout, e2eTimeout } from './helpers/runtimeBudget'
import { openWaterGarden } from './helpers/navigation'

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
    await openWaterGarden(page)
    await page.getByRole('group', { name: '미로 프리셋' }).getByRole('button', { name: new RegExp(label) }).click()
    // The studio opens in 2D; the water garden itself is the 3D view.
    await page.getByRole('button', { name: '3D', exact: true }).click()
    await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: waterStartupTimeout })
    await expect(page.locator(canvasSelector)).toHaveAttribute('data-garden', id, { timeout: waterStartupTimeout })
    // Every garden starts dry and fills from its source.
    const dry = await gardenState(page)
    expect(dry.sculpture).toBe('garden')
    expect(dry.levels.length).toBeGreaterThanOrEqual(3)
    await page.getByRole('button', { name: '물 흘려보내기', exact: true }).click()
    await expect.poll(async () => (await gardenState(page)).spills.filter(rate => rate > 0).length,
      { timeout: e2eTimeout(120_000) }).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })
}
