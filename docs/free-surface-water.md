# Vertical free-surface water

The default **물 흐름** view now simulates a vertical maze cross-section. Each water particle carries a fixed area. Gravity, neighbourhood density relaxation, viscosity and swept wall sliding produce falling jets, branches and pools within a maze cell. No solution path, arrival schedule or cell-fill animation drives the water boundary.

- `freeSurface/layout.ts` builds symmetric solid AABBs from the actual maze, a tapered top funnel and a bottom outlet. The funnel's collision walls and visible bowl share the same dimensions; water enters above its mouth and falls through its neck. Inactive cells remain inaccessible. The two visual endpoints use the topmost/bottommost active row.
- `solver.ts` integrates at 120 Hz independently of display quality. A spatial hash bounds neighbour searches; swept AABB movement prevents thin-wall tunnelling. This is a weakly compressible position-based liquid for visual interaction, not calibrated CFD or a 3D incompressible solver.
- `fluid.worker.ts` runs bounded batches off the UI thread. The runtime allows one request in flight and starts the next batch on completion when physical time is owed, independently of the next render frame. Completed snapshots coalesce into one displayed state per frame; UI counters use that displayed state. It rejects stale generations after restart, drops queued/late snapshots while paused, and falls back to the same solver if initial Worker creation/loading fails. A hidden page accumulates no catch-up debt.
- `renderer.ts` reconstructs a continuous water boundary from velocity-aligned optical footprints. Two wall-aware smoothing passes remove particle-sized bumps. Interior transmission and broad reflections come from the continuous silhouette, while a narrow meniscus highlights the outer boundary; individual density peaks receive no separate lighting. Appearance presets do not alter physics. Pan, zoom and fit also work while paused.
- **물 흐름** and **3D 수면** now share one particle runtime, Worker and snapshot. Changing the view preserves the water, time, pause state and supply state. `presentation3d.ts` projects the continuous water field onto an actual board with extruded maze walls; the camera can orbit, pan and zoom. This is a 3D presentation of the same vertical 2D fluid cross-section, not a separate volumetric fluid solver. The previous hydraulic renderer and Blender atlas modules remain in the repository but are no longer the dialog's 3D runtime.

## Controls and accounting

**공급 끄기** stops admitting new water while existing water continues to move. **일시정지** freezes simulation and rendering; **처음부터** creates a new generation and resets all counters and inlet state. Speed changes only the number of fixed simulation steps.

Both views provide the same controls. In 2D, drag pans; in 3D, drag orbits and Shift-drag pans. A two-finger gesture pans and zooms in either view. The changing footer narration and outlet notification have been removed; source backpressure remains available in diagnostics without repeated messages.

Diagnostics use cell squared for 2D water area and cells/second for velocity. An outlet crossing counts each particle once. Discharged particles remain visible below the outlet until leaving the visual domain; their area is already counted as discharged and is excluded from stored area. Other exits are counted separately. Thus `injected = stored + discharged + escaped`.

The deterministic capacity is capped at 18,000 particles. A crowded source or full particle budget throttles actual admission rather than losing water or inventing injection. Long and winding mazes may take substantially longer to fill; under load the bounded work queue slows simulation relative to wall time instead of increasing the integration step or blocking the interface. Renderer quality affects pixels only.

## Filling rate

The source checks all six emission lanes before declaring backpressure. The previous implementation stopped at one occupied lane and discarded its remaining supply budget, even when other lanes were free. Launch speed now matches the requested particles per second and lane spacing, capped by the existing maximum velocity. Nominal supply rate, particle area, gravity, collision handling and pressure relaxation are unchanged. A fully blocked nozzle retains at most one pending particle; turning supply off clears that remainder.

A separate clock defect previously counted at most 50 ms per render frame. At 10 fps that discarded half of the physical elapsed time. The Worker path now counts normal frame delays up to 250 ms and drains a bounded 500 ms backlog in batches of at most twelve 1/120-second steps. Rendering does not need to finish between every physics batch. This recovers ordinary slow-frame time without accumulating long hidden-tab delays or unbounded catch-up work. The main-thread fallback retains its smaller per-frame work limit.

In a deterministic closed-cell fixture after one simulated second, admitted particles increased from 55 to 90, particles inside the cell from 28 to 48, and slow pooled particles from 11 to 29. The slow-particle surface-height estimate rose from 0.409 to 0.740 cell; this excludes the inlet and falling jet. In the seeded 6×6 maze, stored particle area after five simulated seconds increased from 5.72 to 9.62 cell². These are controlled visual-solver measurements, not calibrated physical-volume predictions or a universal fill-time guarantee.

A before/after headless Chromium measurement in the same container used about nine wall-clock seconds per case, with no concurrent test load. Physical progress as a fraction of elapsed wall time improved as follows:

| Maze / graphics quality | Before | After |
| --- | ---: | ---: |
| 6×6 / low | 69.3% | 98.2% |
| 6×6 / high | 59.2% | 98.0% |
| 24×24 / low | 61.3% | 94.8% |
| 24×24 / high | 59.0% | 78.5% |

The corrected source also puts more particles into the scene during that time. The 24×24 high-quality case had 2.56 times as many particles after the fix and remained limited by software rendering/solver work. These results do not promise real-time performance on every device or maze.

## Optical reconstruction

Fast optical footprints stretch along the snapshot velocity by at most 2×. This bridges close samples in a jet without changing particle positions, collision radii, or water accounting. A conservative world-space solid mask rejects footprints and smoothing samples across walls, including when the camera zooms out. Its one-byte texels are capped at 4096 per axis. All added textures and render targets are released on close.

The 3D field adds 0.42 cells of visual padding around the solver domain so a falling particle's optical footprint is not cut flat at the board edge. This padding does not extend the physical simulation or change discharge accounting.

The water composites at 58% opacity against a lightly etched backing, with shallow optical refraction of that backing, depth tint and a restrained reflection. The backing remains visible through pools. The coverage field is only an optical surface estimate, not a measurement of water volume. Transmission, reflection, and meniscus lighting are visual approximations. The subtle moving light band uses accepted simulation time and is gated by local velocity; pause freezes it along with the fluid. No independent animation clock is introduced.

## Verification

Focused solver tests cover actual nozzle admission, settled pool height, free fall, solid-wall pooling, uphill return flow, real outlet discharge, reset, finite state and exact particle-area accounting. Runtime clock tests cover slow frames, bounded completion pumping, displayed-state alignment, pause, visibility, supply and stale restart messages. Layout tests cover masks, asymmetric closed walls and a 150×150 allocation limit. The browser suite covers deliberately throttled rendering, both views, state preservation across mode switches, camera interaction, Worker lifecycle, actual wetting, outlet flow, pause pixel identity, inlet-off behaviour, restart and mobile controls. GPU wall-field tests check crossings in both directions, open passages, and negative world coordinates. Independent legacy optical/atlas math tests remain available without assuming that the dialog loads the old renderer.
