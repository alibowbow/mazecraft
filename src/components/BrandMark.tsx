import { Waves } from 'lucide-react'

/** MazeCraft's mark: the water atelier's waves, in the accent colour. */
export function BrandMark({ size = 25 }: { size?: number }) {
  return <Waves className="brand-logo" size={size} strokeWidth={1.8} aria-hidden="true" />
}
