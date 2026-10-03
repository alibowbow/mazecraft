import type { GardenLayout } from './layout'
import type { GardenState } from './simulation'
import { TIPPER_REST } from './mechanics'

/**
 * The garden's sound, driven by the same physics that moves the water:
 * running water swells with the discharge, falls splash in proportion to
 * the power they carry (ρ·g·Q·Δh), the shishi-odoshi knocks when its tube
 * strikes the stone, wheels tick as their buckets pass, rain chains drip
 * and a siphon gurgles as it catches. Everything is synthesised with Web
 * Audio at run time; nothing is downloaded.
 */
export interface SoundFrame {
  /** 0–1 levels of the continuous layers. */
  stream: number
  splash: number
  gurgle: number
  hum: number
  /** Drips per second from rain chains. */
  drips: number
  /** Discrete events since the previous frame, each with how loud it reaches the listener (0–1). */
  knocks: number[]
  ticks: number[]
  surges: number[]
}

/**
 * Where the viewer listens from: the point the view is centred on and the
 * height of the framed view (m). Sounds fade with their distance from the
 * middle of the view, and the whole garden quietens as the view pulls back.
 */
export interface Listener { x: number; y: number; z: number; span: number }

/** Loudness of a source at (x, y, z) for this listener. */
export function hearing(listener: Listener | null, x: number, y: number, z: number): number {
  if (!listener) return 0.6
  const reach = Math.max(1, listener.span * 0.45)
  const d = Math.hypot(x - listener.x, y - listener.y, (z - listener.z) * 0.6)
  return presence(listener) / (1 + (d / reach) ** 2)
}

/** How close the whole view is: a wide view of the garden is quieter. */
export function presence(listener: Listener | null): number {
  return listener ? Math.min(1, Math.max(0.22, 6 / listener.span)) : 0.6
}

const RHO_G = 1000 * 9.81
const soft = (value: number) => 1 - Math.exp(-Math.max(0, value))

/** Reads a stream of garden states into sound levels and events. */
export class GardenSoundAnalyzer {
  private readonly tipped: boolean[]
  private readonly wheelTurns: number[]
  private readonly noriaTurns: number[]
  private readonly primed: boolean[]

  constructor(private readonly layout: GardenLayout) {
    this.tipped = layout.tippers.map(() => false)
    this.wheelTurns = layout.wheels.map(() => NaN)
    this.noriaTurns = layout.lifts.map(() => NaN)
    this.primed = layout.siphons.map(() => false)
  }

  frame(state: GardenState, listener: Listener | null = null): SoundFrame {
    const { layout } = this
    let flow = state.sourceRate, power = 0, chainFlow = 0
    for (const edge of layout.edges) {
      const q = Math.abs(state.discharge[edge.index] ?? 0)
      flow += q
      if (edge.chain) { chainFlow += q; continue }
      // Water leaves over the crest and falls to the surface below; a
      // drowned sill only runs.
      const below = edge.b >= 0 ? Math.max(state.levels[edge.b] ?? 0, layout.pools[edge.b].floor) : edge.crest - 0.4
      const [x, y] = edge.points[0] ?? [0, 0]
      power += RHO_G * q * Math.max(0, edge.crest - below) * hearing(listener, x, y, edge.crest)
    }
    const knocks: number[] = [], ticks: number[] = [], surges: number[] = []
    state.tipperAngles.forEach((angle, i) => {
      // Tipped past level, then swung back onto its stop: the knock.
      const tipper = layout.tippers[i]
      if (angle < 0) this.tipped[i] = true
      else if (this.tipped[i] && angle > TIPPER_REST - 0.04) { this.tipped[i] = false; knocks.push(hearing(listener, tipper.pivot[0], tipper.pivot[1], tipper.pivotZ)) }
    })
    // A wooden knock each time a bucket passes the bottom (every other paddle).
    const count = (turns: number[], angles: Float32Array, buckets: number, at: (i: number) => [number, number, number]) => angles.forEach((angle, i) => {
      const position = Math.floor(angle / (Math.PI * 2 / buckets))
      if (Number.isFinite(turns[i]) && position !== turns[i]) ticks.push(hearing(listener, ...at(i)))
      turns[i] = position
    })
    count(this.wheelTurns, state.wheelAngles, 6, i => [layout.wheels[i].center[0], layout.wheels[i].center[1], layout.wheels[i].z])
    count(this.noriaTurns, state.noriaAngles, 8, i => [layout.lifts[i].center[0], layout.lifts[i].center[1], layout.lifts[i].hub])
    let running = 0
    state.siphonPrimed.forEach((primed, i) => {
      const siphon = layout.siphons[i]
      const near = hearing(listener, siphon.at[0], siphon.at[1], siphon.base + siphon.trigger)
      if (primed > 0.5 && !this.primed[i]) surges.push(near)
      this.primed[i] = primed > 0.5
      running += primed * near
    })
    const lifted = Array.from(state.liftLoads).reduce((sum, q) => sum + q, 0)
    const near = presence(listener)
    return {
      stream: soft(flow / 0.06) * (0.35 + 0.65 * near),
      splash: soft(power / 250),
      gurgle: Math.min(1, running),
      hum: layout.lifts.length ? (0.4 + 0.6 * soft(lifted / 0.03)) * near : 0,
      drips: Math.min(40, chainFlow * 900) * near,
      knocks, ticks, surges,
    }
  }
}

