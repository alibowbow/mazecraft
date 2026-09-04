# Blender-baked water hybrid

MazeCraft keeps the Worker hydraulic network authoritative for volume, depth,
signed discharge, backflow, source/outlet boundaries, wetting and mass
conservation. Blender contributes only sub-cell surface detail.

## Runtime atlas

Eight canonical Blender rows cover every local topology: straight, corner,
tee, cross, dead end, source impact, outlet drawdown and calm pool. Columns are
animation frames. RGBA packs normal X, normal Y, local height and foam.

At runtime the water shader reads the existing topology atlas, classifies each
cell, rotates the canonical tile and interpolates neighboring Blender frames.
The contribution is gated by live hydraulic depth and velocity. Dry cells and
closed walls remain controlled by the original solver/topology mask.

The atlas is loaded asynchronously from `public/water-baked/`; a neutral
one-pixel texture keeps old deployments and standalone files functional when
assets are absent. No external API is introduced.

## Cinematic path

`blender/scripts/build_mantaflow_showcase.py` converts a selected `.mazecraft`
project into a real liquid domain with wall effectors, inflow and outflow. This
path is for vertical showcase footage because a Mantaflow mesh is tied to one
maze and cannot react instantly to wall edits.

## Automation

`.github/workflows/bake-blender-water.yml` pins Blender 4.5.12 LTS, generates
the runtime atlas, validates PNG/manifest dimensions, runs TypeScript tests and
build, then commits changed generated assets back to the feature branch.

## Flow-coupled atlas correction

The runtime atlas is **procedural**, not sampled from Mantaflow. Its generator
now also runs with standard Python when Blender is unavailable, with the actual
writer recorded in the manifest. The separate cinematic path remains Mantaflow.

- Normal vectors rotate back out of canonical tile coordinates with the tile.
- Per-cell signed hydraulic displacement drives atlas phase; a speed change does
  not multiply absolute time. Pause freezes it, reversal retraces it, dry cells
  and restart reset it. Source/outlet radial detail uses accumulated distance.
- Atlas height, normal and new foam contributions go to zero at zero flow. The
  existing hydraulic foam history still handles residual foam independently.
- All temporal harmonics and noise are periodic with continuous seam slopes.
  Tile borders fade to neutral to avoid seams between independently phased cells.
- Phase textures are owned and disposed by the water material. Physics, mass
  accounting, and Worker messages are unchanged.

This is still a canonical-tile approximation: branched junctions use projected
travel and do not resolve every incoming jet or a full 3D vortex.

Portable generation and continuity check:

```bash
python blender/scripts/test_runtime_atlas.py
python blender/scripts/bake_runtime_atlas.py --preset blender/presets/preview.json --output public/water-baked
python blender/scripts/validate_runtime_atlas.py public/water-baked
```
