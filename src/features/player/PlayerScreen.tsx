import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  ExternalLink,
  Scan,
  Flag,
  Lightbulb,
  Pause,
  Play,
  RefreshCw,
  Route,
  RotateCcw,
  Share2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { MazeCanvas, type MazeCanvasHandle } from '../../components/MazeCanvas'
import { DPad } from '../../components/DPad'
import { solveMaze } from '../../core/maze/solver'
import type { CreatorReplay, MazeProject, MoveDirection } from '../../core/maze/types'
import {
  MazeAnimationController,
  type MazeAnimationSnapshot,
} from '../../renderer/animationController'
import { renderModelFromProject } from '../../renderer/types'
import { createResultCardPng } from '../export/resultCard'
import { downloadBlob } from '../export/download'
import { createShareLink, createSharePayload } from '../share'
import { compareReplayTimes, createReplay, sampleReplay } from '../replay/replay'
import { revealProgress, safeSecretLink, secretText } from '../secretReveal/reveal'
import { copyShareLink } from '../share/webShare'
import { dailyLink, dailyShareText, type DailyInfo } from '../daily/dailyMaze'
import {
  applyPlayerMove,
  createPlayerSession,
  formatDuration,
  isTimeAttackExpired,
  setPlayerPaused,
  timeAttackLimitMs,
  timeAttackRemainingMs,
  usePlayerHint,
  type PlayerSession,
} from './playerEngine'

interface PlayerScreenProps {
  project: MazeProject
  shared?: boolean
  recordCreator?: boolean
  allowSolution?: boolean
  onExit: () => void
  onRemix?: (project: MazeProject) => void
  onCreatorReplay?: (replay: CreatorReplay) => void
  /**
   * Today's maze: its date and setting, the days in a row it was finished
   * (now, and once today is finished) and today's best. Its records live in
   * the daily store, not per maze.
   */
  daily?: { info: DailyInfo; streak: number; finishedStreak: number; best: number | null }
  /** A finish, for records kept outside the player (the daily streak). */
  onFinish?: (elapsedMs: number) => void
}

const parseVisited = (keys: string[]) =>
  keys.map((key) => {
    const [row, col] = key.split(':').map(Number)
    return { row, col }
  })

const personalBestKey = (project: MazeProject) => `mazecraft:best:${project.id}`

/** Records are optional: blocked or full browser storage must never stop a game. */
const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStored = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage is disabled or full; the game itself is unaffected.
  }
}

const recordAttempt = (projectId: string, attempt: Record<string, unknown>): void => {
  const key = `mazecraft:attempts:${projectId}`
  let recent: unknown[] = []
  try {
    const parsed: unknown = JSON.parse(readStored(key) ?? '[]')
    if (Array.isArray(parsed)) recent = parsed
  } catch {
    // A damaged history starts over.
  }
  writeStored(key, JSON.stringify([attempt, ...recent].slice(0, 10)))
}

const playTone = (kind: 'move' | 'complete') => {
  if (typeof AudioContext === 'undefined') return
  const context = new AudioContext()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = kind === 'complete' ? 660 : 280
  gain.gain.setValueAtTime(0.035, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (kind === 'complete' ? 0.35 : 0.06))
  oscillator.connect(gain).connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + (kind === 'complete' ? 0.36 : 0.07))
  oscillator.addEventListener('ended', () => void context.close(), { once: true })
}

const revealStyle = (progress: number, animation: MazeProject['secretReveal']['animation']) => {
  const clamped = Math.max(0, Math.min(1, progress))
  if (animation === 'zoom') return { opacity: clamped, transform: `scale(${0.72 + clamped * 0.28})` }
  if (animation === 'unmask') return { opacity: 1, clipPath: `inset(${(1 - clamped) * 50}% round 18px)` }
  if (animation === 'puzzle') return { opacity: clamped >= 1 ? 1 : Math.max(0.08, clamped), filter: `blur(${Math.max(0, (1 - clamped) * 13)}px)` }
  if (animation === 'none') return { opacity: clamped > 0 ? 1 : 0 }
  return { opacity: clamped }
}

