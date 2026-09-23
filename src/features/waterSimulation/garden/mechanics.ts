import type { Vec2 } from './polygon'

/**
 * Water-driven machinery. A tipper (shishi-odoshi) is a pivoted tube under a
 * spout: its open mouth rests high, fills, and once heavy enough swings down,
 * pours its load in one surge and swings back. Paddle wheels turn in the
 * falls and over the terrace steps at a speed set by the discharge.
 */

/** Mouth-side arm of the tipper tube, pivot to mouth (m). */
export const TIPPER_ARM = 0.38
/** Counterweight arm, pivot to the closed end (m). */
export const TIPPER_TAIL = 0.26
export const TIPPER_RADIUS = 0.1
/** Resting tilt (mouth up) and full tip (mouth down), radians. */
export const TIPPER_REST = 0.3
export const TIPPER_TIPPED = -0.58
/** Mouth sits this far beyond the spout lip, where the jet comes down. */
export const TIPPER_MOUTH_REACH = 0.16
/** Mouth rim below the spout crest at rest. */
export const TIPPER_MOUTH_DROP = 0.1
/** Swing down, pour and swing back (s). */
export const TIPPER_TIP_TIME = 0.38
export const TIPPER_POUR_TIME = 0.55
export const TIPPER_RETURN_TIME = 0.75

export interface TipperFrame {
  pivot: Vec2
  pivotZ: number
  /** Unit direction from the mouth towards the pivot (the spout's direction). */
  direction: Vec2
}

/** Pivot of a tipper hung under a spout whose lip ends at `lipEnd`. */
export function tipperFrame(lipEnd: Vec2, direction: Vec2, crest: number): TipperFrame {
  const mouthX = TIPPER_MOUTH_REACH, mouthZ = crest - TIPPER_MOUTH_DROP
  const along = mouthX + TIPPER_ARM * Math.cos(TIPPER_REST)
  return {
    pivot: [lipEnd[0] + direction[0] * along, lipEnd[1] + direction[1] * along],
    pivotZ: mouthZ - TIPPER_ARM * Math.sin(TIPPER_REST),
    direction,
  }
}

/**
 * A point on the tube at signed distance `s` from the pivot (negative towards
 * the mouth) for a tilt `angle` (positive lifts the mouth).
 */
export function tipperPoint(frame: TipperFrame, s: number, angle: number, lift = 0): [number, number, number] {
  const along = s * Math.cos(angle) - lift * Math.sin(angle)
  const up = -s * Math.sin(angle) + lift * Math.cos(angle)
  return [frame.pivot[0] + frame.direction[0] * along, frame.pivot[1] + frame.direction[1] * along, frame.pivotZ + up]
}

/** Where the surge from a fully tipped tube comes down. */
export function tipperLanding(frame: TipperFrame): Vec2 {
  const [x, y] = tipperPoint(frame, -TIPPER_ARM - 0.06, TIPPER_TIPPED)
  return [x, y]
}

/** Lowest point the tube reaches while tipped. */
export function tipperLowest(frame: TipperFrame): number {
  return tipperPoint(frame, -TIPPER_ARM, TIPPER_TIPPED)[2] - TIPPER_RADIUS
}

/** Spout wheels hang this far below the crest, clear of the channel slab. */
export const SPOUT_WHEEL_DROP = 0.18

/** Spout paddle wheel radius for a fall from `crest` onto a bed at `floor`. */
export function spoutWheelRadius(crest: number, floor: number): number {
  return Math.max(0.14, Math.min(0.3, (crest - SPOUT_WHEEL_DROP - floor - 0.08) / 2))
}

export const SILL_WHEEL_RADIUS = 0.24
/** Sill wheels ride this high above the crest (their paddles dip below it). */
export const SILL_WHEEL_LIFT = 0.16
export const WHEEL_PADDLES = 10

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x) }

export type TipperPhase = 0 | 1 | 2 | 3
export const FILLING: TipperPhase = 0
export const TIPPING: TipperPhase = 1
export const POURING: TipperPhase = 2
export const RETURNING: TipperPhase = 3

/** Tilt of a tipper for its phase, time in phase and fill fraction. */
export function tipperAngle(phase: TipperPhase, t: number, fill: number): number {
  switch (phase) {
    case FILLING: return TIPPER_REST - 0.12 * smooth(fill)
    case TIPPING: {
      // Accelerates as the load moves past the pivot.
      const x = Math.min(1, t / TIPPER_TIP_TIME)
      return TIPPER_REST - 0.12 + (TIPPER_TIPPED - TIPPER_REST + 0.12) * x * x
    }
    case POURING: return TIPPER_TIPPED
    default: {
      // Swings back and knocks against its rest stone with a small rebound.
      const x = Math.min(1, t / TIPPER_RETURN_TIME)
      const knock = x > 0.72 ? Math.sin((x - 0.72) / 0.28 * Math.PI) * 0.05 * (1 - x) * 4 : 0
      return TIPPER_TIPPED + (TIPPER_REST - TIPPER_TIPPED) * smooth(x / 0.72) - knock
    }
  }
}
