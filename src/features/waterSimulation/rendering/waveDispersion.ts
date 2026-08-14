const TAU = Math.PI * 2

/**
 * Relative finite-depth phase speed from the linear gravity-wave dispersion
 * relation. A value near zero represents very shallow water; the result tends
 * to one at the deep-water limit.
 */
export function resolveFiniteDepthPhaseScale(
  wavelengthCells: number,
  depthMeters: number,
  cellWidthMeters = 1,
): number {
  if (!Number.isFinite(wavelengthCells) || wavelengthCells <= 0) {
    throw new RangeError('wavelengthCells must be a positive finite number.')
  }
  if (!Number.isFinite(depthMeters) || depthMeters < 0) {
    throw new RangeError('depthMeters must be a non-negative finite number.')
  }
  if (!Number.isFinite(cellWidthMeters) || cellWidthMeters <= 0) {
    throw new RangeError('cellWidthMeters must be a positive finite number.')
  }
  const waveNumberPerMeter = TAU / (wavelengthCells * cellWidthMeters)
  return Math.sqrt(Math.tanh(waveNumberPerMeter * depthMeters))
}
