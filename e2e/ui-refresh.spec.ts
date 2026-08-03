import { expect, test, type Page, type TestInfo } from '@playwright/test'

async function createBasic(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()
}

async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  if (!process.env.CAPTURE_UI) return
  await page.screenshot({ path: testInfo.outputPath(name), fullPage })
}

test('홈에서 간결한 브랜드와 하나의 프로젝트 가져오기 경로를 제공한다', async ({ page }, testInfo) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'MazeCraft', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /새 미로 만들기/ })).toBeVisible()
  await expect(page.getByRole('img', { name: '제도용 종이 위에 손으로 그린 미로와 설계 도구가 놓인 작업대' })).toBeVisible()
  await expect(page.getByLabel('메이즈크래프트 미로 미리보기')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '무엇을 만들까요?' })).toBeVisible()
  await expect(page.getByText('풀어야 열리는 이야기', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/형태 제작부터 난이도 분석/)).toHaveCount(0)
  await expect(page.getByText('연속형 3D 물 시뮬레이션', { exact: true })).toHaveCount(0)
  await expect(page.getByPlaceholder('프로젝트 검색')).toBeVisible()
  await expect(page.getByLabel('프로젝트 정렬')).toBeVisible()
  await expect(page.getByText('LIVE PATH', { exact: true })).toHaveCount(0)
  const projectInput = page.locator('input[type="file"][accept*=".mazecraft"]')
  await expect(projectInput).toHaveCount(1)
  await expect(projectInput).toHaveAttribute('tabindex', '-1')
  await capture(page, testInfo, 'home-desktop.png', true)
})

test('데스크톱 제작기에서 중복 탐색 없이 단계 흐름과 넓은 캔버스를 제공한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await createBasic(page)

  const workspace = page.locator('.canvas-workspace')
  const initial = await workspace.boundingBox()
  expect(initial).not.toBeNull()
  expect(initial!.width).toBeGreaterThanOrEqual(880)
  await expect(page.locator('.left-rail')).toHaveCount(0)
  await expect(page.locator('.studio-stage-rail button')).toHaveCount(6)
  await expect(page.locator('.studio-stage-rail button.active')).toContainText('형태')
  await capture(page, testInfo, 'studio-desktop.png')

  await page.locator('.inspector-collapse').click()
  await expect(page.locator('.studio-root')).toHaveAttribute('data-inspector-collapsed', 'true')

  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0).toBeGreaterThan(initial!.width + 300)

  await page.locator('.focus-button').click()
  await expect(page.locator('.studio-root')).toHaveAttribute('data-focus-mode', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.studio-root')).toHaveAttribute('data-focus-mode', 'false')
})

test('모바일 제작기에서 여섯 단계를 빠짐없이 바텀 시트로 연다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await capture(page, testInfo, 'home-mobile.png', true)
  if (process.env.CAPTURE_UI) {
    await page.locator('#templates').scrollIntoViewIfNeeded()
    await capture(page, testInfo, 'home-mobile-templates.png')
    await page.locator('.home-shell').evaluate((element) => element.scrollTo({ top: 0 }))
  }
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()

  const tabs = page.locator('.mobile-tabs button')
  const inspector = page.locator('.inspector')
  const panelButton = page.locator('.canvas-toolbar .panel-trigger').last()
  await expect(tabs).toHaveCount(6)
  await expect(tabs).toHaveText(['형태', '미로', '게임', '꾸미기', '테스트', '공유'])
  await expect(inspector).toHaveAttribute('inert', '')
  await expect(panelButton).toHaveAttribute('aria-expanded', 'false')
  await expect(panelButton).toHaveAccessibleName('설정 패널 펼치기')
  await expect(page.locator('.studio-header .focus-button')).toBeVisible()
  await capture(page, testInfo, 'studio-mobile.png')

  const testTab = tabs.filter({ hasText: '테스트' })
  await testTab.click()
  await expect(inspector).toHaveClass(/open/)
  await expect(inspector).not.toHaveAttribute('inert', '')
  await expect(inspector).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.studio-header')).toHaveAttribute('inert', '')
  await expect(page.locator('.canvas-workspace')).toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: '설정 닫기' })).toBeFocused()
  await expect(page.locator('.mobile-tabs')).toBeHidden()
  await capture(page, testInfo, 'studio-mobile-sheet.png')
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await expect(page.locator('.mobile-tabs')).toBeVisible()
  await expect(testTab).toBeFocused()
})

test('소형 태블릿 홈에서 간결한 히어로와 템플릿 선반을 제공한다', async ({ page }) => {
  for (const width of [827, 980, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')

    await expect.poll(() => page.locator('.home-hero').evaluate((element) =>
      getComputedStyle(element).display,
    )).toBe('grid')
    await expect.poll(() => page.locator('.template-grid').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length,
    )).toBe(3)

    const clippedCards = await page.locator('.template-card').evaluateAll((cards) =>
      cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length,
    )
    expect(clippedCards).toBe(0)
  }
})

test('태블릿과 compact 경계에서 여섯 단계가 한 줄 안에 유지된다', async ({ page }) => {
  await page.setViewportSize({ width: 801, height: 900 })
  await createBasic(page)

  for (const width of [801, 827, 980, 1180]) {
    await page.setViewportSize({ width, height: 900 })

    const bar = page.locator('.mobile-tabs')
    const barBox = await bar.boundingBox()
    expect(barBox).not.toBeNull()
    const buttons = page.locator('.mobile-tabs button')
    await expect(buttons).toHaveCount(6)

    for (const button of await buttons.all()) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(barBox!.y - 1)
      expect(box!.y + box!.height).toBeLessThanOrEqual(barBox!.y + barBox!.height + 1)
    }
  }
})
