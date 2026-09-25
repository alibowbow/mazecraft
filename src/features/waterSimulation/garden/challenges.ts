import { CRAFT_MODULES, type CraftCourse, type CraftExit, type CraftKind, type CraftModule } from './craft'
import type { GardenProgress } from './progress'

/**
 * Challenge stages: a source height, a device palette and goals the water
 * must meet. Goals about the course (how many devices, which ones) are read
 * from the course; goals about the water (reaching the last pond in time,
 * shishi-odoshi knocks, siphon surges) are judged by the physics as it runs.
 */
export type ChallengeGoal =
  | { kind: 'reach'; within: number }
  | { kind: 'knocks'; count: number }
  | { kind: 'surges'; count: number }
  | { kind: 'max-devices'; count: number }
  | { kind: 'min-devices'; count: number }
  | { kind: 'use'; device: CraftKind }
  | { kind: 'use-exit'; exit: CraftExit; count: number }
  | { kind: 'no-lift' }

export interface Challenge {
  id: string
  name: string
  /** One or two sentences setting the scene and the task. */
  story: string
  source: number
  /** Devices already in place (the player builds after them). */
  locked: CraftModule[]
  palette: CraftKind[]
  exits: CraftExit[]
  goals: ChallengeGoal[]
  /** Second star: water arrives within this time (s); third: with at most this many added devices. */
  par: { time: number; devices: number }
  /** A known solution (devices added after the locked ones), kept for the tests. */
  solution: CraftModule[]
}

let serial = 0
const m = (kind: CraftKind, overrides: Partial<CraftModule> = {}): CraftModule =>
  ({ id: `stage-${kind}-${serial++}`, kind, turn: 'straight', exit: 'plain', size: 'medium', seed: 5, wheels: false, ...overrides })

export const CHALLENGES: Challenge[] = [
  {
    id: 'first-drop', name: '첫 물길', source: 2.8,
    story: '샘에서 솟은 물을 종착 연못까지 보내 주세요. 장치 하나면 충분해요.',
    locked: [], palette: ['pond', 'maze'], exits: ['plain'],
    goals: [{ kind: 'reach', within: 30 }], par: { time: 10, devices: 1 },
    solution: [m('pond', { size: 'small' })],
  },
  {
    id: 'bamboo-knock', name: '대나무의 딱 소리', source: 3.6,
    story: '시시오도시가 물을 받아 기울었다가 “딱” 하고 돌아오게 해 보세요. 세 번 울려야 해요.',
    locked: [], palette: ['pond', 'maze'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'knocks', count: 3 }, { kind: 'reach', within: 60 }], par: { time: 20, devices: 2 },
    solution: [m('pond', { exit: 'tipper' }), m('pond', { size: 'small' })],
  },
  {
    id: 'rain-chain', name: '빗물 사슬', source: 4.0,
    story: '구리 컵 사슬을 두 번 타고 내려오는 조용한 물길을 만들어요.',
    locked: [], palette: ['pond', 'terraces', 'maze'], exits: ['plain', 'chain'],
    goals: [{ kind: 'use-exit', exit: 'chain', count: 2 }, { kind: 'reach', within: 60 }], par: { time: 22, devices: 3 },
    solution: [m('terraces', { size: 'small', exit: 'chain' }), m('pond', { size: 'small', exit: 'chain', turn: 'left' })],
  },
  {
    id: 'low-spring', name: '낮은 샘', source: 2.6,
    story: '샘이 너무 낮아 미로 두 개를 지날 수 없어요. 물을 다시 끌어올려야 해요.',
    locked: [m('maze', { size: 'small', seed: 12 })], palette: ['maze', 'pond', 'screw', 'noria'], exits: ['plain'],
    goals: [{ kind: 'min-devices', count: 3 }, { kind: 'reach', within: 90 }], par: { time: 40, devices: 2 },
    solution: [m('screw', { size: 'medium' }), m('maze', { size: 'small', seed: 13 })],
  },
  {
    id: 'water-wheels', name: '물레바퀴 마을', source: 4.4,
    story: '떨어지는 물로 물레바퀴를 두 번 돌려 주세요.',
    locked: [], palette: ['terraces', 'pond', 'maze'], exits: ['plain', 'wheel'],
    goals: [{ kind: 'use-exit', exit: 'wheel', count: 2 }, { kind: 'reach', within: 80 }], par: { time: 35, devices: 3 },
    solution: [m('terraces', { size: 'small', exit: 'wheel' }), m('maze', { size: 'small', exit: 'wheel', turn: 'right', seed: 9 }), m('pond', { size: 'small' })],
  },
  {
    id: 'siphon-burst', name: '한꺼번에 쏟아라', source: 5.0,
    story: '벨 사이펀이 두 번 걸리게 만들어요. 사이펀 앞에서 물이 넉넉히 모여야 해요.',
    locked: [], palette: ['spiral', 'siphon', 'pond', 'zigzag'], exits: ['plain'],
    goals: [{ kind: 'surges', count: 2 }], par: { time: 35, devices: 2 },
    solution: [m('spiral', { size: 'medium' }), m('siphon')],
  },
  {
    id: 'no-pumps', name: '펌프 없이 멀리', source: 5.4,
    story: '양수 장치 없이 네 개의 장치를 모두 지나 끝까지 가야 해요. 높이를 아껴 쓰세요.',
    locked: [], palette: ['maze', 'pond', 'terraces', 'zigzag', 'aqueduct'], exits: ['plain', 'chain'],
    goals: [{ kind: 'min-devices', count: 4 }, { kind: 'no-lift' }, { kind: 'reach', within: 90 }], par: { time: 35, devices: 4 },
    solution: [m('aqueduct', { size: 'small' }), m('zigzag', { size: 'small', turn: 'left' }), m('pond', { size: 'small', turn: 'right' }), m('maze', { size: 'small', seed: 21 })],
  },
  {
    id: 'spiral-tower', name: '나선 탑', source: 3.2,
    story: '낮은 곳에서 시작해 노리아로 물을 올리고, 나선 탑을 한 바퀴 이상 돌려 보내요.',
    locked: [m('pond', { size: 'small' })], palette: ['noria', 'screw', 'spiral', 'pond'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'noria' }, { kind: 'use', device: 'spiral' }, { kind: 'reach', within: 120 }], par: { time: 65, devices: 2 },
    solution: [m('noria', { size: 'medium' }), m('spiral', { size: 'medium' })],
  },
  {
    id: 'few-devices', name: '적게, 멀리', source: 4.6,
    story: '장치는 최대 세 개. 그중 하나는 긴 수도교여야 해요.',
    locked: [], palette: ['aqueduct', 'maze', 'pond', 'zigzag'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'max-devices', count: 3 }, { kind: 'use', device: 'aqueduct' }, { kind: 'reach', within: 60 }], par: { time: 22, devices: 2 },
    solution: [m('aqueduct', { size: 'large' }), m('pond', { size: 'small' })],
  },
  {
    id: 'grand-garden', name: '물의 대정원', source: 3.6,
    story: '마지막 도전: 스크류와 노리아를 모두 써서 여섯 개 이상의 장치를 지나는 긴 여정을 완성하세요.',
    locked: [], palette: ['maze', 'terraces', 'pond', 'noria', 'screw', 'spiral', 'zigzag', 'aqueduct', 'siphon'], exits: ['plain', 'tipper', 'wheel', 'chain'],
    goals: [{ kind: 'min-devices', count: 6 }, { kind: 'use', device: 'screw' }, { kind: 'use', device: 'noria' }, { kind: 'reach', within: 200 }], par: { time: 110, devices: 6 },
    solution: [m('maze', { size: 'small', seed: 31 }), m('screw', { size: 'medium' }), m('terraces', { size: 'small', turn: 'right' }), m('noria', { size: 'medium' }), m('zigzag', { size: 'small' }), m('pond', { size: 'small', exit: 'chain' })],
  },
]

