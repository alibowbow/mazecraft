/** Physical geometry and constants for the reduced-order hydraulic network. */
export interface HydraulicGeometryOptions {
  /** Horizontal cell pitch, metres. */
  cellWidthMeters?: number
  /** Vertical cell pitch and row-to-row elevation drop, metres. */
  cellHeightMeters?: number
  /** Effective water depth perpendicular to the maze plane, metres. */
  channelThicknessMeters?: number
  /** Clear width of an open portal, metres. */
  passageWidthMeters?: number
  /** Maximum continuously wetted portal height, metres. */
  maxOpeningDepthMeters?: number
  /** Darcy-style dimensionless friction coefficient used to seed edge resistance. */
  frictionCoefficient?: number
  /** Gravitational acceleration, metres per second squared. */
  gravityMetersPerSecondSquared?: number
}

export interface ResolvedHydraulicGeometry {
  cellWidthMeters: number
  cellHeightMeters: number
  channelThicknessMeters: number
  passageWidthMeters: number
  maxOpeningDepthMeters: number
  frictionCoefficient: number
  gravityMetersPerSecondSquared: number
  /** Horizontal plan area represented by one control volume, square metres. */
  storageAreaSquareMeters: number
}

export const DEFAULT_HYDRAULIC_GEOMETRY: Readonly<ResolvedHydraulicGeometry> = {
  cellWidthMeters: 1,
  cellHeightMeters: 0.18,
  channelThicknessMeters: 0.12,
  passageWidthMeters: 0.58,
  maxOpeningDepthMeters: 0.18,
  frictionCoefficient: 1.15,
  gravityMetersPerSecondSquared: 9.81,
  storageAreaSquareMeters: 0.12,
}

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
}

function requireNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`)
  }
}

export function resolveHydraulicGeometry(
  input: HydraulicGeometryOptions = {},
): ResolvedHydraulicGeometry {
  const cellWidthMeters = input.cellWidthMeters ?? DEFAULT_HYDRAULIC_GEOMETRY.cellWidthMeters
  const cellHeightMeters = input.cellHeightMeters ?? DEFAULT_HYDRAULIC_GEOMETRY.cellHeightMeters
  const channelThicknessMeters =
    input.channelThicknessMeters ?? DEFAULT_HYDRAULIC_GEOMETRY.channelThicknessMeters
  const passageWidthMeters =
    input.passageWidthMeters ?? DEFAULT_HYDRAULIC_GEOMETRY.passageWidthMeters
  const maxOpeningDepthMeters =
    input.maxOpeningDepthMeters ?? cellHeightMeters
  const frictionCoefficient =
    input.frictionCoefficient ?? DEFAULT_HYDRAULIC_GEOMETRY.frictionCoefficient
  const gravityMetersPerSecondSquared =
    input.gravityMetersPerSecondSquared ??
    DEFAULT_HYDRAULIC_GEOMETRY.gravityMetersPerSecondSquared

  requirePositiveFinite('cellWidthMeters', cellWidthMeters)
  requirePositiveFinite('cellHeightMeters', cellHeightMeters)
  requirePositiveFinite('channelThicknessMeters', channelThicknessMeters)
  requirePositiveFinite('passageWidthMeters', passageWidthMeters)
  requirePositiveFinite('maxOpeningDepthMeters', maxOpeningDepthMeters)
  requireNonNegativeFinite('frictionCoefficient', frictionCoefficient)
  requirePositiveFinite(
    'gravityMetersPerSecondSquared',
    gravityMetersPerSecondSquared,
  )
  if (passageWidthMeters > cellWidthMeters) {
    throw new RangeError('passageWidthMeters cannot exceed cellWidthMeters.')
  }

  return {
    cellWidthMeters,
    cellHeightMeters,
    channelThicknessMeters,
    passageWidthMeters,
    maxOpeningDepthMeters,
    frictionCoefficient,
    gravityMetersPerSecondSquared,
    storageAreaSquareMeters: cellWidthMeters * channelThicknessMeters,
  }
}

/** Row numbers grow downward, so lower rows have a lower gravitational datum. */
export function elevationForRow(
  rows: number,
  row: number,
  cellHeightMeters: number,
): number {
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(row) || row < 0 || row >= rows) {
    throw new RangeError('row must be inside a positive maze row count.')
  }
  requirePositiveFinite('cellHeightMeters', cellHeightMeters)
  return (rows - 1 - row) * cellHeightMeters
}

/**
 * A portal sill is the higher of its two cell floors. This permits continuous
 * downhill wetting while requiring a low basin to reach the upper floor before
 * it can spill uphill.
 */
export function portalSillElevation(
  fromElevationMeters: number,
  toElevationMeters: number,
): number {
  if (!Number.isFinite(fromElevationMeters) || !Number.isFinite(toElevationMeters)) {
    throw new RangeError('Portal elevations must be finite.')
  }
  return Math.max(fromElevationMeters, toElevationMeters)
}
