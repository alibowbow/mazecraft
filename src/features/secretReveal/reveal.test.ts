import { describe, expect, it } from 'vitest'
import { safeSecretLink } from './reveal'

describe('safeSecretLink', () => {
  it.each([
    ['https://example.com/path', 'https://example.com/path'],
    ['http://example.com/', 'http://example.com/'],
    ['mailto:hello@example.com', 'mailto:hello@example.com'],
  ])('allows supported links', (input, expected) => {
    expect(safeSecretLink(input)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/private',
    '//example.com/path',
    'not a link',
    '',
  ])('rejects unsafe or invalid input: %s', (input) => {
    expect(safeSecretLink(input)).toBeNull()
  })

  it('rejects oversized links', () => {
    expect(safeSecretLink(`https://example.com/${'a'.repeat(4096)}`)).toBeNull()
  })
})
