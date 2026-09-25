import {
  compileCraft, CRAFT_EXITS, CRAFT_MODULES, hasSpout, objectOf,
  type CraftCourse, type CraftExit, type CraftKind, type CraftModule, type CraftResult, type CraftSize, type CraftTurn,
} from './craft'

/**
 * Craft advisor: when a course cannot be built, it tries the edits a person
 * would try (turn a device, resize it, change an exit, raise the source,
 * put in a lift, drop or reorder a device), compiles each, and offers the
 * ones that work, cheapest first, with the numbers that change.
 */
export interface CraftAdvice {
  id: string
  title: string
  detail: string
  course: CraftCourse
  /** How big an edit it is (lower is suggested first). */
  cost: number
}

const TURN_NAMES: Record<CraftTurn, string> = { left: '왼쪽', straight: '직진', right: '오른쪽' }
const SIZES: CraftSize[] = ['small', 'medium', 'large']
const TURNS: CraftTurn[] = ['straight', 'left', 'right']
const SOURCE_MAX = 6.5
const info = (kind: CraftKind) => CRAFT_MODULES.find(item => item.kind === kind)!
const sizeName = (module: CraftModule) => info(module.kind).sizes[SIZES.indexOf(module.size)]
const exitName = (exit: CraftExit) => CRAFT_EXITS.find(item => item.exit === exit)!.name
const label = (course: CraftCourse, index: number) => `${index + 1}번 ${info(course.modules[index].kind).name}`

/** Height the water still has where the receiving pond goes (m). */
export function spareHeight(result: CraftResult): number {
  const last = result.stages[result.stages.length - 1]
  return last ? Math.max(0, last.handoff - 0.6) : 0
}

const works = (course: CraftCourse) => {
  const result = compileCraft(course)
  return result.issues.length ? null : result
}

let serial = 0
const liftModule = (kind: 'screw' | 'noria', size: CraftSize): CraftModule =>
  ({ id: `${kind}-advice-${serial++}`, kind, turn: 'straight', exit: 'plain', size, seed: 1, wheels: false })

