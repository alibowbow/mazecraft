#!/usr/bin/env python3
from pathlib import Path

TARGET = Path("src/features/waterSimulation/waterSceneRuntime.ts")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    source = TARGET.read_text(encoding="utf-8")
    if "createOutletWaterfallGeometry" in source:
        print("Outlet waterfall fix is already applied.")
        return

    source = replace_once(
        source,
        """import {
  buildWaterTopologyAtlas,
""",
        """import {
  advanceOutletWaterfallVisualState,
  createOutletDropletGeometry,
  createOutletWaterfallGeometry,
  createOutletWaterfallMaterial,
  createOutletWaterfallVisualState,
  resetOutletWaterfallVisualState,
  resolveOutletTargetStrength,
  updateOutletWaterfallGeometry,
  type OutletWaterfallVisualState,
} from './outletWaterfallVisual'
import {
  buildWaterTopologyAtlas,
""",
        "outlet visual import",
    )

    source = replace_once(
        source,
        """  private latestOutletDischarge = 0
  private lastFoamSimulationTime = 0
""",
        """  private latestOutletDischarge = 0
  private readonly outletVisualState: OutletWaterfallVisualState =
    createOutletWaterfallVisualState()
  private lastOutletVisualElapsedMs = 0
  private lastFoamSimulationTime = 0
""",
        "outlet visual state properties",
    )

    source = replace_once(
        source,
        """    this.latestOutletDischarge = 0
    this.waterSurfaceMaterial.uniforms.uWaveTime.value = 0
""",
        """    this.latestOutletDischarge = 0
    resetOutletWaterfallVisualState(this.outletVisualState)
    this.lastOutletVisualElapsedMs = 0
    this.waterSurfaceMaterial.uniforms.uWaveTime.value = 0
""",
        "restart outlet visual state",
    )

    source = replace_once(
        source,
        """    const outletJet = new THREE.Mesh(
      createFallingJetGeometry(
        this.quality === 'high' ? 24 : 16,
        this.quality === 'high' ? 12 : 8,
      ),
      waterMaterial.clone(),
    )
""",
        """    const outletJet = new THREE.Mesh(
      createOutletWaterfallGeometry(this.quality),
      createOutletWaterfallMaterial(this.quality),
    )
""",
        "outlet ribbon mesh",
    )

    source = replace_once(
        source,
        """    updateFallingJetGeometry(
      outletJet.geometry,
      WATER_OUTLET_DROP_HEIGHT,
      0,
      0,
      0,
      1.28,
    )
""",
        """    updateOutletWaterfallGeometry(outletJet.geometry, {
      dropHeight: WATER_OUTLET_DROP_HEIGHT,
      state: this.outletVisualState,
    })
""",
        "initial outlet ribbon geometry",
    )

    source = replace_once(
        source,
        """    const outletCount = this.quality === 'high' ? 42 : 14
""",
        """    const outletCount = this.quality === 'high' ? 72 : 30
""",
        "outlet particle count",
    )

    source = replace_once(
        source,
        """    const outletDroplets = new THREE.InstancedMesh(
      dropletGeometry.clone(),
      waterMaterial.clone(),
      outletCount,
    )
""",
        """    const outletDropletMaterial = waterMaterial.clone()
    outletDropletMaterial.opacity = 0.72
    outletDropletMaterial.roughness = 0.1
    const outletDroplets = new THREE.InstancedMesh(
      createOutletDropletGeometry(this.quality),
      outletDropletMaterial,
      outletCount,
    )
""",
        "smaller outlet particles",
    )

    source = replace_once(
        source,
        """    this.outletJet.scale.set(1, 1, 1)
    this.outletJet.visible = false
    this.outletPool.visible = false
""",
        """    this.outletJet.scale.set(1, 1, 1)
    this.outletJet.visible = false
    const outletMaterial = this.outletJet.material as THREE.MeshPhysicalMaterial
    outletMaterial.opacity = 0
    updateOutletWaterfallGeometry(this.outletJet.geometry, {
      dropHeight: WATER_OUTLET_DROP_HEIGHT,
      state: this.outletVisualState,
    })
    this.outletPool.visible = false
""",
        "reset outlet ribbon",
    )

    source = replace_once(
        source,
        """    const outletStrength = smoothstep(
      0.00005,
      0.012,
      this.latestOutletDischarge,
    )
    const flowElapsedMs = this.latestDiagnostics.simulationTime * 1_000
    updateFallingJetGeometry(
      this.outletJet.geometry,
      WATER_OUTLET_DROP_HEIGHT,
      flowElapsedMs,
      outletStrength,
      outletStrength,
      1.28,
    )
    this.outletJet.visible = outletStrength > 0.01

    const poolPulse = 1 + Math.sin(flowElapsedMs * 0.0065) * 0.035
    this.outletPool.visible = outletStrength > 0.01
    this.outletPool.scale.set(poolPulse, 2 - poolPulse, 1)
    const splashPhase = (flowElapsedMs * 0.00145) % 1
    const splashMaterial = this.outletSplashRing.material as THREE.MeshBasicMaterial
    this.outletSplashRing.visible = outletStrength > 0.02
    this.outletSplashRing.scale.setScalar(0.72 + splashPhase * 1.35)
    splashMaterial.opacity =
      (1 - splashPhase) * outletStrength * (this.quality === 'high' ? 0.62 : 0.48)
""",
        """    const outletDeltaSeconds =
      this.lastOutletVisualElapsedMs <= 0
        ? 0
        : Math.max(
            0,
            Math.min(
              0.1,
              (this.elapsedMs - this.lastOutletVisualElapsedMs) / 1_000,
            ),
          )
    this.lastOutletVisualElapsedMs = this.elapsedMs
    advanceOutletWaterfallVisualState(this.outletVisualState, {
      targetStrength: resolveOutletTargetStrength(
        this.latestOutletDischarge,
      ),
      deltaSeconds: outletDeltaSeconds,
      paused: this.paused,
    })
    updateOutletWaterfallGeometry(this.outletJet.geometry, {
      dropHeight: WATER_OUTLET_DROP_HEIGHT,
      state: this.outletVisualState,
    })
    const outletStrength = this.outletVisualState.strength
    const flowElapsedMs = this.outletVisualState.timeSeconds * 1_000
    const outletMaterial = this.outletJet.material as THREE.MeshPhysicalMaterial
    outletMaterial.opacity = 0.16 + outletStrength * 0.66
    this.outletJet.visible =
      outletStrength > 0.004 && this.outletVisualState.frontProgress > 0.01

    const poolPulse =
      1 + Math.sin(flowElapsedMs * 0.0049) * 0.016 * outletStrength
    this.outletPool.visible = outletStrength > 0.008
    this.outletPool.scale.set(
      poolPulse,
      1 + (1 - poolPulse) * 0.45,
      1,
    )
    const splashPhase = (flowElapsedMs * 0.0012) % 1
    const splashMaterial = this.outletSplashRing.material as THREE.MeshBasicMaterial
    this.outletSplashRing.visible = outletStrength > 0.025
    this.outletSplashRing.scale.setScalar(0.78 + splashPhase * 1.18)
    splashMaterial.opacity =
      (1 - splashPhase) * outletStrength *
      (this.quality === 'high' ? 0.54 : 0.4)
""",
        "smooth outlet stream update",
    )

    source = replace_once(
        source,
        """  private updateOutletParticles() {
    const graph = this.project.mazeGraph
    const bottomEdge = -graph.rows / 2
    const flowElapsedMs = this.latestDiagnostics.simulationTime * 1_000
    const outletStrength = smoothstep(
      0.00005,
      0.012,
      this.latestOutletDischarge,
    )
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      const seed = this.outletSeeds[index]
      if (outletStrength < 0.02) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const phase = (flowElapsedMs * 0.0018 + seed.phase + 10) % 1
      const fan = Math.sin(phase * Math.PI)
      this.particleDummy.position.set(
        this.exitPosition.x + seed.drift * fan * 0.38,
        bottomEdge - 0.08 - phase * (1.34 + seed.lift * 0.18),
        WATER_SURFACE_Z + seed.depth * 0.08 + fan * 0.07,
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.45)
      const fade = Math.sin(phase * Math.PI) * outletStrength
      this.particleDummy.scale.set(
        seed.size * fade * 1.08,
        seed.size * fade * (1.3 + phase * 1.4),
        seed.size * fade * 0.9,
      )
      this.particleDummy.updateMatrix()
      this.outletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.outletDroplets.instanceMatrix.needsUpdate = true
  }
""",
        """  private updateOutletParticles() {
    const graph = this.project.mazeGraph
    const bottomEdge = -graph.rows / 2
    const outletStrength = this.outletVisualState.strength
    const flowTimeSeconds = this.outletVisualState.timeSeconds
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      const seed = this.outletSeeds[index]
      if (
        outletStrength < 0.015 ||
        this.outletVisualState.frontProgress < 0.58
      ) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const phase =
        (flowTimeSeconds * (0.74 + seed.lift * 0.22) + seed.phase) % 1
      const breakup = smoothstep(0.38, 1, phase)
      const lifecycle = Math.sin(
        Math.PI * clamp01((phase - 0.26) / 0.74),
      )
      if (lifecycle <= 0.015) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const horizontalSpread =
        seed.drift * (0.025 + breakup * 0.15) +
        Math.sin(flowTimeSeconds * 8.2 + index * 1.71) *
          (0.006 + breakup * 0.014)
      this.particleDummy.position.set(
        this.exitPosition.x + horizontalSpread,
        bottomEdge - 0.04 - phase * WATER_OUTLET_DROP_HEIGHT * 0.94,
        WATER_SURFACE_Z - phase * 0.075 +
          seed.depth * (0.018 + breakup * 0.06),
      )
      this.particleDummy.rotation.set(
        0,
        0,
        seed.drift * 0.22 - horizontalSpread * 0.8,
      )
      const radialScale =
        seed.size * outletStrength * lifecycle * (0.55 + breakup * 0.65)
      this.particleDummy.scale.set(
        Math.max(0.001, radialScale * 0.72),
        Math.max(0.001, radialScale * (1.7 + phase * 2.1)),
        Math.max(0.001, radialScale * 0.62),
      )
      this.particleDummy.updateMatrix()
      this.outletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.outletDroplets.instanceMatrix.needsUpdate = true
  }
""",
        "continuous outlet particle motion",
    )

    source = replace_once(
        source,
        """  private updateEffects(now: number) {
    this.updateStreams()
    const impactBurstActive =
""",
        """  private updateEffects(now: number) {
    this.updateStreams()
    // The outlet is a small system and updates every render frame. Using the
    // interpolated visual clock removes the 25 Hz snapshot stepping seen as
    // block-like clumps on mobile.
    this.updateOutletParticles()
    const impactBurstActive =
""",
        "per-frame outlet particles",
    )

    source = replace_once(
        source,
        """    if (!impactBurstActive) this.updateSplashParticles()
    this.updateOutletParticles()
    this.updateBubbles()
""",
        """    if (!impactBurstActive) this.updateSplashParticles()
    this.updateBubbles()
""",
        "remove throttled outlet update",
    )

    TARGET.write_text(source, encoding="utf-8")
    print("Applied smooth outlet waterfall fix.")


if __name__ == "__main__":
    main()
