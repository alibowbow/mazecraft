/**
 * MazeCraft's mark: a drafted maze with a line of water running through it,
 * the app's two halves in one glyph. Colours follow the theme tokens.
 */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1.25" y="1.25" width="29.5" height="29.5" rx="8.5" fill="var(--brand-paper, #fffdf8)" stroke="var(--brand-ink, currentColor)" strokeWidth="1.8" />
      <path d="M8 7.5v10.5M8 7.5h10M13.5 12.5h10v6M18.5 12.5v-5" fill="none" stroke="var(--brand-ink, currentColor)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 24.2c2.6-2 5-2 7.6 0s5 2 7.6 0 5-2 7.6 0" fill="none" stroke="var(--brand-water, #2a8f96)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="23.5" cy="18.5" r="1.7" fill="var(--brand-water, #2a8f96)" />
    </svg>
  )
}
