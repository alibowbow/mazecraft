import { expect, type Page } from '@playwright/test'

/** The collection/editor remains available behind the new simulation home. */
export async function openProjectLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: '내 미로', exact: true }).click()
  await expect(page.locator('input[type="file"][accept*=".mazecraft"]')).toHaveCount(1)
}

export async function visitProjectLibrary(page: Page): Promise<void> {
  await page.goto('/')
  await openProjectLibrary(page)
}

/** Imported/recovered projects can open in the simulation before editing. */
export async function enterProjectEditor(page: Page): Promise<void> {
  const editor = page.getByLabel('프로젝트 제목')
  const studio = page.getByTestId('water-studio')
  await expect(editor.or(studio)).toBeVisible()
  if (await editor.isVisible()) return
  const mazeTab = page.getByRole('tab', { name: '미로', exact: true })
  if (!(await mazeTab.isVisible())) {
    await page.getByRole('button', { name: '튜닝 열기', exact: true }).click()
  }
  await mazeTab.click()
  await page.getByRole('button', { name: '편집기에서 직접 만들기', exact: true }).click()
  await expect(editor).toBeVisible()
}
