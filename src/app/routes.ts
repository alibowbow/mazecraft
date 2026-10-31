export type Screen = 'home' | 'water' | 'craft' | 'studio' | 'play'
export type CraftMode = 'free' | 'challenge'

/** A screen as it is written in the address bar. */
export interface AppLocation {
  screen: Screen
  /** The home, scrolled to the saved projects. */
  library?: boolean
  craftMode?: CraftMode
  /** The address carries a shared maze (#/play?data=… or #/water?data=…). */
  shared?: boolean
  /** Today's maze (#/daily). */
  daily?: boolean
}

/**
 * Hash routes keep static hosting simple: no server rewrite is needed and
 * Back, Forward and reload all return to the same screen.
 */
export function parseLocation(hash: string): AppLocation {
  const match = /^#\/([a-z-]+)\/?(?:\?(.*))?$/.exec(hash)
  if (!match) return { screen: 'home' }
  const [, head, query] = match
  const shared = Boolean(query && new URLSearchParams(query).get('data'))
  switch (head) {
    case 'library': return { screen: 'home', library: true }
    case 'water': return shared ? { screen: 'water', shared } : { screen: 'water' }
    case 'craft': return { screen: 'craft', craftMode: 'free' }
    case 'challenges': return { screen: 'craft', craftMode: 'challenge' }
    case 'studio': return { screen: 'studio' }
    case 'play': return shared ? { screen: 'play', shared } : { screen: 'play' }
    case 'daily': return { screen: 'play', daily: true }
    default: return { screen: 'home' }
  }
}

export function hashFor(location: AppLocation): string {
  switch (location.screen) {
    case 'home': return location.library ? '#/library' : ''
    case 'water': return '#/water'
    case 'craft': return location.craftMode === 'challenge' ? '#/challenges' : '#/craft'
    case 'studio': return '#/studio'
    case 'play': return location.daily ? '#/daily' : '#/play'
  }
}
