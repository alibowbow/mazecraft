import { expect, test, type Page } from '@playwright/test'

const responsiveViewports = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet portrait', width: 768, height: 1024 },
  { name: 'foldable portrait', width: 827, height: 873 },
  { name: 'foldable landscape', width: 873, height: 827 },
  { name: 'foldable desktop-site viewport', width: 980, height: 873 },
  { name: 'compact editor boundary', width: 1180, height: 800 },
] as const

async function openBasicMaze(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.goto('/')
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()
  await expect(page.locator('.studio-layout')).toBeVisible()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

for (const viewport of responsiveViewports) {
  test(`${viewport.name}에서는 3단 데스크톱 레이아웃으로 압축되지 않는다`, async ({ page }) => {
    await openBasicMaze(page, viewport)

    const pageWidth = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      client: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }))
    expect(pageWidth.document, '문서에 가로 오버플로가 없어야 한다').toBeLessThanOrEqual(
      pageWidth.client + 1,
    )
    expect(pageWidth.body, 'body가 뷰포트보다 넓어지면 안 된다').toBeLessThanOrEqual(
      pageWidth.viewport + 1,
    )

    await expect(page.locator('.left-rail')).toBeHidden()
    await expect(page.locator('.mobile-tabs')).toBeVisible()

    const closedInspector = await page.locator('.inspector').evaluate((element) => {
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return {
        position: style.position,
        overlapsViewport:
          bounds.bottom > 0 &&
          bounds.top < window.innerHeight &&
          bounds.right > 0 &&
          bounds.left < window.innerWidth,
      }
    })
    expect(closedInspector.position, '설정 패널은 고정된 세 번째 열이 아니라 바텀시트여야 한다').toBe(
      'fixed',
    )
    expect(closedInspector.overlapsViewport, '닫힌 설정 시트가 캔버스 폭을 차지하면 안 된다').toBe(
      false,
    )

    await page.locator('.mobile-tabs button').filter({ hasText: '형태' }).click()
    await expect(page.locator('.inspector')).toHaveClass(/open/)
    await expect
      .poll(async () => {
        const bounds = await page.locator('.inspector').evaluate((element) =>
          element.getBoundingClientRect().toJSON(),
        )
        return bounds.right
      })
      .toBeLessThanOrEqual(viewport.width + 1)

    const openInspector = await page.locator('.inspector').evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        viewportWidth: window.innerWidth,
      }
    })
    expect(openInspector.left).toBeGreaterThanOrEqual(-1)
    expect(openInspector.right).toBeLessThanOrEqual(openInspector.viewportWidth + 1)
    expect(openInspector.width).toBeLessThanOrEqual(openInspector.viewportWidth + 1)
  })

  test(`${viewport.name} 툴바의 버튼 문자가 세로로 찢어지지 않는다`, async ({ page }) => {
    await openBasicMaze(page, viewport)

    const toolbar = await page.locator('.canvas-toolbar').evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return { height: bounds.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
    })
    expect(toolbar.height, '모바일 툴바는 한 행 높이를 유지해야 한다').toBeLessThanOrEqual(56)
    expect(toolbar.clientWidth).toBeLessThanOrEqual(viewport.width + 1)

    const buttonMetrics = await page.locator('.toolbar-button').evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const style = getComputedStyle(button)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map((button) => {
          const bounds = button.getBoundingClientRect()
          const label = button.querySelector('span')
          if (!label) return { height: bounds.height, text: '', visibleLabelLines: 0 }

          const labelStyle = getComputedStyle(label)
          if (labelStyle.display === 'none' || labelStyle.visibility === 'hidden') {
            return { height: bounds.height, text: label.textContent?.trim() ?? '', visibleLabelLines: 0 }
          }

          const range = document.createRange()
          range.selectNodeContents(label)
          const lineTops = new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
              .map((rect) => Math.round(rect.top * 2) / 2),
          )
          return {
            height: bounds.height,
            text: label.textContent?.trim() ?? '',
            visibleLabelLines: lineTops.size,
          }
        }),
    )

    expect(
      buttonMetrics.filter((button) => button.height > 48),
      '툴바 버튼이 줄바꿈 때문에 세로로 늘어나면 안 된다',
    ).toEqual([])
    expect(
      buttonMetrics.filter((button) => button.visibleLabelLines > 1),
      '표시되는 툴바 라벨은 한 줄이어야 한다',
    ).toEqual([])
  })
}
