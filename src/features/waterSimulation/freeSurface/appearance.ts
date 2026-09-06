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

/** Preserve the former default's turquoise appearance under its honest name. */
export const AQUA_WATER_APPEARANCE: WaterAppearance = {
  profile: 'aqua',
  color: '#16aeb7',
  opacity: 0.58,
}

export const COLORED_WATER_OPACITY = 0.68

export const WATER_COLOR_PRESETS = [
  { id: 'clear', label: '투명 물', color: null },
  { id: 'aqua', label: '청록', color: '#16aeb7' },
  { id: 'blue', label: '파랑', color: '#3786e8' },
  { id: 'mint', label: '민트', color: '#3abb88' },
  { id: 'purple', label: '보라', color: '#9470db' },
  { id: 'pink', label: '분홍', color: '#e36b9c' },
  { id: 'amber', label: '주황', color: '#eb9740' },
] as const

export type WaterColorPresetId = typeof WATER_COLOR_PRESETS[number]['id'] | 'custom'
