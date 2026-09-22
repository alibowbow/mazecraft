import type { BooleanMask, ImageMaskOptions } from './types'

export const DEFAULT_IMAGE_OPTIONS: ImageMaskOptions = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  grayscale: true,
  threshold: 150,
  invert: false,
  smoothing: 1,
  noiseSize: 3,
  fillInterior: true,
  largestComponentOnly: true,
}

export const loadImageFile = (file: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('이미지 파일을 읽을 수 없습니다.'))
    }
    image.src = url
  })

const neighbors = (row: number, col: number, rows: number, cols: number) =>
  [
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1],
  ].filter(([nextRow, nextCol]) => nextRow >= 0 && nextCol >= 0 && nextRow < rows && nextCol < cols)

const connectedComponents = (mask: BooleanMask) => {
  const rows = mask.length
  const cols = mask[0]?.length ?? 0
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false))
  const components: Array<Array<[number, number]>> = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!mask[row][col] || seen[row][col]) continue
      const queue: Array<[number, number]> = [[row, col]]
      const component: Array<[number, number]> = []
      seen[row][col] = true
      for (let index = 0; index < queue.length; index += 1) {
        const [currentRow, currentCol] = queue[index]
        component.push([currentRow, currentCol])
        for (const [nextRow, nextCol] of neighbors(currentRow, currentCol, rows, cols)) {
          if (mask[nextRow][nextCol] && !seen[nextRow][nextCol]) {
            seen[nextRow][nextCol] = true
            queue.push([nextRow, nextCol])
          }
        }
      }
      components.push(component)
    }
  }
  return components
}

const cleanMask = (mask: BooleanMask, options: ImageMaskOptions) => {
  const components = connectedComponents(mask)
  if (!components.length) return mask
  const accepted = options.largestComponentOnly
    ? [components.reduce((largest, component) => (component.length > largest.length ? component : largest))]
    : components.filter((component) => component.length >= options.noiseSize)
  const cleaned = Array.from({ length: mask.length }, () => Array(mask[0].length).fill(false))
  accepted.flat().forEach(([row, col]) => {
    cleaned[row][col] = true
  })
  return cleaned
}

const fillInterior = (mask: BooleanMask) => {
  const rows = mask.length
  const cols = mask[0]?.length ?? 0
  const outside = Array.from({ length: rows }, () => Array(cols).fill(false))
  const queue: Array<[number, number]> = []
  for (let row = 0; row < rows; row += 1) {
    for (const col of [0, cols - 1]) if (!mask[row]?.[col] && !outside[row]?.[col]) queue.push([row, col])
  }
  for (let col = 0; col < cols; col += 1) {
    for (const row of [0, rows - 1]) if (!mask[row]?.[col] && !outside[row]?.[col]) queue.push([row, col])
  }
  queue.forEach(([row, col]) => {
    outside[row][col] = true
  })
  for (let index = 0; index < queue.length; index += 1) {
    const [row, col] = queue[index]
    neighbors(row, col, rows, cols).forEach(([nextRow, nextCol]) => {
      if (!mask[nextRow][nextCol] && !outside[nextRow][nextCol]) {
        outside[nextRow][nextCol] = true
        queue.push([nextRow, nextCol])
      }
    })
  }
  return mask.map((row, rowIndex) => row.map((value, colIndex) => value || !outside[rowIndex][colIndex]))
}

export const createImageMask = (
  image: CanvasImageSource,
  options: ImageMaskOptions,
  rows: number,
  cols: number,
  preserveGridAspect = false,
): BooleanMask => {
  const resolution = Math.max(256, Math.min(1024, Math.max(rows, cols) * 6))
  const canvas = document.createElement('canvas')
  canvas.width = preserveGridAspect ? Math.max(1, Math.round(resolution * cols / Math.max(rows, cols))) : resolution
  canvas.height = preserveGridAspect ? Math.max(1, Math.round(resolution * rows / Math.max(rows, cols))) : resolution
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return Array.from({ length: rows }, () => Array(cols).fill(true))
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = options.smoothing > 0
  context.imageSmoothingQuality = options.smoothing > 1 ? 'high' : 'medium'
  const sourceWidth = 'width' in image ? Number(image.width) : resolution
  const sourceHeight = 'height' in image ? Number(image.height) : resolution
  const baseScale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight) * options.scale
  const width = sourceWidth * baseScale
  const height = sourceHeight * baseScale
  context.translate(canvas.width / 2 + options.offsetX * canvas.width, canvas.height / 2 + options.offsetY * canvas.height)
  context.rotate((options.rotation * Math.PI) / 180)
  context.drawImage(image, -width / 2, -height / 2, width, height)
  context.setTransform(1, 0, 0, 1, 0, 0)

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let mask = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => {
      const px = Math.min(canvas.width - 1, Math.floor(((col + 0.5) / cols) * canvas.width))
      const py = Math.min(canvas.height - 1, Math.floor(((row + 0.5) / rows) * canvas.height))
      const offset = (py * canvas.width + px) * 4
      const luminance = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
      const sample = options.grayscale
        ? luminance
        : Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2])
      const visible = pixels[offset + 3] > 24 && sample < options.threshold
      return options.invert ? !visible : visible
    }),
  )
  mask = cleanMask(mask, options)
  return options.fillInterior ? fillInterior(mask) : mask
}
