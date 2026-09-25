import { expect, test } from '@playwright/test'
import { waterStartupTimeout, e2eTimeout } from './helpers/runtimeBudget'

const canvasSelector = '[data-testid="craft-canvas"] canvas.water-simulation-canvas'

test('crafts a water course from devices and runs it with the physics engine', async ({ page }) => {
  test.setTimeout(e2eTimeout(240_000))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) errors.push(message.text()) })
  await page.goto('/')
  await page.getByRole('button', { name: '물길 크래프트' }).click()
  await expect(page.getByTestId('craft-studio')).toBeVisible()
  await expect(page.getByTestId('craft-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: waterStartupTimeout })
  // The garden renders through the post pipeline at a tier this device can carry.
  await expect(page.locator(canvasSelector)).toHaveAttribute('data-post-tier', /^[0-3]$/)
  const panel = page.getByRole('complementary', { name: '물길 크래프트' })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '장치 목록 열기' }).click()

  // A template is a complete course.
  await panel.getByRole('button', { name: '프리셋 둘러보기' }).click()
  await panel.getByRole('group', { name: '추천 조합' }).getByRole('button', { name: '스크류와 수도교' }).click()
  await expect(panel.getByTestId('craft-verdict')).toContainText('물이 끝까지 흐르는 물길')
  const garden = await page.getByTestId('craft-canvas').getAttribute('data-garden')
  // The template ends low: only a lift still fits, and adding it rebuilds
  // the garden in place.
  await expect(panel.getByRole('button', { name: '연꽃 연못 추가' })).toContainText('높이 부족')
  await panel.getByRole('button', { name: '아르키메데스 스크류 추가' }).click()
  await expect(panel.getByTestId('craft-verdict')).toContainText('물이 끝까지 흐르는 물길')
  await expect(page.getByTestId('craft-canvas')).not.toHaveAttribute('data-garden', garden ?? '', { timeout: 10_000 })
  await expect(page.getByTestId('craft-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: waterStartupTimeout })

  // The water runs through it.
  if (await panel.isVisible() && await page.getByRole('button', { name: '장치 목록 닫기' }).isVisible()) await page.getByRole('button', { name: '장치 목록 닫기' }).click()
  await page.getByRole('button', { name: '물 흘려보내기', exact: true }).click()
  await expect.poll(() => page.evaluate(selector => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)
    return (JSON.parse(canvas?.dataset.spillRates ?? '[]') as number[]).filter(rate => rate > 0).length
  }, canvasSelector), { timeout: e2eTimeout(120_000) }).toBeGreaterThan(0)
  // A rubber duck rides the water: Rapier loads (WebAssembly under the CSP) without errors.
  await page.getByRole('button', { name: '물에 띄우기' }).click()
  await page.getByRole('menuitem', { name: /고무오리/ }).click()
  await page.waitForTimeout(3000)
  expect(errors).toEqual([])
})

test('explains why a course cannot be built', async ({ page }) => {
  test.setTimeout(e2eTimeout(120_000))
  await page.goto('/')
  await page.getByRole('button', { name: '물길 크래프트' }).click()
  await expect(page.getByTestId('craft-studio')).toBeVisible()
  const panel = page.getByRole('complementary', { name: '물길 크래프트' })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '장치 목록 열기' }).click()
  await panel.getByRole('button', { name: '모두 비우기' }).click()
  await expect(panel.getByTestId('craft-verdict')).toContainText('장치를 하나 이상')
  // Four basins in a row from a low source run out of height.
  const source = panel.getByRole('slider', { name: '수원 높이' })
  await source.focus()
  await source.press('Home')
  for (let k = 0; k < 4; k++) await panel.getByRole('button', { name: '미로 수조 추가' }).click()
  await expect(panel.getByTestId('craft-verdict')).toContainText('높이가 부족')
  // The plan marks the device that does not fit, and a checked fix applies in one click.
  await expect(page.getByTestId('craft-plan')).toContainText('남음')
  const fixes = panel.getByRole('group', { name: '추천 해결 방법' }).getByRole('button')
  await expect(fixes.first()).toBeVisible()
  await fixes.first().click()
  await expect(panel.getByTestId('craft-verdict')).toContainText('물이 끝까지 흐르는 물길')
})

test('clears the first challenge stage when the physics meets its goals', async ({ page }) => {
  test.setTimeout(e2eTimeout(240_000))
  await page.goto('/')
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('mazecraft.cinematic.v1', 'off') })
  await page.getByRole('button', { name: '물길 크래프트' }).click()
  await expect(page.getByTestId('craft-studio')).toBeVisible()
  const panel = page.getByRole('complementary', { name: '물길 크래프트' })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '장치 목록 열기' }).click()
  await panel.getByRole('button', { name: /챌린지/ }).click()
  await expect(panel.getByRole('list', { name: '목표' })).toContainText('종착 연못까지')
  // Later stages stay locked until the one before is cleared.
  await expect(panel.getByRole('button', { name: /2\. .*잠김/ })).toBeDisabled()
  await panel.getByRole('button', { name: '연꽃 연못 추가' }).click()
  await expect(page.getByTestId('craft-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: waterStartupTimeout })
  if (await page.getByRole('button', { name: '장치 목록 닫기' }).isVisible()) await page.getByRole('button', { name: '장치 목록 닫기' }).click()
  await page.getByRole('combobox', { name: '재생 속도' }).selectOption('4')
  await page.getByRole('button', { name: '물 흘려보내기', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '스테이지 클리어' })).toBeVisible({ timeout: e2eTimeout(150_000) })
  await page.getByRole('button', { name: '다음 스테이지' }).click()
  await expect(panel.getByRole('list', { name: '목표' })).toContainText('시시오도시')
})
