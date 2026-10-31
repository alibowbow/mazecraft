import { readSettings, type EffectQuality } from '../../storage/settings'

export const GRAPHICS_UNAVAILABLE_MESSAGE =
  '이 브라우저에서 3D 그래픽(WebGL 2)을 켤 수 없습니다. 브라우저 설정에서 하드웨어 가속을 켜거나 최신 Chrome, Edge, Safari, Firefox로 다시 열어 주세요.'
export const GRAPHICS_LOST_MESSAGE =
  '그래픽 장치가 잠시 응답하지 않았습니다. 다시 시작을 누르면 장면을 새로 준비합니다.'

/**
 * The studio drawing quality for this device. "auto" keeps full resolution
 * on computers and lightens phones and tablets with little memory or few cores.
 */
export function resolveStudioQuality(preference: EffectQuality = readSettings().effectQuality): 'low' | 'high' {
  if (preference === 'low' || preference === 'high') return preference
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'high'
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency
  const constrained = (memory !== undefined && memory <= 4) || (cores > 0 && cores <= 4)
  return coarse && constrained ? 'low' : 'high'
}

/** Turn a renderer start-up failure into advice a visitor can act on. */
export function describeGraphicsError(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : ''
  if (/webgl|context/i.test(message)) return GRAPHICS_UNAVAILABLE_MESSAGE
  return message || fallback
}

/**
 * Follow GPU resets on the studio canvas: a lost context pauses the scene
 * with a message, and a restored one lets the studio rebuild it.
 */
export function watchGraphicsContext(mount: HTMLElement, handlers: { lost(): void; restored(): void }): () => void {
  const canvas = mount.querySelector('canvas')
  if (!canvas) return () => undefined
  const lost = (event: Event) => {
    // Allows the browser to restore the context later.
    event.preventDefault()
    handlers.lost()
  }
  const restored = () => handlers.restored()
  canvas.addEventListener('webglcontextlost', lost)
  canvas.addEventListener('webglcontextrestored', restored)
  return () => {
    canvas.removeEventListener('webglcontextlost', lost)
    canvas.removeEventListener('webglcontextrestored', restored)
  }
}
