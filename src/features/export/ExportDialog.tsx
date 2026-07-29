import { useMemo, useState } from 'react'
import { Download, FileCode2, FileImage, FileJson2, Printer } from 'lucide-react'
import type { MazeProject } from '../../core/maze/types'
import { solveMaze } from '../../core/maze/solver'
import { Dialog } from '../dialogs/Dialog'
import { downloadBlob } from './download'
import { exportMazePng } from './png'
import { createProjectFile, projectFileName, sanitizeFilename } from './projectFile'
import { openPrintPreview } from './print'
import { createStandaloneHtml } from './standaloneHtml'
import { mazeSvgBlob, renderMazeSvg } from './svg'

type ExportKind = 'png' | 'svg' | 'print' | 'project' | 'html'

interface ExportDialogProps {
  project: MazeProject
  valid: boolean
  onClose: () => void
}

const labels: Array<[ExportKind, string, typeof FileImage]> = [
  ['png', 'PNG', FileImage],
  ['svg', 'SVG', FileCode2],
  ['print', '인쇄', Printer],
  ['project', '프로젝트', FileJson2],
  ['html', '실행 HTML', Download],
]

export function ExportDialog({ project, valid, onClose }: ExportDialogProps) {
  const [kind, setKind] = useState<ExportKind>('png')
  const [scale, setScale] = useState<1 | 2 | 4>(project.exportSettings.scale)
  const [transparent, setTransparent] = useState(project.exportSettings.transparentBackground)
  const [endpoints, setEndpoints] = useState(project.exportSettings.includeEndpoints)
  const [solution, setSolution] = useState(project.exportSettings.includeSolution)
  const [printOrientation, setPrintOrientation] = useState(project.exportSettings.printOrientation)
  const [printTitle, setPrintTitle] = useState(project.exportSettings.printTitle)
  const [printNameField, setPrintNameField] = useState(project.exportSettings.printNameField)
  const [printAnswerSheet, setPrintAnswerSheet] = useState(project.exportSettings.printAnswerSheet)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = useMemo(() => solveMaze(project.mazeGraph, project.startCell, project.endCell).path, [project])
  const preview = useMemo(
    () =>
      renderMazeSvg(project, {
        includeBackground: !transparent,
        transparentBackground: transparent,
        includeEndpoints: endpoints,
        includeSolution: solution,
        solutionPath: path,
      }),
    [endpoints, path, project, solution, transparent],
  )

  const runExport = async () => {
    setBusy(true)
    setError('')
    const filename = sanitizeFilename(project.title)
    try {
      if (kind === 'png') {
        downloadBlob(await exportMazePng(project, { scale, transparentBackground: transparent, includeEndpoints: endpoints, includeSolution: solution, solutionPath: path }), `${filename}.png`)
      } else if (kind === 'svg') {
        downloadBlob(mazeSvgBlob(project, { includeBackground: !transparent, transparentBackground: transparent, includeEndpoints: endpoints, includeSolution: solution, solutionPath: path }), `${filename}.svg`)
      } else if (kind === 'project') {
        downloadBlob(createProjectFile(project), projectFileName(project))
      } else if (kind === 'html') {
        downloadBlob(new Blob([createStandaloneHtml(project)], { type: 'text/html;charset=utf-8' }), `${filename}-play.html`)
      } else {
        openPrintPreview(project, {
          orientation: printOrientation,
          includeTitle: printTitle,
          includeNameField: printNameField,
          includeAnswerSheet: printAnswerSheet,
          solutionPath: path,
        })
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '파일을 내보내는 중 문제가 발생했습니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="내보내기"
      onClose={onClose}
      footer={<><button className="button secondary" onClick={onClose}>닫기</button><button className="button" disabled={busy} onClick={runExport}><Download size={17} />{busy ? '만드는 중…' : kind === 'print' ? '인쇄 미리보기' : '파일 저장'}</button></>}
    >
      {!valid && <div className="notice error">검증 문제를 해결하지 않고 내보내면 정답이 없거나 벽이 끊긴 결과가 될 수 있습니다.</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="export-kind-grid">
        {labels.map(([value, label, Icon]) => (
          <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}><Icon size={18} />{label}</button>
        ))}
      </div>
      {(kind === 'png' || kind === 'svg') && (
        <>
          <div className="export-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          {kind === 'png' && <label className="field"><span>해상도</span><select value={scale} onChange={(event) => setScale(Number(event.target.value) as 1 | 2 | 4)}><option value={1}>1배</option><option value={2}>2배</option><option value={4}>4배</option></select></label>}
          <div className="settings-row">
            <label className="toggle-row compact"><input type="checkbox" checked={transparent} onChange={(event) => setTransparent(event.target.checked)} /><span>배경 투명</span></label>
            <label className="toggle-row compact"><input type="checkbox" checked={endpoints} onChange={(event) => setEndpoints(event.target.checked)} /><span>시작·종료점</span></label>
          </div>
          <label className="toggle-row compact"><input type="checkbox" checked={solution} onChange={(event) => setSolution(event.target.checked)} /><span>정답 경로 포함</span></label>
        </>
      )}
      {kind === 'print' && (
        <div className="settings-stack">
          <label className="field">
            <span>용지 방향</span>
            <select value={printOrientation} onChange={(event) => setPrintOrientation(event.target.value as 'portrait' | 'landscape')}>
              <option value="portrait">A4 세로</option>
              <option value="landscape">A4 가로</option>
            </select>
          </label>
          <label className="toggle-row compact"><input type="checkbox" checked={printTitle} onChange={(event) => setPrintTitle(event.target.checked)} /><span>제목 포함</span></label>
          <label className="toggle-row compact"><input type="checkbox" checked={printNameField} onChange={(event) => setPrintNameField(event.target.checked)} /><span>이름 작성란</span></label>
          <label className="toggle-row compact"><input type="checkbox" checked={printAnswerSheet} onChange={(event) => setPrintAnswerSheet(event.target.checked)} /><span>정답지 별도 페이지</span></label>
          <div className="notice">인쇄 미리보기를 새 창에서 연 뒤 브라우저 인쇄 대화상자에서 실제 용지와 여백을 확인합니다.</div>
        </div>
      )}
      {kind === 'project' && <div className="notice">다시 편집할 수 있는 JSON 기반 .mazecraft 파일입니다. 이미지와 고스트 기록도 함께 보존됩니다.</div>}
      {kind === 'html' && <div className="notice">편집 기능 없이 인터넷 연결이 없어도 플레이할 수 있는 단일 HTML 파일입니다. 시크릿 콘텐츠와 제작자 고스트가 파일 안에 포함됩니다.</div>}
    </Dialog>
  )
}
