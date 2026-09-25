import type { Box, CraftPlan } from '../waterSimulation/garden/craft'

const HEADINGS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]

/**
 * Plan view of a course as far as it could be built: every device's
 * footprint in water order, the source and the receiving pond, and — when
 * something is wrong — the device that does not fit, drawn where it would go.
 */
export function CraftPlanView({ plan, count, compact = false }: { plan: CraftPlan; count: number; compact?: boolean }) {
  const failure = plan.failure
  const all: Box[] = [...plan.parts.flatMap(part => part.boxes), ...(failure?.boxes ?? [])]
  if (failure && !failure.boxes) all.push({ minX: failure.at[0] - 1, maxX: failure.at[0] + 1, minY: failure.at[1] - 1, maxY: failure.at[1] + 1 })
  const minX = Math.min(...all.map(b => b.minX)) - 0.8, maxX = Math.max(...all.map(b => b.maxX)) + 0.8
  const minY = Math.min(...all.map(b => b.minY)) - 0.8, maxY = Math.max(...all.map(b => b.maxY)) + 0.8
  const width = maxX - minX, height = maxY - minY
  // Plan north up: SVG y runs down.
  const rect = (box: Box) => ({ x: box.minX - minX, y: maxY - box.maxY, width: box.maxX - box.minX, height: box.maxY - box.minY })
  const centre = (boxes: Box[]) => {
    const b = boxes[0]
    return [(b.minX + b.maxX) / 2 - minX, maxY - (b.minY + b.maxY) / 2] as const
  }
  const route = plan.parts.map(part => centre(part.boxes))
  const unit = Math.max(width, height) / 40
  const failed = failure?.clashWith
  return <svg className={`craft-plan${compact ? ' is-compact' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={failure ? `배치도: ${failure.module + 1}번 자리에 문제가 있어요` : '배치도'}>
    <polyline className="craft-plan-route" points={route.map(p => p.join(',')).join(' ')} style={{ strokeWidth: unit * 0.9 }} />
    {plan.parts.map(part => {
      const clashing = failed !== undefined && part.module === failed
      const kind = part.module < 0 ? 'source' : clashing ? 'clashing' : 'part'
      const [cx, cy] = centre(part.boxes)
      return <g key={part.module} className={`craft-plan-${kind}`}>
        {part.boxes.map((box, k) => <rect key={k} {...rect(box)} rx={unit * 1.5} style={{ strokeWidth: unit * 0.5 }} />)}
        {part.module >= 0 && <text x={cx} y={cy} style={{ fontSize: unit * 3.4 }} dominantBaseline="central" textAnchor="middle">
          {part.module >= count ? '◎' : part.module + 1}
        </text>}
        {part.module < 0 && <text x={cx} y={cy} style={{ fontSize: unit * 3.2 }} dominantBaseline="central" textAnchor="middle">수원</text>}
      </g>
    })}
    {failure && <g className="craft-plan-failure">
      {failure.boxes
        ? failure.boxes.map((box, k) => <rect key={k} {...rect(box)} rx={unit * 1.5} style={{ strokeWidth: unit * 0.7, strokeDasharray: `${unit * 1.6} ${unit}` }} />)
        : <>
          <circle cx={failure.at[0] - minX} cy={maxY - failure.at[1]} r={unit * 4} style={{ strokeWidth: unit * 0.7 }} />
          <line x1={failure.at[0] - minX} y1={maxY - failure.at[1]}
            x2={failure.at[0] - minX + HEADINGS[failure.heading][0] * unit * 9} y2={maxY - failure.at[1] - HEADINGS[failure.heading][1] * unit * 9}
            style={{ strokeWidth: unit * 0.8 }} />
        </>}
      <text x={failure.at[0] - minX} y={maxY - failure.at[1] - unit * 6} style={{ fontSize: unit * 3 }} textAnchor="middle">
        {failure.problem === 'clash' || failure.problem === 'finish-clash' ? '겹침' : failure.problem === 'tipper' ? '시시오도시 자리 없음' : `높이 ${failure.room.toFixed(1)} m 남음`}
      </text>
    </g>}
  </svg>
}
