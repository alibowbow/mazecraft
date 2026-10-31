import { useState } from 'react'
import { BookOpen, Check, ChevronDown, Circle, Lightbulb, Lock, Sparkles, Star, Wand2, X } from 'lucide-react'
import {
  CHALLENGES, CHAPTERS, goalProgress, goalText, isCourseGoal, stageNumber,
  type Challenge, type GoalState,
} from '../waterSimulation/garden/challenges'
import type { CraftCourse } from '../waterSimulation/garden/craft'
import type { GardenProgress } from '../waterSimulation/garden/progress'
import { DEVICE_ICONS, EXIT_ICONS } from './craftIcons'
import { chapterStars, isStageOpen, type ChallengeSave } from './craftStorage'

export { CHALLENGE_KEY, readChallengeSave, writeChallengeSave, type ChallengeSave } from './craftStorage'

export function Stars({ count, size = 13, animate = false }: { count: number; size?: number; animate?: boolean }) {
  return <span className={`challenge-stars${animate ? ' is-animated' : ''}`} aria-label={`별 ${count}개`}>
    {[0, 1, 2].map(k => <Star key={k} size={size} fill={k < count ? 'currentColor' : 'none'} className={k < count ? 'is-earned' : ''}
      style={animate ? { animationDelay: `${0.25 + k * 0.32}s` } : undefined} />)}
  </span>
}

/** The device or exit a stage introduces, as an icon. */
export function TipIcon({ stage, size = 18 }: { stage: Challenge; size?: number }) {
  const Icon = stage.tip.device ? DEVICE_ICONS[stage.tip.device] : stage.tip.exit ? EXIT_ICONS[stage.tip.exit] : Sparkles
  return <Icon size={size} aria-hidden="true" />
}

/** The goals of a stage with where each stands now. */
export function GoalList({ stage, goals, course, progress, time }: {
  stage: Challenge
  goals: GoalState[]
  course: CraftCourse
  progress: GardenProgress | null
  time: number
}) {
  return <ul className="challenge-goals" aria-label="목표">
    {stage.goals.map((goal, k) => {
      // A course rule not met yet is still to do, not a failure, until the water runs.
      const judged = goals[k] ?? 'pending'
      const state = judged === 'failed' && isCourseGoal(goal) && time <= 0 ? 'pending' : judged
      const now = goalProgress(goal, course, progress, time)
      return <li key={k} className={`is-${state}`}>
        {state === 'met' ? <Check size={14} /> : state === 'failed' ? <X size={14} /> : <Circle size={12} />}
        <span>{goalText(goal)}</span>
        {now && <small>{now}</small>}
      </li>
    })}
  </ul>
}

export function ParLine({ stage }: { stage: Challenge }) {
  return <p className="challenge-par">
    <span><Star size={11} fill="currentColor" />목표 달성</span>
    <span><Star size={11} fill="currentColor" />{stage.par.time}초 안에 도착</span>
    <span><Star size={11} fill="currentColor" />장치 {stage.par.devices}개 이하</span>
  </p>
}

interface Props {
  current: Challenge
  save: ChallengeSave
  goals: GoalState[]
  course: CraftCourse
  progress: GardenProgress | null
  time: number
  /** Hints revealed for this stage (0–2). */
  hintsShown: number
  /** The answer was applied in this attempt. */
  assisted: boolean
  onSelect(stage: Challenge): void
  onHint(): void
  onAnswer(): void
  onBriefing(): void
}

/** Stage map by chapter, the current brief, its goals as the physics judges them, and help. */
export function ChallengePanel({ current, save, goals, course, progress, time, hintsShown, assisted, onSelect, onHint, onAnswer, onBriefing }: Props) {
  const [confirmAnswer, setConfirmAnswer] = useState(false)
  // Only the current chapter is unfolded, so the brief and the devices stay near the top.
  const [unfolded, setUnfolded] = useState(current.chapter)
  const best = save.best[current.id]
  const earned = save.stars[current.id] ?? 0
  return <div className="challenge-panel">
    <div className="challenge-map" role="group" aria-label="스테이지">
      {CHAPTERS.map((chapter, c) => {
        const tally = chapterStars(save, c)
        const stages = CHALLENGES.map((stage, index) => ({ stage, index })).filter(({ stage }) => stage.chapter === c)
        const reachable = stages.some(({ index }) => isStageOpen(save, index))
        const expanded = unfolded === c
        return <div key={chapter.name} className={`challenge-chapter${reachable ? '' : ' is-locked'}${current.chapter === c ? ' is-current' : ''}`}>
          <button type="button" className="challenge-chapter-head" aria-expanded={expanded} onClick={() => setUnfolded(expanded ? -1 : c)}>
            <span>{c + 1}장 · {chapter.name}</span>
            <small>{reachable ? <><Star size={10} fill="currentColor" />{tally.stars}/{tally.max}</> : <Lock size={10} />}</small>
            <ChevronDown size={13} />
          </button>
          {expanded && <div className="challenge-stages">
            {stages.map(({ stage, index }) => {
              const open = isStageOpen(save, index)
              return <button key={stage.id} aria-label={`${index + 1}. ${stage.name}${open ? '' : ' (잠김)'}`} aria-pressed={stage.id === current.id}
                disabled={!open} title={open ? stage.name : '앞 스테이지에서 별을 받으면 열려요'} onClick={() => onSelect(stage)}>
                <span>{open ? index + 1 : <Lock size={12} />}</span>
                <Stars count={save.stars[stage.id] ?? 0} size={9} />
              </button>
            })}
          </div>}
        </div>
      })}
    </div>

    <div className="challenge-brief">
      <span className="challenge-brief-kicker">{current.chapter + 1}장 {CHAPTERS[current.chapter].name} · {stageNumber(current)}단계</span>
      <strong>{current.name}</strong>
      <p>{current.story}</p>
      <GoalList stage={current} goals={goals} course={course} progress={progress} time={time} />
      <ParLine stage={current} />
      {(earned > 0 || best) && <p className="challenge-record"><Stars count={earned} size={11} />{best ? `최고 기록 ${best.toFixed(0)}초` : ''}</p>}
      <div className="challenge-help">
        <button type="button" onClick={onBriefing}><BookOpen size={14} />새로 배울 것: {current.tip.title}</button>
        {hintsShown < 2 && <button type="button" onClick={onHint}><Lightbulb size={14} />힌트 보기 <small>{hintsShown}/2</small></button>}
      </div>
      {hintsShown > 0 && <ol className="challenge-hints" aria-label="힌트">
        {current.hints.slice(0, hintsShown).map((hint, k) => <li key={k}><Lightbulb size={13} /><span>{hint}</span></li>)}
      </ol>}
      {hintsShown >= 2 && !assisted && (confirmAnswer
        ? <div className="challenge-answer-confirm" role="group" aria-label="정답 보기 확인">
            <p>정답 물길로 바꿔요. 이번 도전은 별 1개만 받을 수 있어요.</p>
            <div>
              <button type="button" onClick={() => setConfirmAnswer(false)}>취소</button>
              <button type="button" className="is-primary" onClick={() => { setConfirmAnswer(false); onAnswer() }}>정답 적용</button>
            </div>
          </div>
        : <button type="button" className="challenge-answer" onClick={() => setConfirmAnswer(true)}><Wand2 size={14} />정답 보기</button>)}
      {assisted && <p className="challenge-assisted"><Wand2 size={13} />정답을 적용했어요. 직접 만들면 별을 더 받을 수 있어요.</p>}
    </div>
  </div>
}