export function PlayerScreen({
  project,
  shared,
  recordCreator,
  allowSolution = false,
  onExit,
  onRemix,
  onCreatorReplay,
  daily,
  onFinish,
}: PlayerScreenProps) {
  const canvasRef = useRef<MazeCanvasHandle>(null)
  const [session, setSession] = useState<PlayerSession>(() => createPlayerSession(project.startCell))
  const [started, setStarted] = useState(false)
  const [withGhost, setWithGhost] = useState(false)
  const [sound, setSound] = useState(project.gameRules.soundEnabled)
  const [now, setNow] = useState(performance.now())
  const [hintCells, setHintCells] = useState<Array<{ row: number; col: number }>>([])
  const [showSolution, setShowSolution] = useState(false)
  const [solutionAnimation, setSolutionAnimation] =
    useState<MazeAnimationSnapshot | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const [personalBest, setPersonalBest] = useState<number | null>(() => {
    if (daily) return daily.best
    const value = Number(readStored(personalBestKey(project)) ?? Number.NaN)
    return Number.isFinite(value) && value > 0 ? value : null
  })
  const [shareState, setShareState] = useState<'copied' | 'failed' | null>(null)
  const completionHandled = useRef(false)
  const timeoutHandled = useRef(false)
  const solutionControllerRef = useRef<MazeAnimationController | null>(null)
  const solution = useMemo(
    () => solveMaze(project.mazeGraph, project.startCell, project.endCell).path,
    [project],
  )
  const model = useMemo(() => renderModelFromProject(project), [project])
  const elapsed = session.completed
    ? session.elapsedMs
    : session.pausedAt !== null
      ? Math.max(0, session.pausedAt - session.startedAt - session.pausedMs)
      : Math.max(0, now - session.startedAt - session.pausedMs)
  const limitMs = timeAttackLimitMs(project.gameRules)
  const displayedElapsed = timedOut && limitMs !== null ? limitMs : elapsed
  const remainingMs = timeAttackRemainingMs(project.gameRules, displayedElapsed)
  const ghost = withGhost ? sampleReplay(project.creatorReplay, elapsed) : null
  const progress = revealProgress(
    project,
    session.visited,
    solution,
    session.stats.checkpoints.length,
    session.completed,
  )
  const creatorDifference = compareReplayTimes(session.elapsedMs, project.creatorReplay)

  useEffect(() => {
    solutionControllerRef.current = new MazeAnimationController({
      onFrame: setSolutionAnimation,
    })
    return () => solutionControllerRef.current?.dispose()
  }, [])

  useEffect(() => {
    solutionControllerRef.current?.cancel()
    setShowSolution(false)
    setSolutionAnimation(null)
  }, [project.id, project.seed])

  useEffect(() => {
    if (!started || timedOut || session.completed || session.pausedAt !== null) return
    const interval = window.setInterval(() => setNow(performance.now()), 40)
    return () => window.clearInterval(interval)
  }, [session.completed, session.pausedAt, started, timedOut])

  const endTimeAttack = useCallback(
    (expiredAt = performance.now()) => {
      if (limitMs === null || session.completed || timedOut) return
      setTimedOut(true)
      setHintCells([])
      setSession((current) =>
        current.completed
          ? current
          : {
              ...current,
              elapsedMs: limitMs,
              pausedAt: expiredAt,
            },
      )
    },
    [limitMs, session.completed, timedOut],
  )

  useEffect(() => {
    if (
      !started ||
      timedOut ||
      session.completed ||
      session.pausedAt !== null ||
      !isTimeAttackExpired(project.gameRules, elapsed)
    ) {
      return
    }
    endTimeAttack()
  }, [
    elapsed,
    endTimeAttack,
    project.gameRules,
    session.completed,
    session.pausedAt,
    started,
    timedOut,
  ])

  useEffect(() => {
    if (!timedOut || timeoutHandled.current) return
    timeoutHandled.current = true
    recordAttempt(project.id, {
      completedAt: new Date().toISOString(),
      durationMs: limitMs ?? elapsed,
      moves: session.stats.moves,
      hints: session.stats.hintsUsed,
      timedOut: true,
    })
  }, [elapsed, limitMs, project.id, session.stats.hintsUsed, session.stats.moves, timedOut])

  useEffect(() => {
    if (!session.completed || completionHandled.current) return
    completionHandled.current = true
    if (sound) playTone('complete')
    if (personalBest === null || session.elapsedMs < personalBest) {
      // A new maze every day would leave a key per day behind, so the daily
      // best is kept by onFinish in its own bounded record instead.
      if (!daily) writeStored(personalBestKey(project), String(session.elapsedMs))
      setPersonalBest(session.elapsedMs)
    }
    if (!daily) {
      recordAttempt(project.id, {
        completedAt: new Date().toISOString(),
        durationMs: session.elapsedMs,
        moves: session.stats.moves,
        hints: session.stats.hintsUsed,
      })
    }
    if (recordCreator) onCreatorReplay?.(createReplay(session.frames, true))
    onFinish?.(session.elapsedMs)
  }, [daily, onCreatorReplay, onFinish, personalBest, project, recordCreator, session, sound])

  useEffect(() => {
    if (!shareState) return
    const timer = window.setTimeout(() => setShareState(null), 2200)
    return () => window.clearTimeout(timer)
  }, [shareState])

  const move = useCallback(
    (direction: MoveDirection) => {
      if (!started || timedOut || session.pausedAt !== null || session.completed) return
      const time = performance.now()
      const elapsedAtMove = Math.max(0, time - session.startedAt - session.pausedMs)
      if (isTimeAttackExpired(project.gameRules, elapsedAtMove)) {
        endTimeAttack(time)
        return
      }
      const next = applyPlayerMove(
        session,
        project.mazeGraph,
        direction,
        project.endCell,
        solution,
        project.checkpoints,
        project.collectibles,
        time,
      )
      if (next !== session) {
        setSession(next)
        setNow(time)
        setHintCells([])
        if (sound) playTone('move')
      }
    },
    [endTimeAttack, project, session, solution, sound, started, timedOut],
  )

  const begin = (ghostMode: boolean) => {
    solutionControllerRef.current?.cancel()
    setShowSolution(false)
    setSolutionAnimation(null)
    completionHandled.current = false
    timeoutHandled.current = false
    setTimedOut(false)
    setWithGhost(ghostMode)
    setSession(createPlayerSession(project.startCell))
    setStarted(true)
    setNow(performance.now())
    window.setTimeout(() => canvasRef.current?.fit(), 0)
  }

  const restart = () => begin(withGhost)

  const showHint = () => {
    if (timedOut || session.stats.hintsUsed >= project.gameRules.allowedHints) return
    solutionControllerRef.current?.cancel()
    setShowSolution(false)
    setSolutionAnimation(null)
    const route = solveMaze(project.mazeGraph, session.position, project.endCell).path
    if (!route.length) return
    setSession((current) => usePlayerHint(current, project.gameRules.allowedHints))
    setHintCells(route.slice(1, 6))
    window.setTimeout(() => setHintCells([]), 1800)
  }

  const saveResult = async () => {
    const blob = await createResultCardPng(project, {
      durationMs: session.elapsedMs,
      moves: session.stats.moves,
      wrongTurns: session.stats.wrongTurns,
      hintCount: session.stats.hintsUsed,
      creatorDifferenceMs: creatorDifference,
      secretPreview: secretText(project).slice(0, 100),
    })
    downloadBlob(blob, `${project.title.replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'maze'}-result.png`)
  }

  const copyShare = async () => {
    try {
      if (daily) {
        // Today's result with a link that opens the same maze for a friend today.
        const text = dailyShareText(daily.info, {
          time: formatDuration(session.elapsedMs),
          hints: session.stats.hintsUsed,
          streak: daily.finishedStreak,
        })
        const url = dailyLink()
        const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
        if (touch && typeof navigator.share === 'function') {
          try {
            await navigator.share({ title: project.title, text, url })
            return
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return
          }
        }
        await copyShareLink(`${text}\n${url}`)
      } else {
        const link = createShareLink(createSharePayload(project))
        if (!link.ok) {
          setShareState('failed')
          return
        }
        await copyShareLink(link.url)
      }
      setShareState('copied')
    } catch {
      setShareState('failed')
    }
  }

  const toggleSolutionPath = () => {
    if (showSolution) {
      solutionControllerRef.current?.cancel()
      setShowSolution(false)
      setSolutionAnimation(null)
      return
    }

    setHintCells([])
    setShowSolution(true)
    setSolutionAnimation(null)
    void solutionControllerRef.current?.play({
      mode: 'path',
      path: solution,
      color: project.visualTheme.accentColor,
    })
  }

  const secret = project.secretReveal.content
  const secretImage =
    secret.kind === 'image' || secret.kind === 'image-message' ? secret.imageDataUrl : null
  const secretLink = secret.kind === 'link' ? safeSecretLink(secret.url) : null

  return (
    <main className="player-root">
      <div className="player-stage">
        <MazeCanvas
          ref={canvasRef}
          model={model}
          mode="play"
          onSwipe={move}
          frame={{
            player: session.position,
            ghost,
            ghostTrail: withGhost ? project.creatorReplay?.frames.slice(0, ghost?.frameIndex ?? 0) : undefined,
            visited: parseVisited(session.visited),
            solution: showSolution ? solution : hintCells,
            solutionProgress: showSolution
              ? (solutionAnimation?.solutionProgress ?? 0)
              : hintCells.length
                ? 1
                : 0,
            activeCheckpointIds: new Set(session.stats.checkpoints),
            collectedItemIds: new Set(session.stats.collectibles),
          }}
          theme={{
            canvas: '#121714',
            mazeFill: project.background.kind === 'solid' ? project.background.color : project.visualTheme.pathColor,
            wall: project.visualTheme.wallColor,
            start: project.visualTheme.startColor,
            end: project.visualTheme.endColor,
            solution: project.visualTheme.accentColor,
          }}
          ariaLabel={`${project.title} 플레이 영역. 방향키, WASD 또는 스와이프로 이동합니다.`}
        />
      </div>

      <header className="player-hud">
        <div className="hud-stats">
          <div className="hud-stat">
            <span>{remainingMs === null ? '시간' : '남은 시간'}</span>
            <strong>{formatDuration(remainingMs ?? displayedElapsed)}</strong>
          </div>
          <div className="hud-stat"><span>이동</span><strong>{session.stats.moves}</strong></div>
          <div className="hud-stat optional"><span>체크포인트</span><strong>{session.stats.checkpoints.length}/{project.checkpoints.length}</strong></div>
          <div className="hud-stat optional"><span>수집</span><strong>{session.stats.collectibles.length}/{project.collectibles.length}</strong></div>
          <div className="hud-stat optional"><span>힌트</span><strong>{Math.max(0, project.gameRules.allowedHints - session.stats.hintsUsed)}</strong></div>
        </div>
        <div className="hud-actions">
          <button disabled={!started || timedOut || session.completed} aria-label={session.pausedAt === null ? '일시정지' : '계속하기'} onClick={() => setSession((current) => setPlayerPaused(current, current.pausedAt === null))}>{session.pausedAt === null ? <Pause size={17} /> : <Play size={17} />}</button>
          <button aria-label="처음부터" onClick={restart}><RotateCcw size={17} /></button>
          <button aria-label={sound ? '음향 끄기' : '음향 켜기'} onClick={() => setSound((value) => !value)}>{sound ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
          <button aria-label="화면 맞춤" onClick={() => canvasRef.current?.fit()}><Scan size={17} /></button>
          {allowSolution && (
            <button
              aria-label={showSolution ? '정답 경로 숨기기' : '정답 경로 보기'}
              aria-pressed={showSolution}
              disabled={solution.length === 0}
              onClick={toggleSolutionPath}
            >
              <Route size={17} />
            </button>
          )}
          <button aria-label="게임 종료" onClick={onExit}><X size={18} /></button>
        </div>
      </header>

      {progress > 0 && (
        <div className="reveal-panel" aria-hidden={!session.completed}>
          <article className="reveal-content" style={revealStyle(progress, project.secretReveal.animation)}>
            {secretImage && <img src={secretImage} alt={secret.kind === 'image' || secret.kind === 'image-message' ? secret.alt : ''} />}
            {secretText(project) && <p>{secretText(project)}</p>}
          </article>
        </div>
      )}

      {project.gameRules.showDpad && started && !timedOut && !session.completed && (
        <DPad
          className="player-dpad"
          onMove={move}
          disabled={session.pausedAt !== null || session.completed}
          repeatDelayMs={260}
          repeatIntervalMs={110}
        />
      )}
      {started && !timedOut && !session.completed && (
        <button className="button hint-button" disabled={session.stats.hintsUsed >= project.gameRules.allowedHints} onClick={showHint}><Lightbulb size={17} />힌트</button>
      )}

      {!started && (
        <div className="completion-backdrop">
          <section className="completion-card" aria-labelledby="challenge-title">
            <span className="completion-kicker">{daily ? 'DAILY MAZE' : shared ? 'SHARED CHALLENGE' : recordCreator ? 'CREATOR TEST' : 'PLAY TEST'}</span>
            <h2 id="challenge-title">{project.title}</h2>
            <p>{daily
              ? `${daily.info.weekday} · ${daily.info.shapeLabel} 모양 · ${daily.info.difficultyLabel}. 오늘은 모두 같은 미로를 풀어요. 월요일이 가장 쉽고 일요일이 가장 어려워요.`
              : recordCreator ? '완주하면 이동 경로와 시간이 제작자 고스트로 저장됩니다.' : '시작점 S에서 종료점 E까지 길을 찾아보세요.'}</p>
            <div className="completion-stats">
              <div><span>난이도</span><strong>{project.mazeMetrics.difficultyScore}점</strong></div>
              <div><span>예상 시간</span><strong>약 {project.mazeMetrics.estimatedSeconds}초</strong></div>
              <div><span>힌트</span><strong>{project.gameRules.allowedHints}회</strong></div>
              {daily && <div><span>연속 기록</span><strong>{daily.streak}일</strong></div>}
              {daily && personalBest !== null && <div><span>오늘 최고</span><strong>{formatDuration(personalBest)}</strong></div>}
            </div>
            <div className="completion-actions">
              <button className="button" onClick={() => begin(false)}><Play size={17} />혼자 플레이</button>
              {project.creatorReplay?.completed && project.gameRules.ghostAllowed && (
                <button className="button secondary" onClick={() => begin(true)}><Flag size={17} />제작자 고스트와 대결</button>
              )}
              <button className="button ghost" onClick={onExit}>나가기</button>
            </div>
          </section>
        </div>
      )}

      {session.pausedAt !== null && !timedOut && !session.completed && (
        <div className="completion-backdrop">
          <section className="completion-card">
            <span className="completion-kicker">PAUSED</span>
            <h2>잠시 멈췄습니다</h2>
            <div className="completion-actions">
              <button className="button" onClick={() => setSession((current) => setPlayerPaused(current, false))}><Play size={17} />계속하기</button>
              <button className="button secondary" onClick={restart}><RefreshCw size={17} />처음부터</button>
              <button className="button ghost" onClick={onExit}>게임 종료</button>
            </div>
          </section>
        </div>
      )}

      {timedOut && !session.completed && (
        <div className="completion-backdrop">
          <section className="completion-card" aria-live="assertive">
            <span className="completion-kicker">TIME UP</span>
            <h2>제한 시간이 끝났습니다</h2>
            <p>이번 기록을 확인하고 같은 미로에 다시 도전할 수 있습니다.</p>
            <div className="completion-stats">
              <div><span>제한 시간</span><strong>{formatDuration(limitMs ?? 0)}</strong></div>
              <div><span>이동</span><strong>{session.stats.moves}회</strong></div>
              <div><span>잘못 든 길</span><strong>{session.stats.wrongTurns}회</strong></div>
              <div><span>힌트</span><strong>{session.stats.hintsUsed}회</strong></div>
            </div>
            <div className="completion-actions">
              <button className="button" onClick={restart}><RefreshCw size={17} />다시 도전</button>
              <button className="button ghost" onClick={onExit}>게임 종료</button>
            </div>
          </section>
        </div>
      )}

      {session.completed && (
        <div className="completion-backdrop">
          <section className="completion-card" aria-live="polite">
            <span className="completion-kicker">{daily ? 'DAILY CLEAR' : secret.kind === 'none' ? 'CLEAR' : 'UNLOCKED'}</span>
            <h2>{daily ? '오늘의 미로 완주!' : secret.kind === 'none' ? '완주했어요!' : '이야기가 열렸습니다'}</h2>
            {daily && <p className="completion-daily">연속 {daily.finishedStreak}일째 · 내일 새 미로가 열려요</p>}
            {secretImage && <img className="completion-image" src={secretImage} alt={secret.kind === 'image' || secret.kind === 'image-message' ? secret.alt : ''} />}
            {secret.kind === 'link' ? (
              secretLink ? (
                <a className="button secondary" href={secretLink} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={17} />
                  {secret.label.trim() || '링크 열기'}
                </a>
              ) : (
                <div className="completion-secret" role="status">안전한 링크 주소를 확인해 주세요.</div>
              )
            ) : (
              secretText(project) && <div className="completion-secret">{secretText(project)}</div>
            )}
            <div className="completion-stats">
              <div><span>내 기록</span><strong>{formatDuration(session.elapsedMs)}</strong></div>
              <div><span>이동</span><strong>{session.stats.moves}회</strong></div>
              <div><span>잘못 든 길</span><strong>{session.stats.wrongTurns}회</strong></div>
              <div><span>힌트</span><strong>{session.stats.hintsUsed}회</strong></div>
              <div><span>힌트 패널티</span><strong>{session.stats.hintsUsed ? `+${session.stats.hintsUsed * 5}초` : '없음'}</strong></div>
              <div><span>{daily ? '오늘 최고' : '개인 최고'}</span><strong>{formatDuration(Math.min(personalBest ?? Infinity, session.elapsedMs))}</strong></div>
              {!daily && <>
                <div><span>제작자 기록</span><strong>{project.creatorReplay?.completed ? formatDuration(project.creatorReplay.durationMs) : '—'}</strong></div>
                <div><span>제작자 차이</span><strong>{creatorDifference === null ? '—' : `${Math.abs(creatorDifference / 1000).toFixed(2)}초 ${creatorDifference >= 0 ? '승리' : '뒤짐'}`}</strong></div>
              </>}
            </div>
            <div className="completion-actions">
              <button className="button" onClick={restart}><RefreshCw size={17} />다시 도전</button>
              <button className="button secondary" onClick={saveResult}><Download size={17} />결과 이미지</button>
              <button className="button secondary" onClick={() => void copyShare()}><Share2 size={17} />{shareState === 'copied' ? '복사했어요' : shareState === 'failed' ? '복사하지 못했어요' : daily ? '결과 공유' : '링크 복사'}</button>
              {project.remixAllowed && onRemix && <button className="button secondary" onClick={() => onRemix(project)}>이 미로 리믹스</button>}
              <button className="button ghost" onClick={onExit}>나가기</button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
