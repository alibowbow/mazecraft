/** Visual controls are independent of the fluid grid and never reset the simulation. */
export type WaterTheme = 'porcelain' | 'glacier' | 'terrace' | 'sage' | 'basalt';
export type WaterLight = 'daylight' | 'golden' | 'studio';

export interface WaterLook {
  theme: WaterTheme;
  light: WaterLight;
  /** Visual depth multiplier; the fluid solver retains its original solid cells. */
  wallHeight: number;
  background2d?: 'white' | 'material';
  wallColor2d?: string;
  gridColor2d?: string;
}

export interface WaterThemePalette {
  id: WaterTheme;
  label: string;
  color: string;
  background: string;
  floor: string;
  wall: string;
  wallSide: string;
  slab: string;
  edge: string;
  accent: string;
  roughness: number;
  metalness: number;
}

export const WATER_THEMES: readonly WaterThemePalette[] = [
  {
    id: 'porcelain', label: '포슬린', color: '#ebe3d7', background: '#f6f8f5',
    floor: '#f7f5f0', wall: '#f7f5f0', wallSide: '#f7f5f0', slab: '#e8ddcb',
    edge: '#c7b99f', accent: '#72bfb2', roughness: 0.16, metalness: 0.0,
  },
  {
    id: 'glacier', label: '글레이셔', color: '#bce5ed', background: '#dfe6ef',
    floor: '#e0f2f4', wall: '#c9eaf0', wallSide: '#8cc7d3', slab: '#b8d9e2',
    edge: '#7ba8b8', accent: '#4bafcb', roughness: 0.13, metalness: 0.10,
  },
  {
    id: 'terrace', label: '테라스', color: '#deb79c', background: '#e8d4b6',
    floor: '#f0dccc', wall: '#ebc3a5', wallSide: '#c68f70', slab: '#d6a585',
    edge: '#bb8768', accent: '#41aaaf', roughness: 0.68, metalness: 0,
  },
  {
    id: 'sage', label: '세이지', color: '#c7d4bb', background: '#eff2e7',
    floor: '#edf1df', wall: '#d8e3c8', wallSide: '#a3b69b', slab: '#bdcdb0',
    edge: '#93a88a', accent: '#72b9ab', roughness: 0.42, metalness: 0.01,
  },
  {
    id: 'basalt', label: '바솔트', color: '#778288', background: '#e8eef0',
    floor: '#acb8bd', wall: '#788b91', wallSide: '#4e656e', slab: '#61777f',
    edge: '#c5d9df', accent: '#72d9cb', roughness: 0.48, metalness: 0.12,
  },
];

export const DEFAULT_WATER_LOOK: WaterLook = { theme: 'porcelain', light: 'daylight', wallHeight: 1 };

/** Shared direction keeps the fluid highlights, wall bevels and contact shade coherent. */
export const WATER_LIGHTS = {
  // Keep the sun away from the default orthographic camera's mirror angle:
  // a parallel view otherwise turns the entire flat pool into one white glint.
  daylight: { direction: [-0.72, -0.38, 0.85], color: '#fff9ed', fill: '#eefaff', sky: '#ffffff', ground: '#f0f6f8', intensity: 2.8, ambient: 0.9 },
  golden: { direction: [-0.76, 0.30, 0.60], color: '#ffd5a5', fill: '#eadfe6', sky: '#fff1dc', ground: '#d3ac87', intensity: 2.9, ambient: 0.8 },
  studio: { direction: [0.46, 0.72, 0.96], color: '#f2faff', fill: '#d5e7f0', sky: '#f1f8ff', ground: '#c6d6dd', intensity: 2.5, ambient: 1.0 },
} as const;

export function getWaterTheme(theme: WaterTheme): WaterThemePalette {
  return WATER_THEMES.find((palette) => palette.id === theme) ?? WATER_THEMES[0];
}

export function normalizeWaterLook(next: Partial<WaterLook>, current: WaterLook = DEFAULT_WATER_LOOK): WaterLook {
  return {
    wallColor2d: /^#[0-9a-f]{6}$/i.test(next.wallColor2d ?? '') ? next.wallColor2d : current.wallColor2d ?? '#526b7a',
    gridColor2d: /^#[0-9a-f]{6}$/i.test(next.gridColor2d ?? '') ? next.gridColor2d : current.gridColor2d ?? '#dce3e8',
    ...(next.background2d || current.background2d ? { background2d: next.background2d === 'white' || next.background2d === 'material' ? next.background2d : current.background2d } : {}),
    theme: WATER_THEMES.some((palette) => palette.id === next.theme) ? next.theme! : current.theme,
    light: next.light === 'daylight' || next.light === 'golden' || next.light === 'studio' ? next.light : current.light,
    wallHeight: typeof next.wallHeight === 'number' && Number.isFinite(next.wallHeight)
      ? Math.max(0.55, Math.min(1.75, next.wallHeight)) : current.wallHeight,
  };
}
