Original prompt: mazecraft저장소 물입자가 너무 많이 쌓여야 물이 넘쳐, 물그래픽이 리얼하지 않아 리얼한 그래픽을 구현하는 기법과 현재의 물리엔진을 조합해보자

- Working branch: codex/water-volume-optics, based on main.
- Investigating freeSurface solver density/particle area mismatch and particle-shaped density shading.
- Preserve fixed-step integration, conservative accounting, Worker lifecycle and wall collision.
- References: Macklin/Müller Position Based Fluids; NVIDIA GPU Gems 2 chapter 19 (Fresnel/refraction).
- Implemented area-normalized compression constraints and approximate wall kernel support. Return-passage first discharge improves from 210 to 189 particles at unchanged radius/inflow.
- Added wall-masked density splats, two smoothing passes, world-space normals, bounded absorption, Fresnel/environment reflection, plate refraction and contour aeration.
- Visual inspection removed excessive individual-particle highlights inside pools. Deterministic preview fixture supports the web-game client.
- Final checks: production build passed; all 190 unit tests across 34 files passed; all 4 focused browser tests passed (desktop, high-quality optics/pan/zoom/resize, mobile). No captured browser errors.
- Ran the prescribed web-game Playwright client for high and low quality; both report identical simulation state and 8 draw calls. Inspected the deterministic pool/overflow preview and production desktop/mobile screenshots.
- Remaining limitation: this is a 2D cross-section with approximate optical depth/environment lighting, not full 3D refraction. The 10% first-discharge reduction is specific to the regression fixture. No required implementation work remains.
