import { useEffect, useRef, type CSSProperties } from 'react'
import { ArrowRight, Blocks, Check, Droplets, Gauge, RotateCcw, Star, Trophy, X } from 'lucide-react'
import {
  CHALLENGES, CHAPTERS, stageNumber,
  type Challenge, type GoalState, type StarBreakdown,
} from '../waterSimulation/garden/challenges'
import type { CraftCourse } from '../waterSimulation/garden/craft'
import { GoalList, ParLine, Stars, TipIcon } from './ChallengePanel'
import type { CoachStep } from './challengeFlow'

/** The card that opens a stage: where it sits in the campaign, the task, what is new, and the stars. */
export function StageBriefing({ stage, course, goals, earned, onStart }: {
  stage: Challenge
  course: CraftCourse
  goals: GoalState[]
  /** Stars already earned on this stage. */
  earned: number
  onStart(): void
}) {
  const start = useRef<HTMLButtonElement>(null)
  useEffect(() => { start.current?.focus({ preventScroll: true }) }, [stage.id])
  return <div className="stage-briefing" role="dialog" aria-modal="false" aria-labelledby="stage-briefing-title"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onStart() } }}>
    <div className="stage-briefing-top">
      <span className="ws-eyebrow">STAGE {stageNumber(stage)} / {CHALLENGES.length}</span>
      <span className="stage-briefing-chapter">{stage.chapter + 1}장 · {CHAPTERS[stage.chapter].name}</span>
    </div>
    <h2 id="stage-briefing-title">{stage.name}</h2>
    {earned > 0 && <Stars count={earned} size={15} />}
    <p className="stage-briefing-story">{stage.story}</p>
    <div className="stage-briefing-tip">
      <span className="stage-briefing-tip-icon"><TipIcon stage={stage} size={20} /></span>
      <div><strong><em>{stage.tip.device || stage.tip.exit ? 'NEW' : 'TIP'}</em>{stage.tip.title}</strong><p>{stage.tip.text}</p></div>
    </div>
    <GoalList stage={stage} goals={goals} course={course} progress={null} time={0} />
    <ParLine stage={stage} />
    <button ref={start} type="button" className="ws-primary stage-briefing-start" onClick={onStart}>시작하기<ArrowRight size={16} /></button>
  </div>
}

const COACH_TEXT: Record<CoachStep, { step: string; text: string }> = {
  add: { step: '1/3', text: '장치 목록에서 연꽃 연못을 눌러 물길에 넣어 보세요.' },
  pour: { step: '2/3', text: '▶ 물 흘려보내기를 눌러 물을 부어 보세요.' },
  watch: { step: '3/3', text: '물이 종착 연못에 닿으면 클리어예요. 재생 속도를 4×로 올리면 더 빨리 볼 수 있어요.' },
}

/** A short guide over the scene for the first stage. The pour step points at the scene's own start button. */
export function StageCoach({ step, onAdd, onFaster }: { step: CoachStep; onAdd(): void; onFaster(): void }) {
  const { step: count, text } = COACH_TEXT[step]
  return <div className="craft-coach" role="status" aria-live="polite" data-step={step}>
    <span className="craft-coach-step">{count}</span>
    <p>{text}</p>
    {step === 'add' && <button type="button" onClick={onAdd}><Blocks size={14} />연꽃 연못 넣기</button>}
    {step === 'watch' && <button type="button" onClick={onFaster}><Gauge size={14} />4×로 보기</button>}
  </div>
}

/** Droplets that burst from the stars when a stage is cleared. */
function Splash() {
  return <span className="clear-splash" aria-hidden="true">
    {Array.from({ length: 14 }, (_, k) => <i key={k} style={{ '--k': k } as CSSProperties} />)}
  </span>
}

export interface ClearInfo {
  stage: string
  breakdown: StarBreakdown
  /** Stars on this stage before this clear. */
  previous: number
  /** Fastest arrival before this clear, if any. */
  previousBest: number | null
  /** A chapter this clear finished for the first time. */
  chapter: number | null
  /** This clear finished the whole campaign. */
  campaign: boolean
  open: boolean
}

