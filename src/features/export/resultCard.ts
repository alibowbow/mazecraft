import type { MazeProject } from '../../core/maze/types'
import { renderMazeSvg } from './svg'

export interface ResultCardData {
  durationMs: number
  moves: number
  wrongTurns: number
  hintCount: number
  creatorDifferenceMs?: number | null
  secretPreview?: string
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1_000)
  const hundredths = Math.floor((safe % 1_000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
    2,
    '0',
  )}.${String(hundredths).padStart(2, '0')}`
}

function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    )
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('결과 카드용 미로를 그릴 수 없습니다.'))
    }
    image.src = objectUrl
  })
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('결과 카드를 PNG로 만들 수 없습니다.'))
    }, 'image/png')
  })
}

function drawTruncatedText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned) return
  let result = cleaned
  while (
    result.length > 1 &&
    context.measureText(`${result}…`).width > maxWidth
  ) {
    result = result.slice(0, -1)
  }
  context.fillText(result === cleaned ? result : `${result}…`, x, y)
}

export async function createResultCardPng(
  project: MazeProject,
  data: ResultCardData,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 630
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D를 사용할 수 없습니다.')

  context.fillStyle = '#f2f4f7'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#ffffff'
  context.roundRect(34, 34, 1132, 562, 28)
  context.fill()

  context.fillStyle = '#647084'
  context.font = '600 20px system-ui, sans-serif'
  context.fillText('MAZECRAFT · 완주 기록', 78, 94)
  context.fillStyle = '#172033'
  context.font = '750 42px system-ui, sans-serif'
  drawTruncatedText(context, project.title, 78, 153, 510)
  context.font = '800 78px ui-monospace, monospace'
  context.fillText(formatDuration(data.durationMs), 78, 264)

  context.font = '600 23px system-ui, sans-serif'
  context.fillStyle = '#657087'
  context.fillText(
    `이동 ${Math.max(0, data.moves)}회  ·  잘못 든 길 ${Math.max(
      0,
      data.wrongTurns,
    )}회  ·  힌트 ${Math.max(0, data.hintCount)}회`,
    78,
    322,
  )
  if (typeof data.creatorDifferenceMs === 'number') {
    context.fillStyle =
      data.creatorDifferenceMs <= 0 ? '#16794b' : '#b14b32'
    context.font = '700 24px system-ui, sans-serif'
    context.fillText(
      `제작자보다 ${formatDuration(
        Math.abs(data.creatorDifferenceMs),
      )} ${data.creatorDifferenceMs <= 0 ? '빠름' : '느림'}`,
      78,
      371,
    )
  }
  if (data.secretPreview) {
    context.fillStyle = '#172033'
    context.font = '600 23px system-ui, sans-serif'
    drawTruncatedText(context, `“${data.secretPreview}”`, 78, 456, 500)
  }
  context.fillStyle = '#3458eb'
  context.fillRect(78, 518, 70, 6)
  context.fillStyle = '#657087'
  context.font = '500 19px system-ui, sans-serif'
  context.fillText('풀어야만 열리는 이야기', 165, 527)

  const image = await loadSvg(
    renderMazeSvg(project, {
      includeBackground: true,
      includeEndpoints: true,
    }),
  )
  context.save()
  context.beginPath()
  context.roundRect(635, 76, 474, 474, 20)
  context.clip()
  context.fillStyle = '#ffffff'
  context.fillRect(635, 76, 474, 474)
  const ratio = Math.min(
    438 / Math.max(1, image.naturalWidth),
    438 / Math.max(1, image.naturalHeight),
  )
  const width = image.naturalWidth * ratio
  const height = image.naturalHeight * ratio
  context.drawImage(
    image,
    635 + (474 - width) / 2,
    76 + (474 - height) / 2,
    width,
    height,
  )
  context.restore()

  return toPng(canvas)
}