function noiseBuffer(context: BaseAudioContext, brown: boolean): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    if (brown) { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.5 } else data[i] = white
  }
  return buffer
}

interface Layer { gain: GainNode }

/** Plays a garden: continuous layers follow the physics, events are one-shots. */
export class GardenSound {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private layers: Record<'stream' | 'splash' | 'gurgle' | 'hum', Layer> | null = null
  private white: AudioBuffer | null = null
  private analyzer: GardenSoundAnalyzer
  private enabled = false
  private active = false
  private volume = 0.5
  /** Bubbles of the babbling water, owed since the last frame. */
  private babbleDebt = 0
  private dripDebt = 0
  private lastTick = 0
  private lastFrame = 0

  constructor(layout: GardenLayout) {
    this.analyzer = new GardenSoundAnalyzer(layout)
  }

  /** Must first be called from a user gesture (browsers gate audio). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) this.start()
    this.applyMaster()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.applyMaster()
  }

  /** Running (not paused): continuous layers fade out when the garden stops. */
  setActive(active: boolean): void {
    this.active = active
    if (!active && this.layers && this.context) for (const layer of Object.values(this.layers)) layer.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.25)
  }

  private start(): void {
    if (typeof window === 'undefined') return
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return
    if (!this.context) {
      const context = this.context = new Context()
      this.master = context.createGain()
      this.master.gain.value = 0
      // A gentle compressor keeps a big splash and a knock from clipping.
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = -14; limiter.ratio.value = 4
      this.master.connect(limiter).connect(context.destination)
      this.white = noiseBuffer(context, false)
      const brown = noiseBuffer(context, true)
      const layer = (buffer: AudioBuffer, filters: BiquadFilterNode[]): Layer => {
        const source = context.createBufferSource()
        source.buffer = buffer; source.loop = true
        const gain = context.createGain()
        gain.gain.value = 0
        let node: AudioNode = source
        for (const filter of filters) node = node.connect(filter)
        node.connect(gain).connect(this.master!)
        source.start(0, Math.random() * 2)
        return { gain }
      }
      const filter = (type: BiquadFilterType, frequency: number, q = 0.7) => {
        const node = context.createBiquadFilter()
        node.type = type; node.frequency.value = frequency; node.Q.value = q
        return node
      }
      const hum = context.createOscillator()
      hum.type = 'triangle'; hum.frequency.value = 58
      const humGain = context.createGain(); humGain.gain.value = 0
      hum.connect(filter('lowpass', 240)).connect(humGain).connect(this.master)
      hum.start()
      this.layers = {
        // A low, soft bed of running water; the character comes from the
        // babbling bubbles on top, not from broadband noise (that roared).
        stream: layer(brown, [filter('lowpass', 700, 0.4), filter('highpass', 120)]),
        splash: layer(this.white, [filter('bandpass', 1800, 0.9), filter('lowpass', 3600)]),
        gurgle: layer(brown, [filter('bandpass', 260, 3)]),
        hum: { gain: humGain },
      }
    }
    void this.context.resume().catch(() => undefined)
  }

  private applyMaster(): void {
    if (!this.context || !this.master) return
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.context.currentTime, 0.15)
  }

  update(state: GardenState, listener: Listener | null = null): void {
    const frame = this.analyzer.frame(state, listener)
    const context = this.context
    if (!context || !this.layers || !this.enabled || !this.active || context.state !== 'running') return
    const now = context.currentTime
    const dt = Math.min(0.25, this.lastFrame ? now - this.lastFrame : 0)
    this.lastFrame = now
    const set = (layer: Layer, value: number) => layer.gain.gain.setTargetAtTime(value, now, 0.3)
    set(this.layers.stream, 0.1 * frame.stream)
    set(this.layers.splash, 0.035 * frame.splash)
    // Babbling: small bubbles ringing as the water runs, more where it flows and falls.
    this.babbleDebt += (frame.stream * 9 + frame.splash * 14) * dt
    while (this.babbleDebt >= 1) { this.babbleDebt--; this.bubble(now + Math.random() * dt, 0.35 + 0.65 * frame.splash) }
    // A siphon gurgles in pulses, like air chasing the water.
    set(this.layers.gurgle, frame.gurgle * (0.1 + 0.08 * Math.sin(now * 17) * Math.sin(now * 5.3)))
    set(this.layers.hum, 0.05 * frame.hum)
    frame.knocks.slice(0, 2).forEach((level, k) => { if (level > 0.02) this.knock(now + k * 0.05, level) })
    // Wheels: at most a few knocks a second, so a fast wheel rumbles instead of rattling.
    for (const level of frame.ticks) {
      if (level < 0.03 || now - this.lastTick < 0.16) continue
      this.lastTick = now
      this.tick(now + Math.random() * 0.03, level)
    }
    const surge = Math.max(0, ...frame.surges)
    if (surge > 0.02) this.surge(now, surge)
    this.dripDebt += frame.drips * dt
    while (this.dripDebt >= 1) { this.dripDebt--; this.drip(now + Math.random() * dt) }
  }

  /** Bamboo striking stone: a sharp click and two hollow resonances. */
  private knock(at: number, level: number): void {
    const context = this.context!, out = context.createGain()
    out.gain.setValueAtTime(0.9 * level, at)
    out.gain.exponentialRampToValueAtTime(0.001, at + 0.45)
    out.connect(this.master!)
    for (const [frequency, level, decay] of [[820, 0.8, 0.28], [1960, 0.35, 0.12], [3900, 0.15, 0.05]] as const) {
      const tone = context.createOscillator(), gain = context.createGain()
      tone.frequency.setValueAtTime(frequency * 1.04, at)
      tone.frequency.exponentialRampToValueAtTime(frequency, at + 0.04)
      gain.gain.setValueAtTime(level, at)
      gain.gain.exponentialRampToValueAtTime(0.001, at + decay)
      tone.connect(gain).connect(out)
      tone.start(at); tone.stop(at + decay + 0.02)
    }
    this.burst(at, 0.02, 2500, 0.6, out)
  }

  /**
   * A heavy wet wooden wheel: a low, damped thud of timber on its axle, with
   * a little splash as the bucket leaves the water.
   */
  private tick(at: number, level: number): void {
    const context = this.context!, out = context.createGain()
    out.gain.setValueAtTime(0.22 * level, at)
    out.gain.exponentialRampToValueAtTime(0.001, at + 0.3)
    const soften = context.createBiquadFilter()
    soften.type = 'lowpass'; soften.frequency.value = 700
    out.connect(soften).connect(this.master!)
    const body = context.createOscillator(), gain = context.createGain()
    body.type = 'sine'
    const pitch = 78 + Math.random() * 18
    body.frequency.setValueAtTime(pitch * 1.5, at)
    body.frequency.exponentialRampToValueAtTime(pitch, at + 0.05)
    gain.gain.setValueAtTime(0.9, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22)
    body.connect(gain).connect(out)
    body.start(at); body.stop(at + 0.25)
    this.burst(at, 0.05, 240, 1.4, out)
    this.burst(at + 0.04, 0.12, 900, 0.8, out, 0.25)
  }

  /** One drop leaving a copper cup. */
  /**
   * One bubble in running water: a short tone whose pitch rises as it
   * rings (Minnaert resonance of a bubble near the surface), softly.
   */
  private bubble(at: number, level: number): void {
    const context = this.context!, gain = context.createGain(), tone = context.createOscillator()
    const pitch = 450 + Math.random() * 900
    const length = 0.035 + Math.random() * 0.05
    tone.frequency.setValueAtTime(pitch, at)
    tone.frequency.exponentialRampToValueAtTime(pitch * 1.6, at + length)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.022 * level, at + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0005, at + length)
    tone.connect(gain).connect(this.master!)
    tone.start(at); tone.stop(at + length + 0.01)
  }

  private drip(at: number): void {
    const context = this.context!, gain = context.createGain(), tone = context.createOscillator()
    const pitch = 1400 + Math.random() * 1600
    tone.frequency.setValueAtTime(pitch * 0.7, at)
    tone.frequency.exponentialRampToValueAtTime(pitch, at + 0.03)
    gain.gain.setValueAtTime(0.05, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.09)
    tone.connect(gain).connect(this.master!)
    tone.start(at); tone.stop(at + 0.1)
  }

  /** The siphon catching: a rush of water and air. */
  private surge(at: number, level: number): void {
    const gain = this.context!.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.5 * level, at + 0.15)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 1.6)
    gain.connect(this.master!)
    this.burst(at, 1.6, 420, 1.5, gain)
  }

  private burst(at: number, length: number, frequency: number, q: number, out: AudioNode, level = 1): void {
    const context = this.context!, source = context.createBufferSource(), filter = context.createBiquadFilter()
    source.buffer = this.white
    filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q
    const gain = context.createGain()
    gain.gain.setValueAtTime(level, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + length + 0.04)
    source.connect(filter).connect(gain).connect(out)
    source.start(at, Math.random() * 2, length + 0.05)
  }

  dispose(): void {
    const context = this.context
    this.context = null; this.layers = null
    void context?.close().catch(() => undefined)
  }
}
