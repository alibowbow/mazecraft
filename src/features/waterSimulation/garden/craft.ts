import {
  along, circle, filleted, helix, lattice, latticeRim, NORIA_CLEARANCE, NORIA_TROUGH_DROP, originFor, RIM, roundBasin, roundedRect,
  routeSills, source, withCompanions, type Cell, type GardenDesign, type PlantKind, type Side, type SpoutDevice, type Vec3, type VesselSpec,
} from './designs'
import { tipperFrame, tipperLanding } from './mechanics'
import type { Vec2 } from './polygon'

/**
 * Craft mode: a water course assembled from modules in the order the water
 * visits them. Each module is laid out where the previous one delivers its
 * water, as high as the water still is; heights, clearances and collisions
 * are checked as the course is built, and the result is an ordinary garden
 * design that the physics engine runs like any preset.
 */
export type CraftKind = 'maze' | 'terraces' | 'pond' | 'noria' | 'screw' | 'spiral' | 'zigzag' | 'aqueduct' | 'siphon'
export type CraftExit = 'plain' | 'tipper' | 'wheel' | 'chain'
export type CraftTurn = 'straight' | 'left' | 'right'
export type CraftSize = 'small' | 'medium' | 'large'

export interface CraftModule {
  id: string
  kind: CraftKind
  turn: CraftTurn
  exit: CraftExit
  size: CraftSize
  seed: number
  /** Paddle wheels over the steps (maze basins and terraces). */
  wheels: boolean
}

export interface CraftCourse {
  version: 1
  name: string
  /** Height of the source lip (m). */
  source: number
  modules: CraftModule[]
}

export interface CraftIssue { module: number; message: string }

export interface CraftStage {
  module: number
  /** Top of the module's highest basin and the water height it hands on. */
  top: number
  handoff: number
}

export interface CraftResult {
  design: GardenDesign | null
  issues: CraftIssue[]
  stages: CraftStage[]
}

export interface CraftModuleInfo {
  kind: CraftKind
  name: string
  description: string
  category: 'basin' | 'lift' | 'channel' | 'special'
  /** Has a spout whose device can be chosen. */
  spout: boolean
  sizes: [string, string, string]
  /** Adds (+) or spends (−) height, roughly (m). */
  height: string
}

export const CRAFT_MODULES: CraftModuleInfo[] = [
  { kind: 'maze', name: '미로 수조', description: '벽 사이로 물이 길을 찾아 흐르는 도자기 미로. 계단 둑마다 물이 넘어갑니다.', category: 'basin', spout: true, sizes: ['3×3', '4×3', '5×4'], height: '−1.0 m' },
  { kind: 'terraces', name: '계단 폭포', description: '층층이 낮아지는 수로. 둑마다 얇은 물막이 떨어지고 물레가 돌 수 있어요.', category: 'basin', spout: true, sizes: ['2단', '3단', '4단'], height: '−0.9~1.2 m' },
  { kind: 'pond', name: '연꽃 연못', description: '가운데 화분 섬을 두른 둥근 연못. 물이 잔잔히 머물다 흘러갑니다.', category: 'basin', spout: true, sizes: ['작게', '보통', '크게'], height: '−0.8 m' },
  { kind: 'noria', name: '노리아 물레방아', description: '모터가 돌리는 거대한 물레. 통이 물을 떠 올려 옆 수로로 붓습니다. 좌·우로 수로 방향을 고릅니다.', category: 'lift', spout: false, sizes: ['R 1.5 m', 'R 1.85 m', 'R 2.2 m'], height: '+2~3 m' },
  { kind: 'screw', name: '아르키메데스 스크류', description: '기울어진 나선이 돌며 물 주머니를 한 칸씩 밀어 올립니다.', category: 'lift', spout: false, sizes: ['3.5 m', '4.5 m', '5.5 m'], height: '+1.5~2.5 m' },
  { kind: 'spiral', name: '나선 활강로 탑', description: '탑 꼭대기 탱크에서 나선 수로를 따라 빙글빙글 내려옵니다.', category: 'channel', spout: false, sizes: ['¾바퀴', '1¼바퀴', '2바퀴'], height: '−1.0~1.4 m' },
  { kind: 'zigzag', name: '지그재그 수로', description: '좌우로 꺾이며 내려가는 경사 수로. 물살이 모서리를 타고 돕니다.', category: 'channel', spout: false, sizes: ['3굽이', '4굽이', '5굽이'], height: '−0.8~1.1 m' },
  { kind: 'aqueduct', name: '수도교', description: '기둥 위로 길게 뻗은 수로. 물이 높은 곳을 가로질러 건너갑니다.', category: 'channel', spout: false, sizes: ['3 m', '5 m', '7 m'], height: '−0.8 m' },
  { kind: 'siphon', name: '벨 사이펀', description: '물이 차오르다 어느 순간 사이펀이 걸려 한꺼번에 쏟아냅니다.', category: 'special', spout: false, sizes: ['—', '—', '—'], height: '−1.3 m' },
]

