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
  | { kind: 'use'; device: CraftKind; count?: number }
  | { kind: 'use-exit'; exit: CraftExit; count: number }
  | { kind: 'no-lift' }

/** What a stage teaches, shown on its briefing: a device or exit met for the first time, or an idea. */
export interface ChallengeTip {
  title: string
  text: string
  device?: CraftKind
  exit?: CraftExit
}

export interface Challenge {
  id: string
  name: string
  /** Index into CHAPTERS. */
  chapter: number
  /** One or two sentences setting the scene and the task. */
  story: string
  tip: ChallengeTip
  /** A nudge, then the concrete steps. */
  hints: [string, string]
  source: number
  /** Devices already in place (the player builds after them). */
  locked: CraftModule[]
  palette: CraftKind[]
  exits: CraftExit[]
  goals: ChallengeGoal[]
  /** Second star: water arrives within this time (s); third: with at most this many added devices. */
  par: { time: number; devices: number }
  /** A known solution (devices added after the locked ones): the tests clear it, and 정답 보기 applies it. */
  solution: CraftModule[]
}

export interface ChallengeChapter {
  name: string
  /** A line for the stage map and the briefing. */
  summary: string
}

export const CHAPTERS: ChallengeChapter[] = [
  { name: '샘과 연못', summary: '물은 높은 곳에서 낮은 곳으로 흘러요. 첫 물길을 지어 봐요.' },
  { name: '물레와 사이펀', summary: '떨어지는 물이 장치를 움직여요. 소리와 움직임을 더해 봐요.' },
  { name: '끌어올리는 힘', summary: '모터가 물을 다시 높이 올려요. 낮은 샘에서도 멀리 가 봐요.' },
  { name: '다리와 물살', summary: '멀리, 빠르게, 아껴서. 지금까지 배운 것을 모두 써 봐요.' },
]

let serial = 0
const m = (kind: CraftKind, overrides: Partial<CraftModule> = {}): CraftModule =>
  ({ id: `stage-${kind}-${serial++}`, kind, turn: 'straight', exit: 'plain', size: 'medium', seed: 5, wheels: false, ...overrides })

/*
 * Every stage below is cleared with three stars by its own solution in
 * challenges.test.ts, and the lesson stages are checked to need their lesson.
 * Par times leave about a third over the measured arrival of the solution.
 * Stage ids are save keys: keep them when a stage changes or moves.
 */
