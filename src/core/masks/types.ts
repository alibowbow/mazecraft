export type BuiltInShape =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'circle'
  | 'ellipse'
  | 'heart'
  | 'star'
  | 'diamond'
  | 'hexagon'
  | 'crescent'
  | 'cloud'
  | 'flower'
  | 'tree'
  | 'house'
  | 'crown'
  | 'lightning'
  | 'speech-bubble'
  | 'puzzle'

export type BooleanMask = boolean[][]

export interface TextMaskOptions {
  text: string
  fontFamily: string
  fontWeight: number
  letterSpacing: number
  lineHeight: number
  align: CanvasTextAlign
  verticalAlign: 'top' | 'middle' | 'bottom'
  fit: 'contain' | 'manual'
  fontSize?: number
  mode: 'outline' | 'obstacle' | 'reveal'
}

export interface ImageMaskOptions {
  scale: number
  offsetX: number
  offsetY: number
  rotation: number
  grayscale: boolean
  threshold: number
  invert: boolean
  smoothing: number
  noiseSize: number
  fillInterior: boolean
  largestComponentOnly: boolean
}

export interface DrawingPoint {
  x: number
  y: number
  pressure?: number
}

export const SHAPE_LABELS: Record<BuiltInShape, string> = {
  rectangle: '사각형',
  'rounded-rectangle': '둥근 사각형',
  circle: '원',
  ellipse: '타원',
  heart: '하트',
  star: '별',
  diamond: '다이아몬드',
  hexagon: '육각형',
  crescent: '초승달',
  cloud: '구름',
  flower: '꽃',
  tree: '나무',
  house: '집',
  crown: '왕관',
  lightning: '번개',
  'speech-bubble': '말풍선',
  puzzle: '퍼즐 조각',
}
