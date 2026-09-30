import { Check, Circle, Lock, Star, X } from 'lucide-react'
import { goalText, type Challenge, type GoalState } from '../waterSimulation/garden/challenges'

export { CHALLENGE_KEY, readChallengeSave, writeChallengeSave, type ChallengeSave } from './craftStorage'

export function Stars({ count, size = 13 }: { count: number; size?: number }) {
  return <span className="challenge-stars" aria-label={`별 ${count}개`}>
    {[0, 1, 2].map(k => <Star key={k} size={size} fill={k < count ? 'currentColor' : 'none'} className={k < count ? 'is-earned' : ''} />)}
  </span>
}

interface Props {
  stages: Challenge[]
  current: Challenge
  stars: Record<string, number>
  goals: GoalState[]
  onSelect(stage: Challenge): void
}

/** Stage picker, the current brief and its goals as the physics judges them. */
export function ChallengePanel({ stages, current, stars, goals, onSelect }: Props) {
  return <div className="challenge-panel">
    <div className="challenge-stages" role="group" aria-label="스테이지">
      {stages.map((stage, index) => {
        const open = index === 0 || (stars[stages[index - 1].id] ?? 0) > 0
        return <button key={stage.id} aria-label={`${index + 1}. ${stage.name}${open ? '' : ' (잠김)'}`} aria-pressed={stage.id === current.id}
          disabled={!open} onClick={() => onSelect(stage)}>
          <span>{open ? index + 1 : <Lock size={12} />}</span>
          <Stars count={stars[stage.id] ?? 0} size={9} />
        </button>
      })}
    </div>
    <div className="challenge-brief">
      <strong>{stages.indexOf(current) + 1}. {current.name}</strong>
      <p>{current.story}</p>
      <ul aria-label="목표">
        {current.goals.map((goal, k) => {
          const state = goals[k] ?? 'pending'
          return <li key={k} className={`is-${state}`}>
            {state === 'met' ? <Check size={14} /> : state === 'failed' ? <X size={14} /> : <Circle size={12} />}
            <span>{goalText(goal)}</span>
          </li>
        })}
      </ul>
      <small>★★ {current.par.time}초 안에 도착 · ★★★ 장치 {current.par.devices}개 이하로</small>
    </div>
  </div>
}
