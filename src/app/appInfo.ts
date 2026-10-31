/** Build facts shown in the app information and copied into error reports. */
export const APP_VERSION: string = __APP_VERSION__
export const APP_COMMIT: string = __APP_COMMIT__

export function versionLabel(): string {
  return APP_COMMIT ? `${APP_VERSION} (${APP_COMMIT})` : APP_VERSION
}

/** A plain-text report a tester can pass on with the steps that led to it. */
export function errorReport(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  return [
    `MazeCraft ${versionLabel()}`,
    `주소: ${location.href.split('?data=')[0]}`,
    `브라우저: ${navigator.userAgent}`,
    `시각: ${new Date().toISOString()}`,
    '',
    detail.trim(),
  ].join('\n')
}
