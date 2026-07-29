export interface QrOptions {
  width?: number
  margin?: number
  darkColor?: string
  lightColor?: string
}

function normalizeOptions(options: QrOptions = {}) {
  return {
    errorCorrectionLevel: 'M' as const,
    width: Math.min(1024, Math.max(128, options.width ?? 320)),
    margin: Math.min(8, Math.max(0, options.margin ?? 2)),
    color: {
      dark: options.darkColor ?? '#111827',
      light: options.lightColor ?? '#ffffff',
    },
  }
}

export async function createQrDataUrl(
  value: string,
  options: QrOptions = {},
): Promise<string> {
  if (!value.trim()) throw new Error('QR 코드에 담을 내용이 없습니다.')
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(value, normalizeOptions(options))
}

export async function createQrSvg(
  value: string,
  options: QrOptions = {},
): Promise<string> {
  if (!value.trim()) throw new Error('QR 코드에 담을 내용이 없습니다.')
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(value, {
    ...normalizeOptions(options),
    type: 'svg',
  })
}
