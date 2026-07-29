export async function copyShareLink(value: string): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard?.writeText
  ) {
    await navigator.clipboard.writeText(value)
    return
  }
  if (typeof document !== 'undefined' && document.execCommand) {
    const input = document.createElement('textarea')
    input.value = value
    input.readOnly = true
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    let copied = false
    try {
      input.select()
      copied = document.execCommand('copy')
    } finally {
      input.remove()
    }
    if (copied) return
  }
  throw new Error('이 브라우저에서는 클립보드 복사를 사용할 수 없습니다.')
}

export async function shareWithBrowser(
  url: string,
  title: string,
  text = '풀어야만 열리는 이야기',
): Promise<'shared' | 'unavailable'> {
  if (typeof navigator === 'undefined' || !navigator.share) {
    return 'unavailable'
  }
  await navigator.share({ url, title, text })
  return 'shared'
}

export interface BrowserShareData {
  url: string
  title: string
  text?: string
}

/** Object-shaped adapter used by dialogs and player actions. */
export async function shareUrl(
  data: BrowserShareData,
): Promise<'shared' | 'unavailable'> {
  return shareWithBrowser(
    data.url,
    data.title,
    data.text ?? '풀어야만 열리는 이야기',
  )
}
