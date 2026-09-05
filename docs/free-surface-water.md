# Vertical free-surface water

The default **물 흐름** view now simulates a vertical maze cross-section. Each water particle carries a fixed area. Gravity, neighbourhood density relaxation, viscosity and swept wall sliding produce falling jets, branches and pools within a maze cell. No solution path, arrival schedule or cell-fill animation drives the water boundary.

- `freeSurface/layout.ts` builds symmetric solid AABBs from the actual maze, a finite top reservoir and a bottom outlet. Inactive cells remain inaccessible. The two visual endpoints use the topmost/bottommost active row.
- `solver.ts` integrates at 120 Hz independently of display quality. A spatial hash bounds neighbour searches; swept AABB movement prevents thin-wall tunnelling. This is a weakly compressible position-based liquid for visual interaction, not calibrated CFD or a 3D incompressible solver.
- `fluid.worker.ts` runs bounded batches off the UI thread. The runtime allows one request in flight, rejects stale generations after restart, drops late snapshots while paused, and falls back to the same solver if initial Worker creation/loading fails. A hidden page accumulates no catch-up debt.
- `renderer.ts` reconstructs a continuous water boundary from velocity-aligned optical footprints. Two wall-aware smoothing passes remove particle-sized bumps. Interior transmission and broad reflections come from the continuous silhouette, while a narrow meniscus highlights the outer boundary; individual density peaks receive no separate lighting. Appearance presets do not alter physics. Pan, zoom and fit also work while paused.
- The existing **3D 수면** view remains available from the mode selector. Its hydraulic model, Blender detail atlases and optics are retained.

## Controls and accounting

**공급 끄기** stops admitting new water while existing water continues to move. **일시정지** freezes simulation and rendering; **처음부터** creates a new generation and resets all counters and inlet state. Speed changes only the number of fixed simulation steps.

Diagnostics use cell squared for 2D water area and cells/second for velocity. An outlet crossing counts each particle once. Discharged particles remain visible below the outlet until leaving the visual domain; their area is already counted as discharged and is excluded from stored area. Other exits are counted separately. Thus `injected = stored + discharged + escaped`.

The deterministic capacity is capped at 18,000 particles. A crowded source or full particle budget throttles actual admission rather than losing water or inventing injection. Long and winding mazes may take substantially longer to fill; under load the bounded work queue slows simulation relative to wall time instead of increasing the integration step or blocking the interface. Renderer quality affects pixels only.

## Optical reconstruction

Fast optical footprints stretch along the snapshot velocity by at most 2×. This bridges close samples in a jet without changing particle positions, collision radii, or water accounting. A conservative world-space solid mask rejects footprints and smoothing samples across walls, including when the camera zooms out. Its one-byte texels are capped at 4096 per axis. All added textures and render targets are released on close.

The coverage field is only an optical surface estimate, not a measurement of water volume. Transmission, reflection, and meniscus lighting are visual approximations. The subtle moving light band uses accepted simulation time and is gated by local velocity; pause freezes it along with the fluid. No independent animation clock or physics tuning is introduced.

## Verification

Focused solver tests cover free fall, solid-wall pooling, uphill return flow, real outlet discharge, reset, finite state and exact particle-area accounting. Layout tests cover masks, asymmetric closed walls and a 150×150 allocation limit. The browser suite covers the default mode, Worker lifecycle, actual wetting, outlet flow, pause pixel identity, inlet-off behaviour, restart and mobile controls. GPU wall-field tests check crossings in both directions, open passages, and negative world coordinates. Legacy optical/atlas tests explicitly select **3D 수면**.
