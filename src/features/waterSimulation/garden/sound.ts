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
  /** Discrete events since the previous frame. */
  knocks: number
  ticks: number
  surges: number
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

  frame(state: GardenState): SoundFrame {
    const { layout } = this
    let flow = state.sourceRate, power = 0, chainFlow = 0
    for (const edge of layout.edges) {
      const q = Math.abs(state.discharge[edge.index] ?? 0)
      flow += q
      if (edge.chain) { chainFlow += q; continue }
      // Water leaves over the crest and falls to the surface below; a
      // drowned sill only runs.
      const below = edge.b >= 0 ? Math.max(state.levels[edge.b] ?? 0, layout.pools[edge.b].floor) : edge.crest - 0.4
      power += RHO_G * q * Math.max(0, edge.crest - below)
    }
    let knocks = 0, ticks = 0, surges = 0
    state.tipperAngles.forEach((angle, i) => {
      // Tipped past level, then swung back onto its stop: the knock.
      if (angle < 0) this.tipped[i] = true
      else if (this.tipped[i] && angle > TIPPER_REST - 0.04) { this.tipped[i] = false; knocks++ }
    })
    const count = (turns: number[], angles: Float32Array, buckets: number) => angles.forEach((angle, i) => {
      const position = Math.floor(angle / (Math.PI * 2 / buckets))
      if (Number.isFinite(turns[i]) && position !== turns[i]) ticks += Math.min(3, Math.abs(position - turns[i]))
      turns[i] = position
    })
    count(this.wheelTurns, state.wheelAngles, 12)
    count(this.noriaTurns, state.noriaAngles, 8)
    let running = 0
    state.siphonPrimed.forEach((primed, i) => {
      if (primed > 0.5 && !this.primed[i]) surges++
      this.primed[i] = primed > 0.5
      running += primed
    })
    const lifted = Array.from(state.liftLoads).reduce((sum, q) => sum + q, 0)
    return {
      stream: soft(flow / 0.06),
      splash: soft(power / 250),
      gurgle: Math.min(1, running),
      hum: layout.lifts.length ? 0.4 + 0.6 * soft(lifted / 0.03) : 0,
      drips: Math.min(40, chainFlow * 900),
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
  private volume = 0.7
  private dripDebt = 0
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
        stream: layer(brown, [filter('bandpass', 520, 0.5), filter('peaking', 1400, 1)]),
        splash: layer(this.white, [filter('highpass', 900), filter('lowpass', 7000)]),
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

  update(state: GardenState): void {
    const frame = this.analyzer.frame(state)
    const context = this.context
    if (!context || !this.layers || !this.enabled || !this.active || context.state !== 'running') return
    const now = context.currentTime
    const dt = Math.min(0.25, this.lastFrame ? now - this.lastFrame : 0)
    this.lastFrame = now
    const set = (layer: Layer, value: number) => layer.gain.gain.setTargetAtTime(value, now, 0.3)
    set(this.layers.stream, 0.5 * frame.stream)
    set(this.layers.splash, 0.28 * frame.splash)
    // A siphon gurgles in pulses, like air chasing the water.
    set(this.layers.gurgle, frame.gurgle * (0.25 + 0.2 * Math.sin(now * 17) * Math.sin(now * 5.3)))
    set(this.layers.hum, 0.05 * frame.hum)
    for (let k = 0; k < Math.min(frame.knocks, 2); k++) this.knock(now + k * 0.05)
    for (let k = 0; k < Math.min(frame.ticks, 3); k++) this.tick(now + k * 0.03)
    if (frame.surges) this.surge(now)
    this.dripDebt += frame.drips * dt
    while (this.dripDebt >= 1) { this.dripDebt--; this.drip(now + Math.random() * dt) }
  }

  /** Bamboo striking stone: a sharp click and two hollow resonances. */
  private knock(at: number): void {
    const context = this.context!, out = context.createGain()
    out.gain.setValueAtTime(0.9, at)
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

  /** A wooden wheel bucket passing its axle. */
  private tick(at: number): void {
    const context = this.context!, gain = context.createGain(), tone = context.createOscillator()
    tone.type = 'triangle'
    tone.frequency.value = 300 + Math.random() * 60
    gain.gain.setValueAtTime(0.06, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.07)
    tone.connect(gain).connect(this.master!)
    tone.start(at); tone.stop(at + 0.08)
  }

  /** One drop leaving a copper cup. */
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
  private surge(at: number): void {
    const gain = this.context!.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.5, at + 0.15)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 1.6)
    gain.connect(this.master!)
    this.burst(at, 1.6, 420, 1.5, gain)
  }

  private burst(at: number, length: number, frequency: number, q: number, out: AudioNode): void {
    const context = this.context!, source = context.createBufferSource(), filter = context.createBiquadFilter()
    source.buffer = this.white
    filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q
    source.connect(filter).connect(out)
    source.start(at, Math.random() * 2, length + 0.05)
  }

  dispose(): void {
    const context = this.context
    this.context = null; this.layers = null
    void context?.close().catch(() => undefined)
  }
}
