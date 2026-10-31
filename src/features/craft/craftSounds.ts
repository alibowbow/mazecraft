/**
 * Small synthesized sounds for building and for stage results. Nothing is
 * downloaded: each sound is a few oscillators with soft envelopes. The
 * studio's sound toggle decides whether they play.
 */
export type CraftSound = 'add' | 'remove' | 'select' | 'clear' | 'star' | 'fail' | 'chapter'

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) return null
  if (!context) {
    try { context = new Context() } catch { return null }
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

/** Call from a click or key press: browsers only start audio from a gesture. */
export function primeCraftSounds(): void {
  audio()
}

interface Note {
  frequency: number
  /** Seconds after now. */
  at: number
  duration: number
  gain: number
  type?: OscillatorType
  /** Frequency at the end of the note, for a glide. */
  to?: number
}

function play(ctx: AudioContext, notes: Note[]): void {
  const now = ctx.currentTime + 0.01
  for (const note of notes) {
    const oscillator = ctx.createOscillator()
    const envelope = ctx.createGain()
    oscillator.type = note.type ?? 'sine'
    const start = now + note.at
    oscillator.frequency.setValueAtTime(note.frequency, start)
    if (note.to) oscillator.frequency.exponentialRampToValueAtTime(note.to, start + note.duration)
    // A short attack and an exponential tail, like a struck bell or wood.
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(note.gain, start + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + note.duration)
    oscillator.connect(envelope).connect(ctx.destination)
    oscillator.start(start)
    oscillator.stop(start + note.duration + 0.05)
  }
}

/** A bell: the note plus a quieter octave, both decaying. */
const bell = (frequency: number, at: number, duration = 0.9, gain = 0.07): Note[] => [
  { frequency, at, duration, gain, type: 'triangle' },
  { frequency: frequency * 2, at, duration: duration * 0.6, gain: gain * 0.35 },
]

const SOUNDS: Record<CraftSound, () => Note[]> = {
  // Wooden blocks set down and lifted away.
  add: () => [{ frequency: 620, to: 780, at: 0, duration: 0.09, gain: 0.06 }, { frequency: 1240, at: 0.035, duration: 0.07, gain: 0.025 }],
  remove: () => [{ frequency: 520, to: 360, at: 0, duration: 0.12, gain: 0.05 }],
  select: () => [{ frequency: 880, at: 0, duration: 0.06, gain: 0.03 }],
  // C major arpeggio to the octave.
  clear: () => [523.25, 659.25, 783.99, 1046.5].flatMap((frequency, k) => bell(frequency, k * 0.1, 1.1 - k * 0.1)),
  star: () => [...bell(1318.5, 0, 0.5, 0.05), ...bell(1975.5, 0.04, 0.35, 0.025)],
  fail: () => [{ frequency: 392, at: 0, duration: 0.22, gain: 0.05, type: 'triangle' }, { frequency: 329.6, at: 0.16, duration: 0.32, gain: 0.05, type: 'triangle' }],
  chapter: () => [523.25, 659.25, 783.99, 1046.5, 1318.5].flatMap((frequency, k) => bell(frequency, k * 0.12, 1.3, 0.06)),
}

/** Play a sound now, or after `delay` seconds, when sound is on. */
export function playCraftSound(sound: CraftSound, enabled: boolean, delay = 0): void {
  if (!enabled) return
  const ctx = audio()
  if (!ctx || ctx.state !== 'running') return
  play(ctx, SOUNDS[sound]().map(note => ({ ...note, at: note.at + delay })))
}