const name = (kind: CraftKind) => CRAFT_MODULES.find(item => item.kind === kind)!.name
const EXIT_NAMES: Record<CraftExit, string> = { plain: '물길', tipper: '시시오도시', wheel: '물레바퀴', chain: '빗물 사슬' }

export function goalText(goal: ChallengeGoal): string {
  switch (goal.kind) {
    case 'reach': return `${goal.within}초 안에 종착 연못까지`
    case 'knocks': return `시시오도시 ${goal.count}번 울리기`
    case 'surges': return `사이펀 ${goal.count}번 쏟기`
    case 'max-devices': return `장치 ${goal.count}개 이하`
    case 'min-devices': return `장치 ${goal.count}개 이상`
    case 'use': return `${name(goal.device)} 쓰기`
    case 'use-exit': return `${EXIT_NAMES[goal.exit]} 출구 ${goal.count}개`
    case 'no-lift': return '양수 장치 없이'
  }
}

export type GoalState = 'met' | 'pending' | 'failed'

/** Where each goal stands for this course and run. */
export function judgeGoals(challenge: Challenge, course: CraftCourse, progress: GardenProgress | null, time: number): GoalState[] {
  const kinds = course.modules.map(module => module.kind)
  return challenge.goals.map(goal => {
    switch (goal.kind) {
      case 'max-devices': return course.modules.length <= goal.count ? 'met' : 'failed'
      case 'min-devices': return course.modules.length >= goal.count ? 'met' : 'failed'
      case 'use': return kinds.includes(goal.device) ? 'met' : 'failed'
      case 'use-exit': return course.modules.filter(module => module.exit === goal.exit).length >= goal.count ? 'met' : 'failed'
      case 'no-lift': return kinds.some(kind => kind === 'noria' || kind === 'screw') ? 'failed' : 'met'
      case 'reach':
        if (progress?.arrival !== null && progress?.arrival !== undefined) return progress.arrival <= goal.within ? 'met' : 'failed'
        return time > goal.within ? 'failed' : 'pending'
      case 'knocks': return (progress?.knocks ?? 0) >= goal.count ? 'met' : 'pending'
      case 'surges': return (progress?.surges ?? 0) >= goal.count ? 'met' : 'pending'
    }
  })
}

/** Stars for a cleared stage: 1 for the goals, +1 on par time, +1 on par device count. */
export function starsFor(challenge: Challenge, course: CraftCourse, progress: GardenProgress, clearedAt: number): number {
  const added = course.modules.length - challenge.locked.length
  const arrival = progress.arrival ?? clearedAt
  return 1 + (arrival <= challenge.par.time ? 1 : 0) + (added <= challenge.par.devices ? 1 : 0)
}

/** The course a stage starts from, and a check that the player kept its rules. */
export function challengeCourse(challenge: Challenge, added: CraftModule[] = []): CraftCourse {
  return { version: 1, name: challenge.name, source: challenge.source, modules: [...challenge.locked, ...added] }
}