export const CRAFT_EXITS: { exit: CraftExit; name: string; description: string }[] = [
  { exit: 'plain', name: '물길', description: '곧게 떨어지는 물막이' },
  { exit: 'tipper', name: '시시오도시', description: '대나무 통이 차면 기울어 쏟고 “딱” 돌아옵니다 (넓은 수조 앞에만)' },
  { exit: 'wheel', name: '물레바퀴', description: '떨어지는 물이 바퀴 통을 채워 돌립니다' },
  { exit: 'chain', name: '빗물 사슬', description: '구리 컵 사슬을 따라 졸졸 흘러내립니다' },
]

const DIRS: Vec2[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
const SIDES: Side[] = ['south', 'east', 'north', 'west']
const turnHeading = (heading: number, turn: CraftTurn) => turn === 'left' ? (heading + 1) % 4 : turn === 'right' ? (heading + 3) % 4 : heading
const angleOf = (v: Vec2) => Math.atan2(v[1], v[0])

interface Cursor { landing: Vec2; heading: number; maxTop: number; maxLevel: number }
interface Box { minX: number; minY: number; maxX: number; maxY: number }

class CraftError extends Error {}

/** Room a spout leaves below it, by device (see the garden tests' clearances). */
function afterSpout(crest: number, exit: CraftExit): { maxTop: number; maxLevel: number } {
  return { maxTop: crest - 0.28, maxLevel: exit === 'tipper' ? crest - 0.8 : exit === 'chain' ? crest - 0.36 : crest - 0.32 }
}

function spoutDevice(exit: CraftExit): SpoutDevice | undefined {
  return exit === 'plain' ? undefined : exit
}

/** Where a spout's water comes down, as the layout compiler will find it. */
function spoutLandingFor(at: Vec2, direction: Vec2, rimWidth: number, length: number, exit: CraftExit, crest: number): Vec2 {
  const lipEnd = along(at, direction, [0, 0], rimWidth / 2 + length, 0)
  if (exit === 'tipper') return tipperLanding(tipperFrame(lipEnd, direction, crest))
  return along(lipEnd, direction, [0, 0], exit === 'chain' ? 0.06 : 0.25, 0)
}

function boxOf(points: readonly Vec2[], pad = 0): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [x, y] of points) {
    box.minX = Math.min(box.minX, x - pad); box.maxX = Math.max(box.maxX, x + pad)
    box.minY = Math.min(box.minY, y - pad); box.maxY = Math.max(box.maxY, y + pad)
  }
  return box
}

const overlaps = (a: Box, b: Box, shrink = 0) =>
  a.minX + shrink < b.maxX - shrink && b.minX + shrink < a.maxX - shrink && a.minY + shrink < b.maxY - shrink && b.minY + shrink < a.maxY - shrink

interface BuildContext {
  module: CraftModule
  index: number
  cursor: Cursor
  /** Cantilever the module's spout needs so the next module fits below it. */
  spoutLength: number
  /** Whether the next module can take a tipping tube over it. */
  nextTakesTipper: boolean
}

interface Built {
  vessels: VesselSpec[]
  next: Cursor
  boxes: Box[]
  /** Troughs that carry the water on: they may reach into the next module. */
  handoff?: Box[]
  top: number
}

const name = (ctx: BuildContext, part: string) => `m${ctx.index}-${part}`

function checkExit(ctx: BuildContext): void {
  if (ctx.module.exit === 'tipper' && !ctx.nextTakesTipper) throw new CraftError('시시오도시는 넓은 수조(미로·계단·연못·양수 수조) 앞에만 놓을 수 있어요. 다음 장치를 바꾸거나 출구 장치를 바꿔 주세요.')
}

function floorFor(ctx: BuildContext, wallHeight: number, levelAboveFloor: number, what: string): number {
  const floor = Math.min(ctx.cursor.maxTop - wallHeight, ctx.cursor.maxLevel - levelAboveFloor)
  if (floor < 0.06) throw new CraftError(`${what}을(를) 놓을 높이가 부족해요 (${Math.max(0, floor + wallHeight).toFixed(1)} m 남음). 앞에 양수 장치(노리아·스크류)를 넣거나 수원을 높여 주세요.`)
  return floor
}

