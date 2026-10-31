import { expect, type Page } from '@playwright/test'
import { waterStartupTimeout } from './runtimeBudget'

/** The saved projects live on the home; studios reach them through "내 미로". */
export async function openProjectLibrary(page: Page): Promise<void> {
  const importer = page.locator('input[type="file"][accept*=".mazecraft"]')
  // Wait until either the home or the water studio has settled.
  await expect(page.locator('.home-shell').or(page.getByTestId('water-studio'))).toBeVisible()
  if (!(await importer.count())) await page.getByRole('button', { name: '내 미로', exact: true }).click()
  await expect(importer).toHaveCount(1)
}

/** MazeCraft opens on its home; the water garden is one of its two doors. */
export async function openWaterGarden(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await page.getByRole('button', { name: '물의 정원 열기', exact: true }).click()
  await expect(page.getByTestId('water-studio')).toBeVisible()
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
  const resume = page.getByRole('button', { name: '최근 미로 이어서', exact: true })
  const timeout = process.env.CI ? waterStartupTimeout : 5_000
  await expect(editor.or(studio).or(resume)).toBeVisible({ timeout })
  if (await editor.isVisible()) return
  if (!(await studio.isVisible())) {
    // The home. An opened file is still on its way to the editor, so give it
    // a moment before deciding; a reload with no screen in the address offers
    // the recovered project instead.
    if (await editor.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) return
    await resume.click({ timeout })
    await expect(editor).toBeVisible()
    return
  }
  const mazeTab = page.getByRole('tab', { name: '미로', exact: true })
  if (!(await mazeTab.isVisible())) {
    await page.getByRole('button', { name: '튜닝 열기', exact: true }).click()
  }
  await mazeTab.click()
  await page.getByRole('button', { name: '전체 제작기 · 글자 / 이미지 / 벽 편집', exact: true }).click()
  await expect(editor).toBeVisible()
}
