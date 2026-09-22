/** Visual controls are independent of the fluid grid and never reset the simulation. */
export type WaterTheme = 'porcelain' | 'glacier' | 'terrace' | 'sage' | 'basalt';
export type WaterLight = 'daylight' | 'golden' | 'studio';

/** The workspace belongs to the studio, not to the selected maze material. */
export const STUDIO_BACKGROUND = '#ffffff';
export const STUDIO_IVORY_BACKGROUND = '#fffdf9';

export interface WaterLook {
  theme: WaterTheme;
  light: WaterLight;
  /** Visual depth multiplier; the fluid solver retains its original solid cells. */
  wallHeight: number;
  /** Explicit wall tint shared by flat and raised-wall views; null uses the material. */
  wallColor?: string | null;
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

// Keep the stored IDs stable while presenting distinct, bright ceramic colors.
export const WATER_THEMES: readonly WaterThemePalette[] = [
  {
    id: 'porcelain', label: '아이보리', color: '#f7f5f0', background: STUDIO_BACKGROUND,
    floor: '#f7f5f0', wall: '#f7f5f0', wallSide: '#f7f5f0', slab: '#eee8dc',
    edge: '#c5bba7', accent: '#00c8df', roughness: 0.16, metalness: 0,
  },
  {
    id: 'glacier', label: '스카이', color: '#30baff', background: STUDIO_BACKGROUND,
    floor: '#effaff', wall: '#30baff', wallSide: '#159fe8', slab: '#1099e0',
    edge: '#087dca', accent: '#00cde8', roughness: 0.13, metalness: 0.04,
  },
  {
    id: 'terrace', label: '코랄', color: '#ff7848', background: STUDIO_BACKGROUND,
    floor: '#fff3eb', wall: '#ff7848', wallSide: '#f45c32', slab: '#ec572e',
    edge: '#d94323', accent: '#00bed4', roughness: 0.22, metalness: 0,
  },
  {
    id: 'sage', label: '에메랄드', color: '#19d98b', background: STUDIO_BACKGROUND,
    floor: '#effff6', wall: '#19d98b', wallSide: '#08bc70', slab: '#08b76c',
    edge: '#009d5b', accent: '#00c5e8', roughness: 0.18, metalness: 0,
  },
  {
    id: 'basalt', label: '코발트', color: '#397eff', background: STUDIO_BACKGROUND,
    floor: '#f0f5ff', wall: '#397eff', wallSide: '#2365ed', slab: '#215ddd',
    edge: '#194bc8', accent: '#00d4ec', roughness: 0.18, metalness: 0.02,
  },
];

export const DEFAULT_WATER_LOOK: WaterLook = { theme: 'porcelain', light: 'daylight', wallHeight: 1, background2d: 'white' };

/** Shared direction keeps the fluid highlights, wall bevels and contact shade coherent. */
export const WATER_LIGHTS = {
  // A high, left-hand key lights crowns and shortens cast shadows. Its reflected
  // window shares this direction, with a narrow edge for readable glaze glints.
  daylight: { direction: [-0.72, 0.30, 1.35], color: '#fff9ed', fill: '#eefaff', sky: '#ffffff', ground: '#f0f6f8', intensity: 3.4, ambient: 0.9 },
  golden: { direction: [-0.76, 0.30, 0.60], color: '#ffd5a5', fill: '#eadfe6', sky: '#fff1dc', ground: '#d3ac87', intensity: 2.9, ambient: 0.8 },
  studio: { direction: [0.46, 0.72, 0.96], color: '#f2faff', fill: '#d5e7f0', sky: '#f1f8ff', ground: '#c6d6dd', intensity: 2.5, ambient: 1.0 },
} as const;

export function getWaterTheme(theme: WaterTheme): WaterThemePalette {
  return WATER_THEMES.find((palette) => palette.id === theme) ?? WATER_THEMES[0];
}

export function normalizeWaterLook(next: Partial<WaterLook>, current: WaterLook = DEFAULT_WATER_LOOK): WaterLook {
  return {
    ...(next.wallColor === null || /^#[0-9a-f]{6}$/i.test(next.wallColor ?? '') ? { wallColor: next.wallColor } : current.wallColor !== undefined ? { wallColor: current.wallColor } : {}),
    wallColor2d: /^#[0-9a-f]{6}$/i.test(next.wallColor2d ?? '') ? next.wallColor2d : current.wallColor2d ?? '#526b7a',
    gridColor2d: /^#[0-9a-f]{6}$/i.test(next.gridColor2d ?? '') ? next.gridColor2d : current.gridColor2d ?? '#dce3e8',
    ...(next.background2d || current.background2d ? { background2d: next.background2d === 'white' || next.background2d === 'material' ? next.background2d : current.background2d } : {}),
    theme: WATER_THEMES.some((palette) => palette.id === next.theme) ? next.theme! : current.theme,
    light: next.light === 'daylight' || next.light === 'golden' || next.light === 'studio' ? next.light : current.light,
    wallHeight: typeof next.wallHeight === 'number' && Number.isFinite(next.wallHeight)
      ? Math.max(0.55, Math.min(1.75, next.wallHeight)) : current.wallHeight,
  };
}
