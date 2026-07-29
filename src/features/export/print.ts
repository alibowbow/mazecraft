import type { CellPosition, MazeProject } from '../../core/maze/types'
import { escapeHtml } from './standaloneHtml'
import { renderMazeSvg } from './svg'

export interface PrintMazeOptions {
  orientation?: 'portrait' | 'landscape'
  includeTitle?: boolean
  includeNameField?: boolean
  includeAnswerSheet?: boolean
  solutionPath?: CellPosition[]
}

export function createPrintHtml(
  project: MazeProject,
  options: PrintMazeOptions = {},
): string {
  const orientation =
    options.orientation ?? project.exportSettings.printOrientation
  const includeTitle =
    options.includeTitle ?? project.exportSettings.printTitle
  const includeName =
    options.includeNameField ?? project.exportSettings.printNameField
  const includeAnswer =
    options.includeAnswerSheet ?? project.exportSettings.printAnswerSheet
  const maze = renderMazeSvg(project, {
    includeEndpoints: true,
    includeBackground: true,
  })
  const answer = includeAnswer
    ? renderMazeSvg(project, {
        includeEndpoints: true,
        includeBackground: true,
        includeSolution: true,
        solutionPath: options.solutionPath,
      })
    : ''

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>${escapeHtml(project.title)} 인쇄</title>
<style>
  @page{size:A4 ${orientation};margin:14mm}
  *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .sheet{width:100%;height:calc(100vh - 1mm);display:grid;grid-template-rows:auto minmax(0,1fr);gap:8mm;page-break-after:always;break-after:page}
  .sheet:last-child{page-break-after:auto;break-after:auto}
  header{display:flex;align-items:end;justify-content:space-between;gap:16px;min-height:16mm}
  h1{font-size:20pt;margin:0}.name{font-size:11pt;white-space:nowrap;border-bottom:1px solid #333;min-width:55mm;padding:0 2mm 2mm}
  .maze{display:grid;place-items:center;min-height:0}.maze svg{width:100%;height:100%;max-height:100%;object-fit:contain}
  .answer-label{font-size:10pt;color:#555;margin:.2rem 0 0}
  @media screen{body{background:#dce1e8;padding:20px}.sheet{width:min(100%,210mm);height:${
    orientation === 'portrait' ? '297mm' : '210mm'
  };margin:0 auto 20px;padding:14mm;background:#fff;box-shadow:0 5px 24px #0002}}
</style>
</head>
<body>
  <section class="sheet">
    <header><div>${
      includeTitle ? `<h1>${escapeHtml(project.title)}</h1>` : ''
    }</div>${includeName ? '<div class="name">이름:</div>' : ''}</header>
    <div class="maze">${maze}</div>
  </section>
  ${
    includeAnswer
      ? `<section class="sheet"><header><div><h1>${escapeHtml(
          project.title,
        )} · 정답</h1><p class="answer-label">강조된 선이 최단 경로입니다.</p></div></header><div class="maze">${answer}</div></section>`
      : ''
  }
</body>
</html>`
}

export function openPrintPreview(
  project: MazeProject,
  options: PrintMazeOptions = {},
): Window {
  const blob = new Blob([createPrintHtml(project, options)], {
    type: 'text/html;charset=utf-8',
  })
  const objectUrl = URL.createObjectURL(blob)
  const preview = window.open(objectUrl, '_blank')
  if (!preview) {
    URL.revokeObjectURL(objectUrl)
    throw new Error('인쇄 미리보기 팝업을 열 수 없습니다.')
  }
  preview.opener = null
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  return preview
}