/** Finish a spout on a vessel: its landing and the room it leaves below. */
function spoutExit(ctx: BuildContext, at: Vec2, direction: Vec2, rimWidth: number, crest: number, heading: number): Cursor {
  const landing = spoutLandingFor(at, direction, rimWidth, ctx.spoutLength, ctx.module.exit, crest)
  return { landing, heading, ...afterSpout(crest, ctx.module.exit) }
}

function mazeModule(ctx: BuildContext): Built {
  checkExit(ctx)
  const { module, cursor } = ctx
  const [across, length] = ({ small: [3, 3], medium: [4, 3], large: [5, 4] } as const)[module.size]
  const pitch = 1.1
  const h = cursor.heading, d = DIRS[h], l = DIRS[(h + 1) % 4]
  const vertical = d[0] === 0
  const cols = vertical ? across : length, rows = vertical ? length : across
  const iOff = -Math.min(0, (length - 1) * d[0]) - Math.min(0, (across - 1) * l[0])
  const jOff = -Math.min(0, (length - 1) * d[1]) - Math.min(0, (across - 1) * l[1])
  const cellAt = (a: number, c: number): Cell => ({ i: iOff + a * d[0] + c * l[0], j: jOff + a * d[1] + c * l[1] })
  const entryC = Math.floor(across / 2)
  const entry = cellAt(0, entryC)
  const e = turnHeading(h, module.turn)
  const exitCell = module.turn === 'straight' ? cellAt(length - 1, across > 1 ? (entryC + 1 + module.seed % (across - 1)) % across : 0)
    : module.turn === 'left' ? cellAt(length - 1, across - 1) : cellAt(length - 1, 0)
  const exit = { ...exitCell, side: SIDES[e] }
  const maze = lattice({ cols, rows, pitch, origin: originFor(cursor.landing, entry, pitch), seed: `craft-maze-${module.seed}`, entry, exits: [exit], straightness: 0.4 })
  const fractions = ({ small: [0.5], medium: [0.34, 0.67], large: [0.25, 0.5, 0.75] } as const)[module.size]
  const sills = routeSills(maze, maze.routes[0], [...fractions], () => false)
  const wallHeight = 0.84, firstCrest = 0.22
  const floor = floorFor(ctx, wallHeight, firstCrest + 0.12, '미로 수조')
  const spout = maze.spout(exit)
  const crest = firstCrest - 0.07 * sills.length
  const vessel: VesselSpec = {
    name: name(ctx, 'maze'), floor, wallHeight, wallWidth: 0.32, rimWidth: RIM,
    outline: latticeRim(maze, 0.75), walls: maze.walls, islands: [],
    sills: sills.map((sill, k) => ({ points: sill.points, crest: firstCrest - 0.07 * k, wheel: module.wheels && k % 2 === 0 })),
    spouts: [{ ...spout, width: 0.7, crest, length: ctx.spoutLength, device: spoutDevice(module.exit) }],
    floors: sills.map((sill, k) => ({ seed: maze.center(sill.downstream), offset: -0.1 * (k + 1) })),
    planters: [],
  }
  const { x0, y0, x1, y1 } = maze.bounds
  return { vessels: [vessel], next: spoutExit(ctx, spout.at, spout.direction, RIM, floor + crest, e), boxes: [boxOf([[x0, y0], [x1, y1]], RIM / 2)], top: floor + wallHeight }
}

