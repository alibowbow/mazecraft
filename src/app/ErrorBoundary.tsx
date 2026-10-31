import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { ClipboardCopy, Home, RotateCw } from 'lucide-react'
import { BrandMark } from '../components/BrandMark'
import { errorReport } from './appInfo'
import { isChunkLoadError, reloadForStaleChunk } from './chunkRecovery'

interface Props {
  children: ReactNode
  /** A new key (the next screen) clears a caught error. */
  resetKey?: unknown
  /** Leave the failed screen inside the app. Without it the home is reloaded. */
  onHome?: () => void
  /** Replaces the full-screen recovery view, e.g. for a dialog. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State { error: Error | null }

/**
 * Keeps one failing screen from blanking the whole app. Work is stored as it
 * is made, so the recovery view can always offer a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // React logs the error itself; a missing file after a redeploy only needs a reload.
    if (isChunkLoadError(error)) reloadForStaleChunk()
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  private reset = (): void => this.setState({ error: null })

  private home = (): void => {
    if (this.props.onHome) {
      this.props.onHome()
      this.reset()
      return
    }
    window.location.assign(window.location.pathname + window.location.search)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return <RecoveryScreen error={error} onHome={this.home} />
  }
}

export function RecoveryScreen({ error, onHome }: { error: Error; onHome: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const stale = isChunkLoadError(error)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(errorReport(error))
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <main className="recovery-screen" role="alert" aria-labelledby="recovery-title">
      <div className="recovery-card">
        <BrandMark size={34} />
        <h1 id="recovery-title">{stale ? '새 버전을 불러와야 합니다' : '화면을 표시하지 못했습니다'}</h1>
        <p>
          {stale
            ? '앱이 업데이트되어 화면 파일을 다시 받아야 합니다. 새로고침해 주세요.'
            : '만든 미로와 기록은 이 기기에 저장되어 있습니다. 새로고침하면 대부분 해결됩니다.'}
        </p>
        <div className="recovery-actions">
          <button className="button" type="button" onClick={() => window.location.reload()}><RotateCw size={16} />새로고침</button>
          <button className="button secondary" type="button" onClick={onHome}><Home size={16} />홈으로</button>
        </div>
        <details className="recovery-details">
          <summary>오류 정보</summary>
          <code>{error.message || error.name}</code>
          <button className="button ghost small" type="button" onClick={() => void copy()}>
            <ClipboardCopy size={14} />
            {copied === 'done' ? '복사했습니다' : copied === 'failed' ? '복사하지 못했습니다' : '오류 정보 복사'}
          </button>
        </details>
      </div>
    </main>
  )
}
