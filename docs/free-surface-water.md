# Vertical free-surface water

The default **물 흐름** view now simulates a vertical maze cross-section. Each water particle carries a fixed area. Gravity, neighbourhood density relaxation, viscosity and swept wall sliding produce falling jets, branches and pools within a maze cell. No solution path, arrival schedule or cell-fill animation drives the water boundary.

- `freeSurface/layout.ts` builds symmetric solid AABBs from the actual maze, a finite top reservoir and a bottom outlet. Inactive cells remain inaccessible. The two visual endpoints use the topmost/bottommost active row.
- `solver.ts` integrates at 120 Hz independently of display quality. Four compression-only position-based density projections use a normalized 2D poly6 kernel and each particle's accounted area. Approximate solid-boundary kernel support prevents narrow passages from packing water into the missing wall-side neighbourhood. A spatial hash bounds neighbour searches; swept AABB movement prevents thin-wall tunnelling. This is a weakly compressible position-based liquid for visual interaction, not calibrated CFD or a 3D incompressible solver.
- `fluid.worker.ts` runs bounded batches off the UI thread. The runtime allows one request in flight, rejects stale generations after restart, drops late snapshots while paused, and falls back to the same solver if initial Worker creation/loading fails. A hidden page accumulates no catch-up debt.
- `renderer.ts` reconstructs a continuous surface with overlapping GPU density splats and two separable smoothing passes. A wall mask clips splats and prevents filtering across solid boundaries. World-space normal sampling, bounded optical thickness, Beer–Lambert absorption, Schlick reflection (water IOR 1.333), refracted ceramic grain and velocity-driven contour aeration shade the surface. All movement follows solver snapshots; appearance presets do not alter physics. Exact wall rectangles cover the fluid boundary, with subtle bevels and shadows. Pan, zoom and fit also work while paused.
- The existing **3D 수면** view remains available from the mode selector. Its hydraulic model, Blender detail atlases and optics are retained.

## Controls and accounting

**공급 끄기** stops admitting new water while existing water continues to move. **일시정지** freezes simulation and rendering; **처음부터** creates a new generation and resets all counters and inlet state. Speed changes only the number of fixed simulation steps.

Diagnostics use cell squared for 2D water area and cells/second for velocity. An outlet crossing counts each particle once. Discharged particles remain visible below the outlet until leaving the visual domain; their area is already counted as discharged and is excluded from stored area. Other exits are counted separately. Thus `injected = stored + discharged + escaped`.

The deterministic capacity is capped at 18,000 particles. A crowded source or full particle budget throttles actual admission rather than losing water or inventing injection. Long and winding mazes may take substantially longer to fill; under load the bounded work queue slows simulation relative to wall time instead of increasing the integration step or blocking the interface. Renderer quality affects pixels only.

## Verification

The deterministic 4×3 return-passage fixture first discharges after **189 particles / 3.7044 cell² / 3.392 simulated seconds**, versus **210 / 4.116 / 3.792** on the previous solver. This is a fixture-specific 10% reduction in admitted water, not a universal fill-time guarantee. Settled pool tests at three depths retain an occupied/accounted area ratio of 0.90–0.93 with exact particle accounting.

The optical model remains a 2D cross-section with approximate thickness and a procedural lighting environment. It does not claim full 3D scene refraction, ray tracing or calibrated foam. Four RGBA8 render targets (wall mask, density and two filtered fields) are bounded by the existing 1280/2048 quality ceilings. Added GPU passes and a fourth solver iteration trade some work for more stable volume and smoother surfaces.

For a deterministic optical preview, run `npm run dev` and open `/e2e/fixtures/free-surface-preview.html` (append `?quality=low` for low quality). The fixture exposes `advanceTime(ms)` and `render_game_to_text()` for browser checks. It is not part of the production UI.

Methods: [Macklin and Müller, Position Based Fluids](https://matthias-research.github.io/pages/publications/pbf_sig_preprint.pdf), adapted to normalized 2D density and approximate boundary support; [NVIDIA GPU Gems 2, Generic Refraction Simulation](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-19-generic-refraction-simulation) for reflection/refraction composition.

Focused solver tests cover free fall, solid-wall pooling, uphill return flow, real outlet discharge, reset, finite state and exact particle-area accounting. Layout tests cover masks, asymmetric closed walls and a 150×150 allocation limit. The browser suite covers the default mode, Worker lifecycle, actual wetting, outlet flow, pause pixel identity, inlet-off behaviour, restart and mobile controls. Legacy optical/atlas tests explicitly select **3D 수면**.
