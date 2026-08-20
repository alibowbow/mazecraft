# MazeCraft Blender Water Pipeline

MazeCraft uses two deliberately separate Blender paths.

## 1. Runtime atlas

The browser's hydraulic solver remains authoritative for depth, discharge,
wetting, backflow and mass conservation. Blender supplies only sub-cell visual
detail: normal, local height and foam animation for eight canonical channel
shapes.

```bash
blender -b --factory-startup \
  --python blender/scripts/bake_runtime_atlas.py -- \
  --preset blender/presets/preview.json \
  --output public/water-baked

python blender/scripts/validate_runtime_atlas.py public/water-baked
```

The generated `surface-atlas.png` packs:

| Channel | Meaning |
| --- | --- |
| R | signed normal X, encoded to 0–1 |
| G | signed normal Y, encoded to 0–1 |
| B | signed local surface height, encoded to 0–1 |
| A | foam and breaking-wave mask |

Rows are `straight`, `corner`, `tee`, `cross`, `dead_end`, `source`,
`outlet`, and `pool`. Columns are animation frames. The runtime rotates each
canonical tile to match the real maze topology, then scales its contribution by
the hydraulic depth and velocity.

`preview.json` generates a 1024×512 atlas suitable for normal builds.
`production.json` generates a larger source atlas for hand-tuned releases.
The GitHub workflow pins Blender 4.5.12 LTS for deterministic output.

## 2. Mantaflow showcase

The Shorts-quality path creates a full liquid domain from a selected
`.mazecraft` project. This is an offline render, not a runtime game asset.

```bash
blender -b --factory-startup \
  --python blender/scripts/build_mantaflow_showcase.py -- \
  --project path/to/project.mazecraft \
  --output blender/output/showcase.blend \
  --cache blender/cache/showcase \
  --resolution 160 \
  --frames 240 \
  --save
```

Open the generated `.blend`, inspect the domain bounds and effectors, then run
the expensive bake with `--bake`. The scene enables a liquid mesh and, when the
installed Blender build exposes the options, spray, foam and bubble particles.
The production render is vertical 1080×1920 and uses EEVEE Next by default.
Cycles can be selected manually for final shots.

## Why there are two paths

A baked Mantaflow mesh is tied to one maze and one flow setup. It cannot respond
instantly when a player edits a wall. The runtime atlas preserves arbitrary
maze generation and mobile interaction, while the Mantaflow scene provides the
near-offline quality needed for trailers and Shorts.

## Generated files

`public/water-baked/` is generated. Do not hand-edit its PNG or manifest.
Change the Blender script or preset and run the bake workflow instead.
