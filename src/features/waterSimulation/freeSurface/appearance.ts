/** Optical controls only: changing appearance never changes the liquid state. */
export interface WaterAppearance {
  /** Presets may have their own optics; a custom color always uses dye tinting. */
  readonly profile?: 'clear' | 'aqua' | 'tinted'
  readonly color: string | null
  readonly opacity: number
}

export const DEFAULT_WATER_APPEARANCE: WaterAppearance = {
  profile: 'clear',
  color: null,
  opacity: 0.82,
}

/** Bright cyan is shared by the preset chip, default selection and renderer. */
export const AQUA_WATER_APPEARANCE: WaterAppearance = {
  profile: 'aqua',
  color: '#00cbe8',
  opacity: 0.58,
}

export const COLORED_WATER_OPACITY = 0.68

export const WATER_COLOR_PRESETS = [
  { id: 'clear', label: '투명 물', color: null },
  { id: 'aqua', label: '청록', color: '#00cbe8' },
  { id: 'blue', label: '파랑', color: '#168bff' },
  { id: 'mint', label: '민트', color: '#00df98' },
  { id: 'purple', label: '보라', color: '#9950ff' },
  { id: 'pink', label: '분홍', color: '#ff4293' },
  { id: 'amber', label: '주황', color: '#ff981f' },
] as const

export type WaterColorPresetId = typeof WATER_COLOR_PRESETS[number]['id'] | 'custom'

/** Upgrade only exact former preset values; retain custom colors and clear water. */
export function upgradeWaterPresetColor(color: string | null): string | null {
  const former: Record<string, string> = {
    '#16aeb7': '#00cbe8', '#3786e8': '#168bff', '#3abb88': '#00df98',
    '#9470db': '#9950ff', '#e36b9c': '#ff4293', '#eb9740': '#ff981f',
  }
  return color ? former[color.toLowerCase()] ?? color : null
}