export const CHALLENGES: Challenge[] = [
  // 1장 · 샘과 연못
  {
    id: 'first-drop', name: '첫 물길', chapter: 0, source: 2.8,
    story: '샘에서 솟은 물을 종착 연못까지 보내 주세요. 장치 하나면 충분해요.',
    tip: { device: 'pond', title: '연꽃 연못', text: '가장 다루기 쉬운 수조예요. 물이 잠시 머물렀다가 출구로 흘러 나가요.' },
    hints: ['장치 목록에서 연꽃 연못을 눌러 물길에 넣어 보세요.', '연못을 넣었다면 화면 아래 ▶ 물 흘려보내기를 누르세요. 물이 종착 연못에 닿으면 클리어예요.'],
    locked: [], palette: ['pond', 'maze'], exits: ['plain'],
    goals: [{ kind: 'reach', within: 30 }], par: { time: 10, devices: 1 },
    solution: [m('pond', { size: 'small' })],
  },
  {
    id: 'bamboo-knock', name: '대나무의 딱 소리', chapter: 0, source: 3.6,
    story: '시시오도시가 물을 받아 기울었다가 “딱” 하고 돌아오게 해 보세요. 세 번 울리면 완성이에요.',
    tip: { exit: 'tipper', title: '출구 장치 · 시시오도시', text: '물길의 수조를 눌러 펼치면 출구 장치를 고를 수 있어요. 시시오도시는 대나무 통에 물이 차면 기울어 쏟고 “딱” 소리를 내요.' },
    hints: ['연꽃 연못을 넣고, 물길 순서에서 연못을 눌러 펼친 뒤 출구 장치를 시시오도시로 바꾸세요.', '시시오도시 뒤에는 물을 받을 넓은 수조가 있어야 해요. 연못 하나로 시작하고, 막히면 연못을 하나 더 넣어 보세요.'],
    locked: [], palette: ['pond', 'maze'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'knocks', count: 3 }, { kind: 'reach', within: 60 }], par: { time: 20, devices: 2 },
    solution: [m('pond', { exit: 'tipper' }), m('pond', { size: 'small' })],
  },
  {
    id: 'maze-path', name: '미로 속 물길', chapter: 0, source: 3.6,
    story: '도자기 미로 속에서 물이 스스로 길을 찾아요. 미로 수조 두 개를 지나 종착 연못까지 보내 주세요.',
    tip: { device: 'maze', title: '미로 수조', text: '벽 사이로 물이 길을 찾아 흐르고, 계단 둑을 넘을 때마다 조금씩 낮아져요. ‘미로 다시 섞기’로 길 모양을 바꿀 수 있어요.' },
    hints: ['미로 수조를 두 번 넣으면 돼요.', '미로가 길수록 물이 늦게 도착해요. 별이 모자라면 미로를 다시 섞거나 크기를 작게 바꿔 보세요.'],
    locked: [], palette: ['maze', 'pond'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'maze', count: 2 }, { kind: 'reach', within: 45 }], par: { time: 28, devices: 2 },
    solution: [m('maze', { size: 'small', seed: 14, turn: 'right' }), m('maze', { size: 'small', seed: 15 })],
  },
  {
    id: 'rain-chain', name: '빗물 사슬', chapter: 0, source: 4.0,
    story: '처마 끝 빗물처럼 구리 컵 사슬을 두 번 타고 내려오는 조용한 물길을 만들어요.',
    tip: { exit: 'chain', title: '출구 장치 · 빗물 사슬', text: '구리 컵을 하나씩 채우며 물이 졸졸 흘러내려요. 층층이 낮아지는 계단 폭포도 새로 쓸 수 있어요.' },
    hints: ['빗물 사슬은 출구 장치예요. 수조 두 개를 넣고 두 출구를 모두 빗물 사슬로 바꾸세요.', '계단 폭포(작게) 다음에 연꽃 연못(작게)을 놓고, 둘 다 출구를 빗물 사슬로 고르면 돼요.'],
    locked: [], palette: ['pond', 'terraces', 'maze'], exits: ['plain', 'chain'],
    goals: [{ kind: 'use-exit', exit: 'chain', count: 2 }, { kind: 'reach', within: 60 }], par: { time: 22, devices: 3 },
    solution: [m('terraces', { size: 'small', exit: 'chain' }), m('pond', { size: 'small', exit: 'chain', turn: 'left' })],
  },
  {
    id: 'stepping-ponds', name: '징검다리 연못', chapter: 0, source: 3.4,
    story: '샘이 낮아 높이가 넉넉하지 않아요. 수조 세 개를 지나 종착 연못까지 가려면 높이를 아껴야 해요.',
    tip: { title: '높이 여유', text: '수조는 지날 때마다 높이를 써요. 장치 버튼 아래 숫자가 쓰는 높이예요. 연꽃 연못이 가장 적게 쓰고, 미로와 계단은 조금 더 써요.' },
    hints: ['장치마다 쓰는 높이가 달라요. 판정 상자의 ‘높이 여유’를 보며 골라 보세요.', '연꽃 연못 세 개를 이어 보세요. 미로나 계단이 하나라도 섞이면 높이가 모자라요.'],
    locked: [], palette: ['pond', 'maze', 'terraces'], exits: ['plain'],
    goals: [{ kind: 'min-devices', count: 3 }, { kind: 'reach', within: 60 }], par: { time: 32, devices: 3 },
    solution: [m('pond', { size: 'small' }), m('pond', { size: 'small' }), m('pond', { size: 'small' })],
  },

  // 2장 · 물레와 사이펀
  {
    id: 'water-wheels', name: '물레바퀴 마을', chapter: 1, source: 4.4,
    story: '떨어지는 물로 마을의 물레바퀴 두 개를 힘차게 돌려 주세요.',
    tip: { exit: 'wheel', title: '출구 장치 · 물레바퀴', text: '떨어지는 물이 바퀴 통을 채워 바퀴를 돌려요. 미로와 계단 폭포에는 ‘둑마다 물레’도 달 수 있어요.' },
    hints: ['수조 두 개의 출구를 물레바퀴로 바꾸세요.', '계단 폭포(작게, 물레바퀴) → 미로 수조(작게, 물레바퀴, 오른쪽) → 연꽃 연못(작게) 순서로 놓아 보세요.'],
    locked: [], palette: ['terraces', 'pond', 'maze'], exits: ['plain', 'wheel'],
    goals: [{ kind: 'use-exit', exit: 'wheel', count: 2 }, { kind: 'reach', within: 80 }], par: { time: 35, devices: 3 },
    solution: [m('terraces', { size: 'small', exit: 'wheel' }), m('maze', { size: 'small', exit: 'wheel', turn: 'right', seed: 9 }), m('pond', { size: 'small' })],
  },
  {
    id: 'zen-garden', name: '고요한 정원', chapter: 1, source: 3.8,
    story: '대나무 통 두 개가 번갈아 우는 고요한 정원을 만들어요. “딱” 소리가 여섯 번 나면 완성이에요.',
    tip: { exit: 'tipper', title: '시시오도시 두 개', text: '시시오도시마다 쏟은 물을 받아 줄 넓은 수조가 뒤에 있어야 해요. 마지막 수조의 시시오도시는 종착 연못이 받아 줘요.' },
    hints: ['수조 두 개를 넣고 두 출구를 모두 시시오도시로 바꾸세요.', '연꽃 연못(보통, 시시오도시) → 연꽃 연못(작게, 시시오도시)이면 충분해요.'],
    locked: [], palette: ['pond', 'maze', 'terraces'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'use-exit', exit: 'tipper', count: 2 }, { kind: 'knocks', count: 6 }, { kind: 'reach', within: 60 }], par: { time: 22, devices: 2 },
    solution: [m('pond', { exit: 'tipper' }), m('pond', { size: 'small', exit: 'tipper' })],
  },
  {
    id: 'three-voices', name: '세 가지 소리', chapter: 1, source: 5.2,
    story: '물레바퀴가 돌고, 대나무가 울고, 사슬이 노래하는 정원. 세 가지 출구 장치를 모두 써 주세요.',
    tip: { title: '출구 장치 조합', text: '수조 하나에는 출구 장치를 하나만 달 수 있어요. 세 가지 소리를 내려면 수조가 세 개 필요해요.' },
    hints: ['수조 세 개를 놓고 출구를 각각 물레바퀴, 시시오도시, 빗물 사슬로 고르세요.', '연꽃 연못(작게, 물레바퀴) → 연꽃 연못(작게, 시시오도시) → 계단 폭포(작게, 빗물 사슬) 순서가 잘 맞아요.'],
    locked: [], palette: ['pond', 'terraces', 'maze'], exits: ['plain', 'tipper', 'wheel', 'chain'],
    goals: [{ kind: 'use-exit', exit: 'wheel', count: 1 }, { kind: 'use-exit', exit: 'tipper', count: 1 }, { kind: 'use-exit', exit: 'chain', count: 1 }, { kind: 'reach', within: 90 }],
    par: { time: 40, devices: 3 },
    solution: [m('pond', { size: 'small', exit: 'wheel' }), m('pond', { size: 'small', exit: 'tipper' }), m('terraces', { size: 'small', exit: 'chain' })],
  },
  {
    id: 'siphon-burst', name: '한꺼번에 쏟아라', chapter: 1, source: 5.0,
    story: '벨 사이펀이 두 번 걸리게 만들어요. 탱크에 물이 넉넉히 모이면 한꺼번에 쏟아져요.',
    tip: { device: 'siphon', title: '벨 사이펀', text: '탱크가 차오르다 어느 순간 사이펀이 걸리면 물을 한꺼번에 쏟아내요. 아래로 쏟을 자리가 필요해 높이를 넉넉히 써요. 나선 활강로 탑도 새로 쓸 수 있어요.' },
    hints: ['벨 사이펀을 넣고 물을 흘려보내 보세요. 탱크가 찰 때마다 사이펀이 걸려요.', '나선 활강로 탑(보통) → 벨 사이펀이면 별 세 개예요. 사이펀 하나만 넣어도 깰 수 있어요.'],
    locked: [], palette: ['spiral', 'siphon', 'pond'], exits: ['plain'],
    goals: [{ kind: 'surges', count: 2 }], par: { time: 35, devices: 2 },
    solution: [m('spiral', { size: 'medium' }), m('siphon')],
  },
  {
    id: 'siphon-bamboo', name: '쏟아지면 우는 대나무', chapter: 1, source: 5.4,
    story: '사이펀이 한꺼번에 쏟은 물을 대나무 통이 받아 “딱” 하고 울려요. 사이펀 두 번, 시시오도시 네 번이에요.',
    tip: { title: '장치 이어 쓰기', text: '앞 장치가 물을 내보내는 방식에 따라 뒤 장치의 움직임이 달라져요. 사이펀의 큰 물살은 시시오도시를 금세 채워요.' },
    hints: ['벨 사이펀 다음에 연꽃 연못을 놓고, 연못의 출구를 시시오도시로 고르세요.', '벨 사이펀 → 연꽃 연못(보통, 시시오도시) 두 장치면 돼요.'],
    locked: [], palette: ['siphon', 'pond', 'spiral', 'maze'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'surges', count: 2 }, { kind: 'knocks', count: 4 }, { kind: 'reach', within: 60 }], par: { time: 30, devices: 2 },
    solution: [m('siphon'), m('pond', { exit: 'tipper' })],
  },

  // 3장 · 끌어올리는 힘
  {
    id: 'low-spring', name: '낮은 샘', chapter: 2, source: 2.6,
    story: '샘이 너무 낮아 미로 두 개를 지날 수 없어요. 물을 다시 끌어올려야 해요.',
    tip: { device: 'screw', title: '아르키메데스 스크류', text: '기울어진 나선이 돌며 물을 한 칸씩 밀어 올려요. 물이 다시 높아지니 뒤에 장치를 더 놓을 수 있어요.' },
    hints: ['놓여 있는 미로 수조 뒤에 아르키메데스 스크류를 넣으세요.', '스크류(보통) 다음에 미로 수조(작게)를 놓으면 끝까지 흘러요.'],
    locked: [m('maze', { size: 'small', seed: 12 })], palette: ['maze', 'pond', 'screw', 'noria'], exits: ['plain'],
    goals: [{ kind: 'min-devices', count: 3 }, { kind: 'reach', within: 90 }], par: { time: 40, devices: 2 },
    solution: [m('screw', { size: 'medium' }), m('maze', { size: 'small', seed: 13 })],
  },
  {
    id: 'noria-lift', name: '물레방아의 힘', chapter: 2, source: 2.4,
    story: '노리아 물레방아가 물을 떠 올려 꼭대기 수로로 부어요. 낮은 샘에서 수조 세 개를 지나 보세요.',
    tip: { device: 'noria', title: '노리아 물레방아', text: '거대한 물레의 통이 물을 떠 올려 꼭대기 수로로 부어요. 수로는 바퀴 옆으로 나가니, 왼쪽·오른쪽 중 겹치지 않는 쪽을 고르세요.' },
    hints: ['수조 하나를 지난 뒤 노리아로 물을 끌어올리세요.', '연꽃 연못(작게) → 노리아(보통) → 계단 폭포(작게) 순서로 놓아 보세요.'],
    locked: [], palette: ['pond', 'noria', 'terraces', 'maze'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'noria' }, { kind: 'min-devices', count: 3 }, { kind: 'reach', within: 120 }], par: { time: 55, devices: 3 },
    solution: [m('pond', { size: 'small' }), m('noria', { size: 'medium' }), m('terraces', { size: 'small' })],
  },
  {
    id: 'maze-trilogy', name: '셋째 미로까지', chapter: 2, source: 3.2,
    story: '미로 수조 세 개를 모두 지나는 긴 길 찾기예요. 샘의 높이만으로는 셋째 미로까지 갈 수 없어요.',
    tip: { title: '끌어올리는 자리', text: '양수 장치는 물이 낮아진 곳에 두어야 가장 큰 힘을 내요. 높이 여유가 바닥나는 곳을 찾아보세요.' },
    hints: ['미로 두 개를 지난 다음 양수 장치를 넣으세요.', '미로(작게) → 미로(작게) → 스크류(보통) → 미로(작게) 순서가 잘 맞아요.'],
    locked: [], palette: ['maze', 'screw', 'noria', 'pond'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'maze', count: 3 }, { kind: 'reach', within: 160 }], par: { time: 65, devices: 4 },
    solution: [m('maze', { size: 'small', seed: 51 }), m('maze', { size: 'small', seed: 52 }), m('screw', { size: 'medium' }), m('maze', { size: 'small', seed: 53 })],
  },
  {
    id: 'spiral-tower', name: '나선 탑', chapter: 2, source: 3.2,
    story: '낮은 연못에서 시작해 노리아로 물을 올리고, 나선 탑을 한 바퀴 넘게 돌려 보내요.',
    tip: { device: 'spiral', title: '나선 활강로 탑', text: '탑 꼭대기 탱크로 들어간 물이 나선 수로를 따라 빙글빙글 내려와요. 크기가 클수록 더 많이 돌고 높이도 더 써요.' },
    hints: ['놓여 있는 연못 뒤에 노리아를 넣고, 그다음에 나선 활강로 탑을 놓으세요.', '노리아(보통) → 나선 활강로 탑(보통)이면 돼요.'],
    locked: [m('pond', { size: 'small' })], palette: ['noria', 'screw', 'spiral', 'pond'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'noria' }, { kind: 'use', device: 'spiral' }, { kind: 'reach', within: 120 }], par: { time: 65, devices: 2 },
    solution: [m('noria', { size: 'medium' }), m('spiral', { size: 'medium' })],
  },
  {
    id: 'siphon-tower', name: '높은 곳의 사이펀', chapter: 2, source: 2.1,
    story: '사이펀은 높은 곳에서만 물을 쏟을 수 있어요. 낮은 샘의 물을 끌어올려 사이펀을 두 번 걸어 보세요.',
    tip: { title: '높이가 많이 드는 장치', text: '벨 사이펀은 아래로 쏟아낼 자리가 있어야 해서 높이를 2 m 가까이 써요. 양수 장치 바로 뒤에 두면 좋아요.' },
    hints: ['양수 장치로 물을 먼저 올린 뒤 벨 사이펀을 놓으세요.', '노리아(보통) → 벨 사이펀이면 별 세 개예요.'],
    locked: [], palette: ['noria', 'screw', 'siphon', 'pond'], exits: ['plain'],
    goals: [{ kind: 'surges', count: 2 }, { kind: 'reach', within: 90 }], par: { time: 50, devices: 2 },
    solution: [m('noria', { size: 'medium' }), m('siphon')],
  },

  // 4장 · 다리와 물살
  {
    id: 'zigzag-run', name: '굽이치는 물살', chapter: 3, source: 4.0,
    story: '좌우로 꺾이는 수로 두 개를 이어, 물살이 모서리를 타고 도는 길을 만들어요.',
    tip: { device: 'zigzag', title: '지그재그 수로', text: '좌우로 꺾이며 내려가는 경사 수로예요. 수로는 수조보다 물이 빨리 지나가요.' },
    hints: ['지그재그 수로를 두 번 넣으세요.', '지그재그 수로(작게) 두 개면 별 세 개예요.'],
    locked: [], palette: ['zigzag', 'pond', 'maze'], exits: ['plain'],
    goals: [{ kind: 'use', device: 'zigzag', count: 2 }, { kind: 'reach', within: 45 }], par: { time: 20, devices: 2 },
    solution: [m('zigzag', { size: 'small' }), m('zigzag', { size: 'small' })],
  },
  {
    id: 'few-devices', name: '적게, 멀리', chapter: 3, source: 4.6,
    story: '장치는 최대 세 개. 그중 하나는 하늘을 건너는 긴 수도교여야 해요.',
    tip: { device: 'aqueduct', title: '수도교', text: '기둥 위로 길게 뻗은 수로예요. 높이를 조금만 쓰면서 물을 멀리, 빠르게 보내요.' },
    hints: ['수도교를 크게 놓으면 한 번에 멀리 갈 수 있어요.', '수도교(크게) → 연꽃 연못(작게) 두 장치면 별 세 개예요.'],
    locked: [], palette: ['aqueduct', 'maze', 'pond', 'zigzag'], exits: ['plain', 'tipper'],
    goals: [{ kind: 'max-devices', count: 3 }, { kind: 'use', device: 'aqueduct' }, { kind: 'reach', within: 60 }], par: { time: 22, devices: 2 },
    solution: [m('aqueduct', { size: 'large' }), m('pond', { size: 'small' })],
  },
  {
    id: 'no-pumps', name: '펌프 없이 멀리', chapter: 3, source: 5.4,
    story: '양수 장치 없이 장치 네 개를 모두 지나 끝까지 가야 해요. 높이를 아껴 쓰세요.',
    tip: { title: '높이 아끼기', text: '수도교와 연꽃 연못은 높이를 가장 적게 써요. 판정 상자의 높이 여유를 보며 장치를 고르세요.' },
    hints: ['높이를 적게 쓰는 장치부터 골라 네 개를 이어 보세요.', '수도교(작게) → 지그재그 수로(작게, 왼쪽) → 연꽃 연못(작게, 오른쪽) → 미로 수조(작게) 순서예요.'],
    locked: [], palette: ['maze', 'pond', 'terraces', 'zigzag', 'aqueduct'], exits: ['plain', 'chain'],
    goals: [{ kind: 'min-devices', count: 4 }, { kind: 'no-lift' }, { kind: 'reach', within: 90 }], par: { time: 35, devices: 4 },
    solution: [m('aqueduct', { size: 'small' }), m('zigzag', { size: 'small', turn: 'left' }), m('pond', { size: 'small', turn: 'right' }), m('maze', { size: 'small', seed: 21 })],
  },
  {
    id: 'quick-flow', name: '서둘러, 종착 연못으로', chapter: 3, source: 4.6,
    story: '종착 연못이 기다려요. 장치 세 개를 지나 25초 안에 도착해야 해요.',
    tip: { title: '빠른 장치, 느린 장치', text: '미로와 계단에서는 물이 오래 머물고, 수도교와 연못은 빨리 지나가요. 시간이 빠듯할 때는 수로를 쓰세요.' },
    hints: ['미로 수조와 계단 폭포는 물이 천천히 지나가요. 수도교와 연꽃 연못을 써 보세요.', '수도교(작게) → 연꽃 연못(작게) → 수도교(작게)면 별 세 개예요.'],
    locked: [], palette: ['maze', 'terraces', 'pond', 'aqueduct', 'zigzag'], exits: ['plain'],
    goals: [{ kind: 'min-devices', count: 3 }, { kind: 'reach', within: 25 }], par: { time: 22, devices: 3 },
    solution: [m('aqueduct', { size: 'small' }), m('pond', { size: 'small' }), m('aqueduct', { size: 'small' })],
  },
  {
    id: 'grand-garden', name: '물의 대정원', chapter: 3, source: 3.6,
    story: '마지막 도전이에요. 스크류와 노리아를 모두 써서 장치 여섯 개 이상을 지나는 긴 여정을 완성하세요.',
    tip: { title: '마지막 여정', text: '지금까지 만난 장치를 모두 쓸 수 있어요. 높이가 모자라면 양수 장치를, 시간이 모자라면 수로를 떠올려 보세요.' },
    hints: ['미로 → 스크류 → 계단 → 노리아처럼, 높이를 쓰고 되찾기를 두 번 되풀이해 보세요.', '미로(작게) → 스크류(보통) → 계단(작게, 오른쪽) → 노리아(보통) → 지그재그(작게) → 연못(작게, 빗물 사슬) 순서예요.'],
    locked: [], palette: ['maze', 'terraces', 'pond', 'noria', 'screw', 'spiral', 'zigzag', 'aqueduct', 'siphon'], exits: ['plain', 'tipper', 'wheel', 'chain'],
    goals: [{ kind: 'min-devices', count: 6 }, { kind: 'use', device: 'screw' }, { kind: 'use', device: 'noria' }, { kind: 'reach', within: 200 }], par: { time: 110, devices: 6 },
    solution: [m('maze', { size: 'small', seed: 31 }), m('screw', { size: 'medium' }), m('terraces', { size: 'small', turn: 'right' }), m('noria', { size: 'medium' }), m('zigzag', { size: 'small' }), m('pond', { size: 'small', exit: 'chain' })],
  },
]

