import type { BooleanMask, TextMaskOptions } from './types'

const cache = new Map<string, BooleanMask>()

const cloneMask = (mask: BooleanMask) => mask.map((row) => [...row])

const fitFont = (
  context: CanvasRenderingContext2D,
  lines: string[],
  options: TextMaskOptions,
  width: number,
  height: number,
) => {
  if (options.fit === 'manual') return Math.max(8, options.fontSize ?? 72)
  let size = Math.floor(height / Math.max(lines.length * options.lineHeight, 1))
  const widest = Math.max(...lines.map((line) => line.length), 1)
  while (size > 8) {
    context.font = `${options.fontWeight} ${size}px ${options.fontFamily}`
    const measured = Math.max(...lines.map((line) => context.measureText(line).width + Math.max(0, line.length - 1) * options.letterSpacing))
    if (measured <= width * 0.88 && size * lines.length * options.lineHeight <= height * 0.88) break
    size -= Math.max(1, Math.ceil(widest / 18))
  }
  return size
}

export const createTextMask = (
  options: TextMaskOptions,
  rows: number,
  cols: number,
): BooleanMask => {
  const cacheKey = JSON.stringify([options, rows, cols])
  const cached = cache.get(cacheKey)
  if (cached) return cloneMask(cached)

  const resolution = 640
  const canvas = document.createElement('canvas')
  canvas.width = resolution
  canvas.height = resolution
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return Array.from({ length: rows }, () => Array(cols).fill(true))

  const lines = (options.text || '미로').replace(/[<>]/g, '').split(/\r?\n/).slice(0, 8)
  const fontSize = fitFont(context, lines, options, resolution, resolution)
  context.clearRect(0, 0, resolution, resolution)
  context.fillStyle = '#000'
  context.textAlign = options.align
  context.textBaseline = 'middle'
  context.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`

  const totalHeight = fontSize * options.lineHeight * lines.length
  const startY =
    options.verticalAlign === 'top'
      ? resolution * 0.08 + fontSize / 2
      : options.verticalAlign === 'bottom'
        ? resolution * 0.92 - totalHeight + fontSize / 2
        : (resolution - totalHeight) / 2 + fontSize / 2
  const x = options.align === 'left' ? resolution * 0.08 : options.align === 'right' ? resolution * 0.92 : resolution / 2

  lines.forEach((line, index) => {
    if (options.letterSpacing === 0) {
      context.fillText(line, x, startY + index * fontSize * options.lineHeight)
      return
    }
    const glyphs = [...line]
    const widths = glyphs.map((glyph) => context.measureText(glyph).width)
    const lineWidth = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, glyphs.length - 1) * options.letterSpacing
    let cursor = options.align === 'center' ? x - lineWidth / 2 : options.align === 'right' ? x - lineWidth : x
    glyphs.forEach((glyph, glyphIndex) => {
      context.textAlign = 'left'
      context.fillText(glyph, cursor, startY + index * fontSize * options.lineHeight)
      cursor += widths[glyphIndex] + options.letterSpacing
    })
  })

  const pixels = context.getImageData(0, 0, resolution, resolution).data
  const mask = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => {
      const px = Math.min(resolution - 1, Math.floor(((col + 0.5) / cols) * resolution))
      const py = Math.min(resolution - 1, Math.floor(((row + 0.5) / rows) * resolution))
      const ink = pixels[(py * resolution + px) * 4 + 3] > 48
      return options.mode === 'obstacle' ? !ink : ink
    }),
  )
  cache.set(cacheKey, cloneMask(mask))
  if (cache.size > 16) cache.delete(cache.keys().next().value!)
  return mask
}

export const clearTextMaskCache = () => cache.clear()
