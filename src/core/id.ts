let sequence = 0

function randomPart(length: number): string {
  const crypto = globalThis.crypto
  if (crypto?.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint32Array(Math.ceil(length / 6))), (value) => value.toString(36).padStart(6, '0'))
      .join('')
      .slice(0, length)
  }
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, '0')
}

/**
 * A unique identifier. crypto.randomUUID exists only on HTTPS and localhost,
 * so a phone testing the dev server over a LAN address needs this fallback.
 */
export function createId(prefix = 'id'): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return uuid.call(globalThis.crypto)
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${randomPart(8)}`
}

/** A short random token, e.g. a fresh maze seed. */
export function randomToken(length = 8): string {
  return randomPart(length)
}