export function StageClear({ stage, info, totalStars, onNext, onRetry, onClose, onFree, onCollect }: {
  stage: Challenge
  info: ClearInfo
  totalStars: number
  onNext(next: Challenge): void
  onRetry(): void
  onClose(): void
  onFree(): void
  /** The first stage that still has stars to earn, after the campaign. */
  onCollect: (() => void) | null
}) {
  const { breakdown } = info
  const next = CHALLENGES[CHALLENGES.indexOf(stage) + 1]
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => { primary.current?.focus({ preventScroll: true }) }, [info.stage])
  const improved = breakdown.stars > info.previous && info.previous > 0
  const faster = info.previousBest !== null && breakdown.arrival < info.previousBest - 0.05
  // With the answer shown, a met condition keeps its check but earns no star.
  const rows = [
    { met: true, earned: true, text: '목표를 모두 채웠어요', value: '' },
    { met: breakdown.time, earned: breakdown.time && !breakdown.assisted, text: `${stage.par.time}초 안에 도착`, value: `${breakdown.arrival.toFixed(1)}초` },
    { met: breakdown.devices, earned: breakdown.devices && !breakdown.assisted, text: `장치 ${stage.par.devices}개 이하`, value: `${breakdown.added}개` },
  ]
  return <div className={`challenge-clear${info.campaign ? ' is-campaign' : ''}`} role="dialog" aria-label="스테이지 클리어"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <button type="button" className="clear-close ws-icon" aria-label="결과 닫기" onClick={onClose}><X size={16} /></button>
    <span className="ws-eyebrow">{info.campaign ? 'ALL CLEAR' : 'STAGE CLEAR'}</span>
    <strong>{info.campaign ? '모든 물길을 완성했어요!' : `${stage.name} 완성!`}</strong>
    <span className="clear-stars"><Stars count={breakdown.stars} size={30} animate /><Splash /></span>
    {(improved || faster) && <span className="clear-badge">{improved ? '별 기록 갱신' : '최고 기록 갱신'}</span>}
    <ul className="clear-rows">
      {rows.map(row => <li key={row.text} className={row.earned ? 'is-met' : row.met ? 'is-waived' : 'is-missed'}>
        <Star size={13} fill={row.earned ? 'currentColor' : 'none'} />
        <span>{row.text}</span>
        {row.value && <small>{row.value}</small>}
        {row.met ? <Check size={13} /> : <X size={13} />}
      </li>)}
    </ul>
    {breakdown.assisted && <p className="clear-note">정답을 보고 완성해 별 1개를 받았어요. 직접 만들어 다시 도전해 보세요.</p>}
    {info.chapter !== null && !info.campaign && <p className="clear-chapter"><Trophy size={15} />{info.chapter + 1}장 ‘{CHAPTERS[info.chapter].name}’을 모두 완성했어요
      {CHAPTERS[info.chapter + 1] && <small>다음은 {info.chapter + 2}장 ‘{CHAPTERS[info.chapter + 1].name}’이에요</small>}</p>}
    {info.campaign && <p className="clear-chapter"><Trophy size={15} />스무 개의 물길을 모두 지었어요<small>모은 별 {totalStars} / {CHALLENGES.length * 3}</small></p>}
    <div className="clear-actions">
      <button type="button" className="ws-secondary" onClick={onRetry}><RotateCcw size={14} />다시 도전</button>
      {info.campaign
        ? <>
            {onCollect && <button type="button" className="ws-secondary" onClick={onCollect}><Star size={14} />별 더 모으기</button>}
            <button ref={primary} type="button" className="ws-primary" onClick={onFree}><Droplets size={14} />자유 제작으로</button>
          </>
        : next
          ? <button ref={primary} type="button" className="ws-primary" onClick={() => onNext(next)}>다음 스테이지<ArrowRight size={14} /></button>
          : <button ref={primary} type="button" className="ws-primary" onClick={onClose}>계속 보기</button>}
    </div>
    {!info.campaign && next && <button type="button" className="clear-link" onClick={onClose}>계속 보기</button>}
  </div>
}
