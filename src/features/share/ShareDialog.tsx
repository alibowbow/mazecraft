import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, QrCode, Share2 } from 'lucide-react'
import type { MazeProject } from '../../core/maze/types'
import { createQrDataUrl } from './qr'
import { createShareLink, createSharePayload } from './codec'
import { copyShareLink, shareUrl } from './webShare'
import { Dialog } from '../dialogs/Dialog'

interface ShareDialogProps {
  project: MazeProject
  valid: boolean
  onClose: () => void
}

export function ShareDialog({ project, valid, onClose }: ShareDialogProps) {
  const [includeSolution, setIncludeSolution] = useState(false)
  const [includeReplay, setIncludeReplay] = useState(Boolean(project.creatorReplay))
  const [allowRemix, setAllowRemix] = useState(project.remixAllowed)
  const [qr, setQr] = useState('')
  const [qrFailed, setQrFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const result = useMemo(
    () =>
      createShareLink(
        createSharePayload(
          { ...project, remixAllowed: allowRemix },
          {
            includeSolution,
            includeCreatorReplay: includeReplay,
            allowRemix,
            creatorName: project.creatorDisplayName || undefined,
          },
        ),
      ),
    [allowRemix, includeReplay, includeSolution, project],
  )

  useEffect(() => {
    let cancelled = false
    setQr('')
    setQrFailed(false)
    setError('')
    if (result.ok) {
      void createQrDataUrl(result.url, { width: 360, margin: 1 })
        .then((dataUrl) => {
          if (!cancelled) setQr(dataUrl)
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setQrFailed(true)
            setError(
              cause instanceof Error
                ? cause.message
                : 'QR 코드를 만들 수 없습니다.',
            )
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [result])

  const copy = async () => {
    if (!result.ok) return
    setError('')
    try {
      await copyShareLink(result.url)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '링크를 복사할 수 없습니다.',
      )
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const nativeShare = async () => {
    if (!result.ok) return
    setError('')
    try {
      const status = await shareUrl({ title: project.title, text: '이 미로에 도전해보세요.', url: result.url })
      if (status === 'unavailable') {
        setError('이 브라우저에서는 기기 공유를 지원하지 않습니다. 링크 복사를 이용해 주세요.')
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(
        cause instanceof Error ? cause.message : '기기 공유를 사용할 수 없습니다.',
      )
    }
  }

  return (
    <Dialog title="미로 공유" onClose={onClose}>
      {!valid && <div className="notice error">검증을 통과하지 않은 미로입니다. 링크는 만들 수 있지만 상대방이 완주하지 못할 수 있습니다.</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {result.ok ? (
        <>
          <div className="qr-card">{qr ? <img src={qr} alt="공유 링크 QR 코드" /> : qrFailed ? <span>QR 코드를 만들 수 없습니다.</span> : <QrCode size={48} aria-label="QR 코드 생성 중" />}</div>
          <label className="field">
            <span>공유 링크 · {result.encodedLength.toLocaleString()}자</span>
            <input value={result.url} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="settings-row">
            <button className="button" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? '복사됨' : '링크 복사'}</button>
            <button className="button secondary" onClick={nativeShare}><Share2 size={17} />기기에서 공유</button>
          </div>
          <button className="button secondary" onClick={() => window.open(result.url, '_blank', 'noopener,noreferrer')}><ExternalLink size={17} />새 창에서 플레이 테스트</button>
        </>
      ) : (
        <div className="notice error">{result.message}</div>
      )}
      <div className="settings-stack">
        <label className="toggle-row"><input type="checkbox" checked={allowRemix} onChange={(event) => setAllowRemix(event.target.checked)} /><span><strong>리믹스 허용</strong><small>완주 후 복제본을 만들어 편집할 수 있습니다.</small></span></label>
        <label className="toggle-row"><input type="checkbox" checked={includeReplay} disabled={!project.creatorReplay} onChange={(event) => setIncludeReplay(event.target.checked)} /><span><strong>제작자 고스트 포함</strong><small>{project.creatorReplay ? '플레이 기록을 링크에 함께 담습니다.' : '저장된 플레이 테스트 기록이 없습니다.'}</small></span></label>
        <label className="toggle-row"><input type="checkbox" checked={includeSolution} onChange={(event) => setIncludeSolution(event.target.checked)} /><span><strong>해답 포함</strong><small>정답 경로 보기 기능을 공유 데이터에 허용합니다.</small></span></label>
      </div>
    </Dialog>
  )
}
