export type ColorTheme = 'light' | 'dark' | 'system'
export type EffectQuality = 'auto' | 'low' | 'high'

export interface AppSettings {
  theme: ColorTheme
  reducedMotion: boolean
  soundEnabled: boolean
  effectQuality: EffectQuality
  lastProjectId: string | null
}

const SETTINGS_KEY = 'mazecraft.settings.v1'

export const defaultSettings: AppSettings = {
  theme: 'system',
  reducedMotion: false,
  soundEnabled: true,
  effectQuality: 'auto',
  lastProjectId: null,
}

function storageAvailable(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isTheme(value: unknown): value is ColorTheme {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isQuality(value: unknown): value is EffectQuality {
  return value === 'auto' || value === 'low' || value === 'high'
}

export function readSettings(): AppSettings {
  const storage = storageAvailable()
  if (!storage) return { ...defaultSettings }

  try {
    const parsed = JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : defaultSettings.theme,
      reducedMotion:
        typeof parsed.reducedMotion === 'boolean'
          ? parsed.reducedMotion
          : defaultSettings.reducedMotion,
      soundEnabled:
        typeof parsed.soundEnabled === 'boolean'
          ? parsed.soundEnabled
          : defaultSettings.soundEnabled,
      effectQuality: isQuality(parsed.effectQuality)
        ? parsed.effectQuality
        : defaultSettings.effectQuality,
      lastProjectId:
        typeof parsed.lastProjectId === 'string'
          ? parsed.lastProjectId
          : null,
    }
  } catch {
    return { ...defaultSettings }
  }
}

export function writeSettings(settings: AppSettings): boolean {
  const storage = storageAvailable()
  if (!storage) return false
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const settings = { ...readSettings(), ...patch }
  writeSettings(settings)
  return settings
}

export function resetSettings(): AppSettings {
  const settings = { ...defaultSettings }
  writeSettings(settings)
  return settings
}