function terracesModule(ctx: BuildContext): Built {
  checkExit(ctx)
  const { module, cursor } = ctx
  const steps = ({ small: 2, medium: 3, large: 4 } as const)[module.size]
  const run = 1.3, half = 0.75, rim = 0.4, drop = 0.12
  const h = cursor.heading, d = DIRS[h], l = DIRS[(h + 1) % 4]
  const map = (a: number, c: number): Vec2 => along(cursor.landing, d, l, a, c)
  const back = -0.55, frontFace = back + steps * run
  const centreA = (back + frontFace) / 2
  const outline = roundedRect(0, 0, steps * run + rim, half * 2 + rim, 0.55).map(([a, c]) => map(centreA + a, c))
  const wallHeight = 0.8
  const floor = floorFor(ctx, wallHeight, 0.2 + 0.12, '계단 폭포')
  const edge = half + rim / 2
  const sills = Array.from({ length: steps - 1 }, (_, k) => {
    const a = back + run * (k + 1)
    return { points: [map(a, -edge), map(a, edge)], crest: 0.2 - drop * k, wheel: module.wheels }
  })
  const floors = Array.from({ length: steps - 1 }, (_, k) => ({ seed: map(back + run * (k + 1) + run / 2, 0), offset: -drop * (k + 1) }))
  const e = turnHeading(h, module.turn)
  const lastCentre = back + run * (steps - 1) + run / 2
  const [at, direction]: [Vec2, Vec2] = module.turn === 'straight' ? [map(frontFace + rim / 2, 0), d]
    : module.turn === 'left' ? [map(lastCentre, edge), l] : [map(lastCentre, -edge), [-l[0], -l[1]]]
  const crest = 0.2 - drop * (steps - 1)
  const vessel: VesselSpec = {
    name: name(ctx, 'terraces'), floor, wallHeight, wallWidth: 0.3, rimWidth: rim, outline, walls: [], islands: [],
    sills, spouts: [{ at, direction, width: 0.6, crest, length: ctx.spoutLength, device: spoutDevice(module.exit) }], floors, planters: [],
  }
  return { vessels: [vessel], next: spoutExit(ctx, at, direction, rim, floor + crest, e), boxes: [boxOf(outline, rim / 2)], top: floor + wallHeight }
}

function pondModule(ctx: BuildContext): Built {
  checkExit(ctx)
  const { module, cursor } = ctx
  const radius = ({ small: 1.3, medium: 1.6, large: 1.9 } as const)[module.size]
  const h = cursor.heading, d = DIRS[h]
  const centre = along(cursor.landing, d, [0, 0], radius - 0.75, 0)
  const wallHeight = 0.7
  const floor = floorFor(ctx, wallHeight, 0.32, '연꽃 연못')
  const e = turnHeading(h, module.turn), dir = DIRS[e]
  const at = along(centre, dir, [0, 0], radius, 0)
  const vessel = roundBasin(name(ctx, 'pond'), centre, radius, floor, wallHeight, 0.4, {
    islands: [circle(centre[0], centre[1], 0.34, 48)], planters: [centre],
    spouts: [{ at, direction: dir, width: 0.6, crest: 0.2, length: ctx.spoutLength, device: spoutDevice(module.exit) }],
  })
  return { vessels: [vessel], next: spoutExit(ctx, at, dir, 0.4, floor + 0.2, e), boxes: [boxOf(vessel.outline, 0.2)], top: floor + wallHeight }
}

function noriaModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  if (cursor.maxTop < 0.62 || cursor.maxLevel < 0.3) throw new CraftError('노리아 수조를 놓을 높이가 부족해요.')
  const R = ({ small: 1.5, medium: 1.85, large: 2.2 } as const)[module.size]
  const hub = NORIA_CLEARANCE + R, W = 0.5
  const h = cursor.heading, u = DIRS[h]
  // The trough leaves beside the wheel, along its axle, to the chosen side.
  const sideHeading = module.turn === 'right' ? (h + 3) % 4 : (h + 1) % 4
  const v = DIRS[sideHeading]
  const wheel = along(cursor.landing, u, v, R + 0.55, 0)
  const sumpFrom = -(R + 0.55) - 0.55, sumpTo = R + 0.45, sumpHalf = 1.05
  const sumpCentre = along(wheel, u, v, (sumpFrom + sumpTo) / 2, 0)
  const outline = roundedRect(0, 0, sumpTo - sumpFrom, sumpHalf * 2, sumpHalf * 0.95).map(([a, b]) => along(sumpCentre, u, [-u[1], u[0]], a, b))
  const troughZ = hub + R - NORIA_TROUGH_DROP
  const end: Vec3 = [...along(wheel, u, v, 0, 3.6), troughZ - 0.1]
  const sump: VesselSpec = {
    name: name(ctx, 'noria-sump'), floor: 0.05, wallHeight: 0.5, wallWidth: 0.3, rimWidth: 0.4, outline,
    walls: [], islands: [], sills: [], spouts: [], floors: [], planters: [],
    lifts: [{ center: wheel, direction: u, radius: R, hub, width: W, path: [[...along(wheel, u, v, 0, W / 2 + 0.06), troughZ], end] as Vec3[] }],
  }
  return {
    vessels: [sump], next: chuteExit(end, sideHeading), top: troughZ + 0.2,
    boxes: [boxOf(outline, 0.2)], handoff: [boxOf([along(wheel, u, v, 0, W / 2), [end[0], end[1]]], 0.35)],
  }
}

function screwModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  if (cursor.maxTop < 0.62 || cursor.maxLevel < 0.3) throw new CraftError('스크류 수조를 놓을 높이가 부족해요.')
  const L = ({ small: 3.5, medium: 4.5, large: 5.5 } as const)[module.size]
  const incline = Math.PI / 6, R = 0.3, hub = 0.25
  const h = cursor.heading, d = DIRS[h], l = DIRS[(h + 1) % 4]
  const sumpCentre = along(cursor.landing, d, l, 0.875, 0)
  const outline = roundedRect(0, 0, 2.85, 1.6, 0.6).map(([a, b]) => along(sumpCentre, d, l, a, b))
  const bottom = along(cursor.landing, d, l, 1.0, 0)
  const run = L * Math.cos(incline), top = along(bottom, d, l, run, 0), topZ = hub + L * Math.sin(incline)
  // The top pocket empties into a short trough that hands the water on.
  const e = turnHeading(h, module.turn)
  const side = module.turn === 'left' ? 1 : module.turn === 'right' ? -1 : 0
  const path: Vec3[] = side === 0
    ? [[...along(top, d, l, 0.08, 0), topZ - 0.3], [...along(top, d, l, 0.75, 0), topZ - 0.33]]
    : [[...along(top, d, l, 0.08, 0), topZ - 0.3], [...along(top, d, l, 0.45, 0), topZ - 0.315], [...along(top, d, l, 0.45, side * 0.8), topZ - 0.34]]
  const end = path[path.length - 1]
  const sump: VesselSpec = {
    name: name(ctx, 'screw-sump'), floor: 0.05, wallHeight: 0.5, wallWidth: 0.3, rimWidth: 0.35, outline,
    walls: [], islands: [], sills: [], spouts: [], floors: [], planters: [],
    lifts: [{ kind: 'screw', center: bottom, direction: d, radius: R, hub, width: 2 * R, length: L, incline, path }],
  }
  return {
    vessels: [sump], next: chuteExit(end, e), top: topZ,
    boxes: [boxOf(outline, 0.2)], handoff: [boxOf([bottom, top, [end[0], end[1]]], 0.4)],
  }
}

/** A cup on a tower that the incoming water falls into, feeding a chute. */
function chuteCup(ctx: BuildContext, radius: number, startAngle: number): { vessel: (path: Vec3[]) => VesselSpec; floor: number; crestZ: number; out: (r: number) => Vec2; top: number } {
  const { cursor } = ctx
  const top = Math.min(cursor.maxTop, cursor.maxLevel + 0.3)
  const floor = top - 0.5
  if (floor < 0.4) throw new CraftError('수로 탑을 세울 높이가 부족해요. 앞에 양수 장치를 넣어 주세요.')
  const centre = cursor.landing
  const out = (r: number): Vec2 => [centre[0] + Math.cos(startAngle) * r, centre[1] + Math.sin(startAngle) * r]
  return {
    floor, crestZ: floor + 0.1, out, top,
    vessel: path => roundBasin(name(ctx, 'chute-cup'), centre, radius, floor, 0.5, 0.24, {
      chutes: [{ at: out(radius), direction: [Math.cos(startAngle), Math.sin(startAngle)], width: 0.45, crest: 0.1, path }],
    }),
  }
}

function chuteExit(end: Vec3, heading: number): Cursor {
  return { landing: along([end[0], end[1]], DIRS[heading], [0, 0], 0.22, 0), heading, maxTop: end[2] - 0.2, maxLevel: end[2] - 0.25 }
}

function spiralModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  const h = cursor.heading, e = turnHeading(h, module.turn)
  const helixRadius = 1.05, cupRadius = 0.6
  const winding = module.turn === 'right' ? -1 : 1
  const a0 = angleOf(DIRS[(h + (winding > 0 ? 1 : 3)) % 4]), aEnd = angleOf(DIRS[e])
  const turns = ({ small: 0.75, medium: 1.25, large: 2 } as const)[module.size]
  let sweep = ((aEnd - a0) * winding % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  sweep = (sweep + Math.PI * 2 * Math.floor(turns)) * winding
  if (Math.abs(sweep) < Math.PI * 2 * turns - 1e-6) sweep += Math.PI * 2 * winding * Math.ceil(turns - Math.abs(sweep) / (Math.PI * 2))
  const cup = chuteCup(ctx, cupRadius, a0)
  const low = cup.crestZ - 0.24 * Math.abs(sweep) / (Math.PI * 2) - 0.1
  const spiral = helix(cursor.landing, helixRadius, a0, sweep, cup.crestZ - 0.02, low + 0.04)
  const end: Vec3 = [...along(cursor.landing, DIRS[e], [0, 0], helixRadius + 1.1, 0), low]
  const path: Vec3[] = [[...cup.out(cupRadius + 0.12), cup.crestZ], [...cup.out(helixRadius), cup.crestZ - 0.01], ...spiral.slice(1), end]
  const [cx, cy] = cursor.landing
  return {
    vessels: [cup.vessel(path)], next: chuteExit(end, e), top: cup.top,
    boxes: [boxOf(circle(cx, cy, helixRadius + 0.35))], handoff: [boxOf([cursor.landing, [end[0], end[1]]], 0.35)],
  }
}

function polylineChute(ctx: BuildContext, plan: Vec2[], dropPerMetre: number, extraDrop: number, heading: number, cupRadius: number): Built {
  const { cursor } = ctx
  const cup = chuteCup(ctx, cupRadius, angleOf(DIRS[cursor.heading]))
  const smooth = filleted(plan, 0.35)
  let length = 0
  const lengths = smooth.map((p, k) => (length += k ? Math.hypot(p[0] - smooth[k - 1][0], p[1] - smooth[k - 1][1]) : 0))
  const low = cup.crestZ - dropPerMetre * length - extraDrop
  const path: Vec3[] = smooth.map((p, k) => [p[0], p[1], cup.crestZ - (cup.crestZ - low) * lengths[k] / length])
  const end = path[path.length - 1]
  return {
    vessels: [cup.vessel(path)], next: chuteExit(end, heading), top: cup.top,
    boxes: [boxOf(circle(cursor.landing[0], cursor.landing[1], cupRadius + 0.2)), boxOf(smooth.slice(0, -1), 0.35)], handoff: [boxOf(smooth.slice(-2), 0.35)],
  }
}

function zigzagModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  const legs = ({ small: 3, medium: 4, large: 5 } as const)[module.size]
  const h = cursor.heading, d = DIRS[h], l = DIRS[(h + 1) % 4], e = turnHeading(h, module.turn)
  const map = (a: number, c: number): Vec2 => along(cursor.landing, d, l, a, c)
  const plan: Vec2[] = [map(0.67, 0)]
  let a = 0.67
  for (let k = 0; k < legs; k++) { a += 0.85; plan.push(map(a, (k % 2 === 0 ? 1 : -1) * 0.95)) }
  a += 0.5
  if (module.turn === 'straight') plan.push(map(a, 0), map(a + 0.8, 0))
  else { const side = module.turn === 'left' ? 1 : -1; plan.push(map(a, 0), map(a, side * 1.3)) }
  return polylineChute(ctx, plan, 0.035, 0.12, e, 0.55)
}

function aqueductModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  const span = ({ small: 3, medium: 5, large: 7 } as const)[module.size]
  const h = cursor.heading, d = DIRS[h], l = DIRS[(h + 1) % 4], e = turnHeading(h, module.turn)
  const map = (a: number, c: number): Vec2 => along(cursor.landing, d, l, a, c)
  const plan: Vec2[] = [map(0.67, 0), map(0.67 + span, 0)]
  if (module.turn !== 'straight') plan.push(map(0.67 + span, (module.turn === 'left' ? 1 : -1) * 1.4))
  else plan.push(map(0.67 + span + 0.6, 0))
  return polylineChute(ctx, plan, 0.015, 0.05, e, 0.55)
}

function siphonModule(ctx: BuildContext): Built {
  const { module, cursor } = ctx
  const h = cursor.heading, e = turnHeading(h, module.turn)
  const centre = along(cursor.landing, DIRS[h], [0, 0], 0.25, 0)
  const top = Math.min(cursor.maxTop, cursor.maxLevel + 0.5)
  const floor = top - 0.9
  const mouth = floor - 0.23
  if (mouth < 0.75) throw new CraftError('사이펀은 물을 아래로 쏟아내야 해서 높이가 1.9 m 이상 필요해요. 앞에 양수 장치를 넣어 주세요.')
  const out = along(centre, DIRS[e], [0, 0], 1.9, 0)
  const vessel = roundBasin(name(ctx, 'siphon-cistern'), centre, 0.85, floor, 0.9, 0.3, {
    siphons: [{ at: centre, trigger: 0.32, stop: 0.1, diameter: 0.42, path: [[...centre, floor + 0.05], [...centre, top + 0.17], [...out, top + 0.17], [...out, mouth]] as Vec3[] }],
  })
  return {
    vessels: [vessel], next: { landing: out, heading: e, maxTop: mouth - 0.12, maxLevel: mouth - 0.15 }, top,
    boxes: [boxOf(vessel.outline, 0.15)], handoff: [boxOf([centre, out], 0.3)],
  }
}