export function adviseCraft(course: CraftCourse, result: CraftResult = compileCraft(course), limit = 4): CraftAdvice[] {
  const issue = result.issues[0]
  if (!issue || issue.problem === 'empty') return []
  const modules = course.modules
  const failing = Math.min(issue.module, modules.length - 1)
  const advice: CraftAdvice[] = []
  const seen = new Set<string>()
  const offer = (id: string, cost: number, title: string, next: CraftCourse, detail: (after: CraftResult) => string) => {
    if (seen.has(id)) return
    seen.add(id)
    const after = works(next)
    if (after) advice.push({ id, title, detail: detail(after), course: next, cost })
  }
  const edit = (index: number, change: Partial<CraftModule>): CraftCourse =>
    ({ ...course, modules: modules.map((module, k) => k === index ? { ...module, ...change } : module) })
  const heightNote = (after: CraftResult) => `종착 연못까지 높이 여유 ${spareHeight(after).toFixed(1)} m`

  // Devices whose placement decides the problem: the failing one, the one
  // before it (its exit and direction set where and how high the water
  // arrives), and whatever it runs into.
  const involved = new Set([failing, failing - 1].filter(k => k >= 0))
  if (result.plan.failure?.clashWith !== undefined && result.plan.failure.clashWith >= 0) involved.add(result.plan.failure.clashWith)
  const clash = issue.problem === 'clash' || issue.problem === 'finish-clash'

  for (const index of involved) {
    const module = modules[index]
    const nearby = index === failing ? 0 : 0.5
    for (const turn of TURNS) if (turn !== module.turn) {
      offer(`turn-${index}-${turn}`, 1 + nearby, `${label(course, index)} 방향: ${TURN_NAMES[module.turn]} → ${TURN_NAMES[turn]}`,
        edit(index, { turn }), after => clash ? '앞의 장치와 겹치지 않는 쪽으로 물길을 돌려요' : heightNote(after))
    }
    for (const size of SIZES) if (size !== module.size && info(module.kind).sizes[0] !== '—') {
      const smaller = SIZES.indexOf(size) < SIZES.indexOf(module.size)
      offer(`size-${index}-${size}`, 1.2 + nearby, `${label(course, index)} 크기: ${sizeName(module)} → ${info(module.kind).sizes[SIZES.indexOf(size)]}`,
        edit(index, { size }), after => clash ? (smaller ? '자리를 덜 차지해 겹치지 않아요' : '물이 떨어지는 자리가 옮겨져 겹치지 않아요') : heightNote(after))
    }
    if (hasSpout(module.kind)) for (const { exit } of CRAFT_EXITS) if (exit !== module.exit) {
      offer(`exit-${index}-${exit}`, 1.4 + nearby, `${label(course, index)} 출구: ${exitName(module.exit)} → ${exitName(exit)}`,
        edit(index, { exit }), after => module.exit === 'tipper' && issue.problem !== 'tipper'
          ? `시시오도시가 쓰던 높이 0.5 m를 아껴요 · ${heightNote(after)}` : heightNote(after))
    }
  }

  if (!clash && issue.problem !== 'tipper') {
    // The lowest source height (0.1 m steps) that carries the course through.
    for (let source = Math.round(course.source * 10) / 10 + 0.1; source <= SOURCE_MAX + 1e-9; source += 0.1) {
      const next = { ...course, source: Math.round(source * 10) / 10 }
      if (!works(next)) continue
      offer('source', 1 + (next.source - course.source), `수원 높이: ${course.source.toFixed(1)} m → ${next.source.toFixed(1)} m`, next,
        after => `물이 ${(next.source - course.source).toFixed(1)} m 더 높은 곳에서 출발해요 · ${heightNote(after)}`)
      break
    }
    // A lift in front of the device that ran out of height.
    const at = Math.min(issue.module, modules.length)
    for (const [kind, size] of [['screw', 'small'], ['screw', 'medium'], ['noria', 'medium'], ['screw', 'large']] as const) {
      const lift = liftModule(kind, size)
      const next = { ...course, modules: [...modules.slice(0, at), lift, ...modules.slice(at)] }
      offer(`lift-${kind}`, 2.5 + (kind === 'noria' ? 0.3 : 0) + SIZES.indexOf(size) * 0.1,
        at >= modules.length ? `끝에 ${info(kind).name}(${info(kind).sizes[SIZES.indexOf(size)]}) 넣기` : `${at + 1}번 앞에 ${info(kind).name}(${info(kind).sizes[SIZES.indexOf(size)]}) 넣기`,
        next, after => `모터가 물을 다시 끌어올려요 · ${heightNote(after)}`)
    }
  }

  // Still stuck: any device's direction, then two directions at once.
  if (!advice.length) {
    modules.forEach((module, index) => {
      for (const turn of TURNS) if (turn !== module.turn) {
        offer(`turn-${index}-${turn}`, 1.5 + Math.abs(failing - index) * 0.2, `${label(course, index)} 방향: ${TURN_NAMES[module.turn]} → ${TURN_NAMES[turn]}`,
          edit(index, { turn }), after => clash ? '물길 전체가 돌아가 겹치지 않아요' : heightNote(after))
      }
    })
  }
  if (!advice.length) {
    const pairs = [...involved].flatMap(i => modules.map((_, j) => [i, j] as const)).filter(([i, j]) => i < j || !involved.has(j))
    for (const [i, j] of pairs) for (const first of TURNS) for (const second of TURNS) {
      if (i === j || (first === modules[i].turn && second === modules[j].turn)) continue
      const next = { ...course, modules: modules.map((module, k) => k === i ? { ...module, turn: first } : k === j ? { ...module, turn: second } : module) }
      offer(`turns-${i}-${first}-${j}-${second}`, 2.2, `${label(course, i)} ${TURN_NAMES[first]}, ${label(course, j)} ${TURN_NAMES[second]}으로`,
        next, () => '두 장치의 방향을 함께 바꿔 겹치지 않게 해요')
      if (advice.length >= limit) break
    }
  }

  // Reorder or drop the device as a last resort.
  if (failing > 0) {
    const swapped = modules.slice();
    [swapped[failing - 1], swapped[failing]] = [swapped[failing], swapped[failing - 1]]
    offer('swap-up', 3, `${objectOf(label(course, failing))} 한 칸 위로`, { ...course, modules: swapped }, heightNote)
  }
  if (modules.length > 1) {
    offer('remove', 4, `${label(course, failing)} 빼기`, { ...course, modules: modules.filter((_, k) => k !== failing) }, heightNote)
  }

  return advice.sort((a, b) => a.cost - b.cost).slice(0, limit)
}
