import { expect, type Page } from '@playwright/test'
import { waterStartupTimeout } from './runtimeBudget'

/** The collection/editor remains available behind the new simulation home. */
export async function openProjectLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: '내 미로', exact: true }).click()
  await expect(page.locator('input[type="file"][accept*=".mazecraft"]')).toHaveCount(1)
}

export async function visitProjectLibrary(page: Page): Promise<void> {
  // Collection/editor tests exercise their real entry route. The water-studio
  // suite separately covers the home-to-collection navigation and round trip.
  await page.goto('/#/library')
  await expect(page.locator('input[type="file"][accept*=".mazecraft"]')).toHaveCount(1)
  await expect(page.getByTestId('water-studio')).toHaveCount(0)
}

/** Imported/recovered projects can open in the simulation before editing. */
export async function enterProjectEditor(page: Page): Promise<void> {
  const editor = page.getByLabel('프로젝트 제목')
  const studio = page.getByTestId('water-studio')
  await expect(editor.or(studio)).toBeVisible({ timeout: process.env.CI ? waterStartupTimeout : 5_000 })
  if (await editor.isVisible()) return
  const mazeTab = page.getByRole('tab', { name: '미로', exact: true })
  if (!(await mazeTab.isVisible())) {
    await page.getByRole('button', { name: '튜닝 열기', exact: true }).click()
  }
  await mazeTab.click()
  await page.getByRole('button', { name: '전체 제작기 · 글자 / 이미지 / 벽 편집', exact: true }).click()
  await expect(editor).toBeVisible()
}