const BUILDERS: Record<CraftKind, (ctx: BuildContext) => Built> = {
  maze: mazeModule, terraces: terracesModule, pond: pondModule, noria: noriaModule, screw: screwModule,
  spiral: spiralModule, zigzag: zigzagModule, aqueduct: aqueductModule, siphon: siphonModule,
}

/** How far behind its landing point a module reaches (its predecessor's spout must clear it). */
function backReach(module: CraftModule | undefined): number {
  switch (module?.kind) {
    case 'spiral': return 1.42
    case 'siphon': return 1.1
    case 'zigzag': case 'aqueduct': return 0.85
    default: return 0
  }
}

const takesTipper = (module: CraftModule | undefined) =>
  !module || module.kind === 'maze' || module.kind === 'terraces' || module.kind === 'pond' || module.kind === 'noria' || module.kind === 'screw'
/** Lifts and chutes deliver from a trough end, not a spout: no exit device. */
export const hasSpout = (kind: CraftKind) => CRAFT_MODULES.find(item => item.kind === kind)!.spout

const PLANT_ORDER: PlantKind[] = ['olive', 'rosemary', 'fern', 'stones', 'olive', 'fern']

/** Compile a crafted course into a garden design, or explain what stops it. */
export function compileCraft(course: CraftCourse): CraftResult {
  const issues: CraftIssue[] = [], stages: CraftStage[] = []
  if (!course.modules.length) return { design: null, issues: [{ module: -1, message: '장치를 하나 이상 넣어 주세요.' }], stages }
  const lipZ = Math.max(2, Math.min(7, course.source))
  let cursor: Cursor = { landing: [0, 0], heading: 0, maxTop: lipZ - 0.3, maxLevel: lipZ - 0.45 }
  const vessels: VesselSpec[] = []
  const boxes: Box[][] = [[boxOf([[0, 1.85]], 0.5)]]
  const handoffs: Box[][] = []
  for (let index = 0; index < course.modules.length; index++) {
    const module = course.modules[index], next = course.modules[index + 1]
    const ctx: BuildContext = {
      module, index, cursor, spoutLength: Math.max(0.45, backReach(next) - 0.2), nextTakesTipper: takesTipper(next),
    }
    let built: Built
    try {
      built = BUILDERS[module.kind](ctx)
    } catch (error) {
      issues.push({ module: index, message: error instanceof CraftError ? error.message : '이 장치를 놓을 수 없어요.' })
      return { design: null, issues, stages }
    }
    // Nothing may run into what the water has already passed. The module
    // just before may overlap a little (a spout tucks over its basin), and
    // its hand-off trough reaches in by design.
    const mine = [...built.boxes, ...(built.handoff ?? [])]
    const clash = boxes.findIndex((earlier, k) => {
      const previous = k === boxes.length - 1
      const theirs = previous ? earlier : [...earlier, ...(handoffs[k] ?? [])]
      return theirs.some(a => mine.some(b => overlaps(a, b, previous ? 0.7 : 0.05)))
    })
    if (clash >= 0) {
      issues.push({ module: index, message: clash === 0 ? '수원 탑과 겹쳐요. 방향을 바꿔 보세요.' : `${clash}번째 장치와 겹쳐요. 방향(좌·우)을 바꿔 보세요.` })
      return { design: null, issues, stages }
    }
    boxes.push(built.boxes)
    handoffs[boxes.length - 1] = built.handoff ?? []
    vessels.push(...built.vessels)
    stages.push({ module: index, top: built.top, handoff: built.next.maxTop })
    cursor = built.next
  }
  // The course ends in a receiving basin and its drain.
  if (cursor.maxTop < 0.6 || cursor.maxLevel < 0.25) {
    issues.push({ module: course.modules.length - 1, message: '마지막 연못을 놓을 높이가 부족해요. 마지막 장치의 출구를 바꾸거나 양수 장치를 넣어 주세요.' })
    return { design: null, issues, stages }
  }
  const drainCentre = along(cursor.landing, DIRS[cursor.heading], [0, 0], 0.3, 0)
  const drainBox = boxOf(circle(drainCentre[0], drainCentre[1], 1.15))
  if (boxes.slice(0, -1).some((earlier, k) => earlier.some(a => overlaps(a, drainBox, k === boxes.length - 1 ? 0.7 : 0.05)))) {
    issues.push({ module: course.modules.length - 1, message: '마지막 연못이 앞의 장치와 겹쳐요. 마지막 장치의 방향을 바꿔 보세요.' })
    return { design: null, issues, stages }
  }
  vessels.push(roundBasin('receiving-basin', drainCentre, 0.95, 0.04, 0.56, 0.4, { drain: { crest: 0.12, width: 2.0, at: drainCentre } }))
  boxes.push([drainBox])
  // A few plants where there is room, beside the course.
  const plants: GardenDesign['plants'] = []
  const all = boxes.flat()
  for (const group of boxes.slice(1)) {
    const box = group[0]
    for (const [x, y] of [[box.minX - 1.3, box.maxY + 0.4], [box.maxX + 1.3, box.minY - 0.4], [box.maxX + 1.3, box.maxY + 0.4], [box.minX - 1.3, box.minY - 0.4]] as Vec2[]) {
      if (plants.length >= Math.min(8, boxes.length + 2)) break
      const probe = boxOf([[x, y]], 0.8)
      if (all.some(b => overlaps(b, probe)) || plants.some(p => Math.hypot(p.at[0] - x, p.at[1] - y) < 2)) continue
      const kind = PLANT_ORDER[plants.length % PLANT_ORDER.length]
      plants.push({ kind, at: [x, y], scale: kind === 'stones' ? 1 : 1.35 + (plants.length % 3) * 0.15 })
      break
    }
  }
  const design = withCompanions(() => ({ id: 'craft', vessels, source: source([0, 0], [0, 1.85], lipZ, 0.42), plants }))()
  return { design, issues, stages }
}

