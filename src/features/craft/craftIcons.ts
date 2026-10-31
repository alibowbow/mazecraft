import {
  Castle, ChartBarDecreasing, Cog, Cylinder, Drill, Droplets, Fan, Flower2, Grid3x3, Link, Spline, Tornado, type LucideIcon,
} from 'lucide-react'
import type { CraftExit, CraftKind } from '../waterSimulation/garden/craft'

export const DEVICE_ICONS: Record<CraftKind, LucideIcon> = {
  maze: Grid3x3, terraces: ChartBarDecreasing, pond: Flower2, noria: Cog, screw: Drill,
  spiral: Tornado, zigzag: Spline, aqueduct: Castle, siphon: Cylinder,
}

export const EXIT_ICONS: Record<CraftExit, LucideIcon> = { plain: Droplets, tipper: Link, wheel: Fan, chain: Link }
