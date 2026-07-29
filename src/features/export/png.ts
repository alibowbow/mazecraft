import type { CellPosition, MazeProject } from '../../core/maze/types'
import { renderMazeSvg } from './svg'

export interface MazePngOptions {
  scale?: 1 | 2 | 4
  transparentBackground?: boolean
  includeEndpoints?: boolean
  includeSolution?: boolean
  solutionPath?: CellPosition[]
}

const MAX_PNG_DIMENSION = 16_384
const MAX_PNG_PIXELS = 64_000_000

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 이미지를 만들 수 없습니다.'))
    }, 'image/png')
  })
}

function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    )
    image.addEventListener(
      'load',
      () => {
        URL.revokeObjectURL(objectUrl)
        resolve(image)
      },
      { once: true },
    )
    image.addEventListener(
      'error',
      () => {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('미로 이미지를 렌더링할 수 없습니다.'))
      },
      { once: true },
    )
    image.src = objectUrl
  })
}

export async function exportMazePng(
  project: MazeProject,
  options: MazePngOptions = {},
): Promise<Blob> {
  const scale = options.scale ?? project.exportSettings.scale
  const width = Math.max(1, Math.round(project.canvas.width * scale))
  const height = Math.max(1, Math.round(project.canvas.height * scale))
  if (
    width > MAX_PNG_DIMENSION ||
    height > MAX_PNG_DIMENSION ||
    width * height > MAX_PNG_PIXELS
  ) {
    throw new Error(
      'PNG 크기가 브라우저의 안전한 렌더링 한도를 넘습니다. 배율이나 캔버스 크기를 줄여 주세요.',
    )
  }
  const svg = renderMazeSvg(project, {
    includeBackground: !options.transparentBackground,
    transparentBackground: options.transparentBackground,
    includeEndpoints:
      options.includeEndpoints ?? project.exportSettings.includeEndpoints,
    includeSolution:
      options.includeSolution ?? project.exportSettings.includeSolution,
    solutionPath: options.solutionPath,
  })
  const image = await loadSvg(svg)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D를 사용할 수 없습니다.')
  context.drawImage(image, 0, 0, width, height)
  return canvasBlob(canvas)
}

export async function exportCanvasPng(
  source: HTMLCanvasElement,
  scale: 1 | 2 | 4 = 1,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, source.width * scale)
  canvas.height = Math.max(1, source.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D를 사용할 수 없습니다.')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas)
}