let serial = 0
export function craftModule(kind: CraftKind, overrides: Partial<CraftModule> = {}): CraftModule {
  const info = CRAFT_MODULES.find(item => item.kind === kind)!
  return {
    id: `${kind}-${Date.now().toString(36)}-${(serial++).toString(36)}`, kind, turn: 'straight',
    exit: info.spout ? 'plain' : 'plain', size: 'medium', seed: Math.floor(Math.random() * 1000), wheels: kind === 'terraces', ...overrides,
  }
}

export interface CraftTemplate { id: string; name: string; description: string; course: CraftCourse }

const m = (kind: CraftKind, overrides: Partial<CraftModule> = {}): CraftModule => ({
  id: `${kind}-${overrides.seed ?? 0}-${Math.random().toString(36).slice(2, 7)}`, kind, turn: 'straight', exit: 'plain', size: 'medium', seed: 7, wheels: false, ...overrides,
})

export function craftTemplates(): CraftTemplate[] {
  return [
    {
      id: 'terraced', name: '계단 정원', description: '미로에서 시작해 시시오도시, 계단 폭포, 빗물 사슬로 이어지는 차분한 정원',
      course: { version: 1, name: '계단 정원', source: 4.3, modules: [
        m('maze', { size: 'medium', exit: 'tipper', seed: 11 }),
        m('terraces', { size: 'medium', wheels: true, turn: 'left' }),
        m('pond', { size: 'small', exit: 'chain' }),
      ] },
    },
    {
      id: 'grand-tour', name: '물의 대장정', description: '미로 → 계단 → 노리아가 끌어올린 물이 나선 탑을 돌아 사이펀으로 쏟아지는 긴 여정',
      course: { version: 1, name: '물의 대장정', source: 4.3, modules: [
        m('maze', { size: 'medium', exit: 'tipper', seed: 3 }),
        m('terraces', { size: 'small', wheels: true, exit: 'wheel' }),
        m('noria', { size: 'medium' }),
        m('spiral', { size: 'medium' }),
        m('siphon'),
      ] },
    },
    {
      id: 'screw-aqueduct', name: '스크류와 수도교', description: '스크류가 들어 올린 물이 긴 수도교를 건너 지그재그로 내려옵니다',
      course: { version: 1, name: '스크류와 수도교', source: 3.4, modules: [
        m('maze', { size: 'small', seed: 5 }),
        m('screw', { size: 'large' }),
        m('aqueduct', { size: 'medium', turn: 'left' }),
        m('zigzag', { size: 'small' }),
      ] },
    },
  ]
}
