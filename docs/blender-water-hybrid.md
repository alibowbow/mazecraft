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