const name = (kind: CraftKind) => CRAFT_MODULES.find(item => item.kind === kind)!.name
export const EXIT_NAMES: Record<CraftExit, string> = { plain: '물길', tipper: '시시오도시', wheel: '물레바퀴', chain: '빗물 사슬' }

export function goalText(goal: ChallengeGoal): string {
  switch (goal.kind) {
    case 'reach': return `${goal.within}초 안에 종착 연못까지`
    case 'knocks': return `시시오도시 ${goal.count}번 울리기`
    case 'surges': return `사이펀 ${goal.count}번 쏟기`
    case 'max-devices': return `장치 ${goal.count}개 이하`
    case 'min-devices': return `장치 ${goal.count}개 이상`
    case 'use': return (goal.count ?? 1) > 1 ? `${name(goal.device)} ${goal.count}개 쓰기` : `${name(goal.device)} 쓰기`
    case 'use-exit': return `${EXIT_NAMES[goal.exit]} 출구 ${goal.count}개`
    case 'no-lift': return '양수 장치 없이'
  }
}

/** Where a goal stands right now, e.g. "1/3" or "12초", for the goal list; null when there is nothing to count. */
export function goalProgress(goal: ChallengeGoal, course: CraftCourse, progress: GardenProgress | null, time: number): string | null {
  switch (goal.kind) {
    case 'knocks': return `${Math.min(goal.count, progress?.knocks ?? 0)}/${goal.count}`
    case 'surges': return `${Math.min(goal.count, progress?.surges ?? 0)}/${goal.count}`
    case 'min-devices': case 'max-devices': return `지금 ${course.modules.length}개`
    case 'use': return (goal.count ?? 1) > 1 ? `${course.modules.filter(module => module.kind === goal.device).length}/${goal.count}` : null
    case 'use-exit': return goal.count > 1 ? `${course.modules.filter(module => module.exit === goal.exit).length}/${goal.count}` : null
    case 'reach': {
      if (progress?.arrival !== null && progress?.arrival !== undefined) return `${progress.arrival.toFixed(0)}초`
      return time > 0 ? `${Math.min(time, goal.within).toFixed(0)}초` : null
    }
    case 'no-lift': return null
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
      case 'use': return kinds.filter(kind => kind === goal.device).length >= (goal.count ?? 1) ? 'met' : 'failed'
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

/** Goals about the course itself: they can be checked before any water runs. */
export const isCourseGoal = (goal: ChallengeGoal) =>
  goal.kind === 'max-devices' || goal.kind === 'min-devices' || goal.kind === 'use' || goal.kind === 'use-exit' || goal.kind === 'no-lift'

export interface StarBreakdown {
  /** All goals met. */
  goals: boolean
  /** Arrived within par time (and the arrival time used). */
  time: boolean
  arrival: number
  /** Built with at most par devices (and the number added). */
  devices: boolean
  added: number
  /** The answer was shown for this attempt: stars are capped at one. */
  assisted: boolean
  stars: number
}

/** Stars for a cleared stage: 1 for the goals, +1 on par time, +1 on par device count; one only with the answer shown. */
export function starBreakdown(challenge: Challenge, course: CraftCourse, progress: GardenProgress, clearedAt: number, assisted = false): StarBreakdown {
  const added = course.modules.length - challenge.locked.length
  const arrival = progress.arrival ?? clearedAt
  const time = arrival <= challenge.par.time
  const devices = added <= challenge.par.devices
  return { goals: true, time, arrival, devices, added, assisted, stars: assisted ? 1 : 1 + (time ? 1 : 0) + (devices ? 1 : 0) }
}

export function starsFor(challenge: Challenge, course: CraftCourse, progress: GardenProgress, clearedAt: number, assisted = false): number {
  return starBreakdown(challenge, course, progress, clearedAt, assisted).stars
}

/** The course a stage starts from, and a check that the player kept its rules. */
export function challengeCourse(challenge: Challenge, added: CraftModule[] = []): CraftCourse {
  return { version: 1, name: challenge.name, source: challenge.source, modules: [...challenge.locked, ...added] }
}

/** Stages of a chapter, in play order. */
export function chapterStages(chapter: number): Challenge[] {
  return CHALLENGES.filter(stage => stage.chapter === chapter)
}

/** 1-based number of a stage in the campaign. */
export const stageNumber = (challenge: Challenge) => CHALLENGES.indexOf(challenge) + 1
