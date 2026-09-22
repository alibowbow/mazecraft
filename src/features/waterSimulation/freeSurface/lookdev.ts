/** Visual controls are independent of the fluid grid and never reset the simulation. */
export type WaterTheme = 'porcelain' | 'glacier' | 'terrace' | 'sage' | 'basalt';
export type WaterLight = 'daylight' | 'golden' | 'studio';

export interface WaterLook {
  theme: WaterTheme;
  light: WaterLight;
  /** Visual depth multiplier; the fluid solver retains its original solid cells. */
  wallHeight: number;
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
    id: 'porcelain', label: '포슬린', color: '#ebe3d7', background: '#e9c9b1',
    floor: '#f8f1e7', wall: '#f8f1e5', wallSide: '#f3e8d8', slab: '#e8ddcb',
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
  daylight: { direction: [-0.72, 0.28, 0.95], color: '#fff4df', fill: '#dceef3', sky: '#ffffff', ground: '#dbceba', intensity: 2.0, ambient: 1.55 },
  golden: { direction: [-0.76, 0.30, 0.60], color: '#ffd5a5', fill: '#eadfe6', sky: '#fff1dc', ground: '#d3ac87', intensity: 2.25, ambient: 1.4 },
  studio: { direction: [0.46, 0.72, 0.96], color: '#f2faff', fill: '#d5e7f0', sky: '#f1f8ff', ground: '#c6d6dd', intensity: 1.9, ambient: 1.7 },
} as const;

export function getWaterTheme(theme: WaterTheme): WaterThemePalette {
  return WATER_THEMES.find((palette) => palette.id === theme) ?? WATER_THEMES[0];
}

export function normalizeWaterLook(next: Partial<WaterLook>, current: WaterLook = DEFAULT_WATER_LOOK): WaterLook {
  return {
    theme: WATER_THEMES.some((palette) => palette.id === next.theme) ? next.theme! : current.theme,
    light: next.light === 'daylight' || next.light === 'golden' || next.light === 'studio' ? next.light : current.light,
    wallHeight: typeof next.wallHeight === 'number' && Number.isFinite(next.wallHeight)
      ? Math.max(0.55, Math.min(1.75, next.wallHeight)) : current.wallHeight,
  };
}
