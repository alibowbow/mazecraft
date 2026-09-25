import { useEffect, useState, type RefObject } from 'react'
import { ChevronDown, Clapperboard, Sailboat, Volume2, VolumeX } from 'lucide-react'

const SOUND_KEY = 'mazecraft.sound.v1'

function readSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

/** The viewer's garden-sound preference (on by default), remembered per browser. */
export function useGardenSoundPreference(): [boolean, (value: boolean) => void] {
  const [sound, setSound] = useState(readSound)
  const update = (value: boolean) => {
    setSound(value)
    try { localStorage.setItem(SOUND_KEY, value ? 'on' : 'off') } catch { /* Storage may be disabled. */ }
  }
  return [sound, update]
}

export function SoundToggle({ sound, onToggle }: { sound: boolean; onToggle(): void }) {
  return <button className="ws-icon" aria-label={sound ? '소리 끄기' : '소리 켜기'} title={sound ? '소리 끄기' : '소리 켜기'} aria-pressed={sound} onClick={onToggle}>
    {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
  </button>
}

/** Playback speeds shared by the studios; 4× and 8× show the whole course quickly. */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8] as const

export function SpeedSelect({ value, onChange }: { value: number; onChange(value: number): void }) {
  return <label className="ws-speed"><span className="sr-only">재생 속도</span>
    <select aria-label="재생 속도" value={value} onChange={event => onChange(Number(event.target.value))}>
      {PLAYBACK_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
    </select><ChevronDown size={13} /></label>
}

const CINEMATIC_KEY = 'mazecraft.cinematic.v1'

/**
 * The cinematic camera preference (on by default): while the water runs the
 * garden is filmed in shots; grabbing the view by hand turns it off.
 */
export function useCinematicPreference(mount: RefObject<HTMLElement | null>): [boolean, (value: boolean) => void] {
  const [cinematic, setCinematic] = useState(() => { try { return localStorage.getItem(CINEMATIC_KEY) !== 'off' } catch { return true } })
  const update = (value: boolean) => {
    setCinematic(value)
    try { localStorage.setItem(CINEMATIC_KEY, value ? 'on' : 'off') } catch { /* Storage may be disabled. */ }
  }
  useEffect(() => {
    const element = mount.current
    if (!element) return
    const end = () => update(false)
    element.addEventListener('cinematic-end', end)
    return () => element.removeEventListener('cinematic-end', end)
  }, [mount])
  return [cinematic, update]
}

export function CinematicToggle({ cinematic, onToggle }: { cinematic: boolean; onToggle(): void }) {
  return <button className="ws-icon" aria-label="시네마틱 카메라" title={cinematic ? '시네마틱 카메라 끄기' : '시네마틱 카메라: 물이 흐르는 동안 영화처럼 촬영'} aria-pressed={cinematic} onClick={onToggle}>
    <Clapperboard size={17} />
  </button>
}

const FLOATERS = [['duck', '고무오리', '🦆'], ['ball', '비치볼', '🏐'], ['leaf', '나뭇잎배', '🍃'], ['block', '나무토막', '🪵']] as const
export type FloaterChoice = typeof FLOATERS[number][0]

/** Drop something into the water: a Rapier rigid body that rides the flow. */
export function FloaterMenu({ onDrop }: { onDrop(kind: FloaterChoice): void }) {
  const [open, setOpen] = useState(false)
  return <div className="ws-floaters">
    <button className="ws-icon" aria-label="물에 띄우기" title="물에 띄우기" aria-expanded={open} onClick={() => setOpen(!open)}><Sailboat size={17} /></button>
    {open && <div className="ws-floater-menu" role="menu" aria-label="띄울 물체">
      {FLOATERS.map(([kind, name, icon]) => <button key={kind} role="menuitem" onClick={() => { onDrop(kind); setOpen(false) }}><span aria-hidden>{icon}</span>{name}</button>)}
    </div>}
  </div>
}
