import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createTerraceElevation, createTerraceUniforms, MAX_TERRACE_KNOTS, splitTerraceGeometry, terraceElevationAt, terraceElevationSlopeAt, warpTerraceGeometry } from './terraceElevation'

describe('shared terrace elevation', () => {
  const profile = createTerraceElevation({ topY: 0, bottomY: 8 })
  const steppedProfile = createTerraceElevation({ topY: 0, bottomY: 8 }, { plateauCount: 4, totalRise: 1.2 })

  it('keeps the entire default basin flat, with small elevation changes only outside the inlet and outlet', () => {
    expect(profile.plateauCount).toBe(1)
    expect(profile.totalRise).toBe(0)
    for (let y = -8; y <= 0; y += 0.025) {
      expect(terraceElevationAt(profile, y)).toBe(0)
      expect(terraceElevationSlopeAt(profile, y)).toBe(0)
    }
    expect(profile.breakpoints.some(y => y > -8 && y < 0)).toBe(false)
    expect(terraceElevationAt(profile, -8.8)).toBe(-0.20)
    expect(terraceElevationAt(profile, 1)).toBe(0.12)
    for (let y = -9; y < 1; y += 0.025) expect(terraceElevationAt(profile, y + 0.025)).toBeGreaterThanOrEqual(terraceElevationAt(profile, y) - 1e-10)
  })

  it('retains explicit multi-level options for existing callers', () => {
    expect(steppedProfile.plateauCount).toBe(4)
    for (const [y, expected] of [[-1, 1.2], [-3, 0.8], [-5, 0.4], [-7, 0]]) expect(terraceElevationAt(steppedProfile, y)).toBeCloseTo(expected, 10)
    for (const y of [-1, -3, -5, -7]) expect(terraceElevationSlopeAt(steppedProfile, y)).toBe(0)
    const custom = createTerraceElevation({ topY: 0, bottomY: 8 }, { plateauCount: 2, totalRise: 0.4, inletRise: 0.08, outletDrop: 0.1 })
    expect(terraceElevationAt(custom, 1)).toBeCloseTo(0.48)
    expect(terraceElevationAt(custom, -9)).toBeCloseTo(-0.1)
  })

  it('shares precisely the CPU profile in fixed-size GPU uniforms', () => {
    const uniforms = createTerraceUniforms(profile)
    expect(uniforms.uTerraceKnots.value).toHaveLength(MAX_TERRACE_KNOTS)
    expect(uniforms.uTerraceKnotCount.value).toBe(profile.knots.length)
    const knots = uniforms.uTerraceKnots.value as THREE.Vector2[]
    for (let y = -9; y < 2; y += 0.013) {
      let value = knots[0].y
      for (let i = 1; i < profile.knots.length; i++) {
        const a = knots[i - 1], b = knots[i]
        value = THREE.MathUtils.lerp(value, b.y, THREE.MathUtils.clamp((y - a.x) / (b.x - a.x), 0, 1))
      }
      expect(value).toBeCloseTo(terraceElevationAt(profile, y), 10)
    }
  })

  it('supports offset masks and one-row mazes without duplicate knots', () => {
    for (const bounds of [{ topY: 3, bottomY: 4 }, { topY: 3, bottomY: 10 }, { topY: 0, bottomY: 24 }]) {
      const p = createTerraceElevation(bounds)
      expect(p.plateauCount).toBe(1)
      expect(p.knots.length).toBeLessThanOrEqual(MAX_TERRACE_KNOTS)
      expect(terraceElevationAt(p, -bounds.bottomY)).toBe(0)
      expect(terraceElevationAt(p, -bounds.topY)).toBe(0)
      expect(p.breakpoints.some(y => y > -bounds.bottomY && y < -bounds.topY)).toBe(false)
      for (let i = 1; i < p.knots.length; i++) expect(p.knots[i].worldY).toBeGreaterThan(p.knots[i - 1].worldY)
    }
    expect(() => createTerraceElevation({ topY: 1, bottomY: 0 })).toThrow()
    expect(() => createTerraceElevation({ topY: 0, bottomY: 8 }, { transitionWidth: 0 })).toThrow()
  })

  it('splits large floor triangles at every seam while retaining material and UVs', () => {
    const source = new THREE.PlaneGeometry(4, 8, 1, 1)
    source.translate(2, -4, 0)
    source.clearGroups(); source.addGroup(0, 3, 2); source.addGroup(3, 3, 5)
    const original = Array.from(source.getAttribute('position').array)
    const split = splitTerraceGeometry(source, steppedProfile)
    const p = split.getAttribute('position'), uv = split.getAttribute('uv')
    expect(p.count).toBeGreaterThan(6)
    expect(split.groups.map(group => group.materialIndex)).toEqual([2, 5])
    expect(split.groups.reduce((sum, group) => sum + group.count, 0)).toBe(p.count)
    for (let i = 0; i < p.count; i += 3) {
      const low = Math.min(p.getY(i), p.getY(i + 1), p.getY(i + 2))
      const high = Math.max(p.getY(i), p.getY(i + 1), p.getY(i + 2))
      expect(steppedProfile.breakpoints.some(y => y > low + 1e-6 && y < high - 1e-6)).toBe(false)
    }
    for (let i = 0; i < p.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(p.getX(i) / 4, 6)
      expect(uv.getY(i)).toBeCloseTo((p.getY(i) + 8) / 8, 6)
    }
    expect(Array.from(source.getAttribute('position').array)).toEqual(original)
    source.dispose(); split.dispose()
  })

  it('warps the complete floor and preserves the foundation anchor', () => {
    const source = new THREE.BoxGeometry(4, 8, 0.65)
    source.translate(2, -4, -0.325)
    const warped = warpTerraceGeometry(source, steppedProfile, { mode: 'fixed-bottom', bottomZ: -0.65, topZ: 0 })
    const p = warped.getAttribute('position'), n = warped.getAttribute('normal')
    let anchors = 0, upper = 0
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getZ(i) + 0.65) < 1e-6) anchors++
      if (Math.abs(p.getZ(i) - terraceElevationAt(steppedProfile, p.getY(i))) < 1e-6) upper++
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5)
    }
    expect(anchors).toBeGreaterThan(6); expect(upper).toBeGreaterThan(6)
    expect(warped.boundingBox!.max.z).toBeCloseTo(1.2)
    expect(warped.boundingBox!.min.z).toBeCloseTo(-0.65)
    source.dispose(); warped.dispose()
  })
})
