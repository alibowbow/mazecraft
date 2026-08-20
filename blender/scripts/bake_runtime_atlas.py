#!/usr/bin/env python3
"""Bake MazeCraft's runtime water atlas with Blender.

RGBA contract:
R/G = signed local surface normal X/Y encoded into 0..1
B   = signed local surface height encoded into 0..1
A   = foam / breaking-wave mask
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import bpy

TAU = math.tau
TILES = (
    "straight",
    "corner",
    "tee",
    "cross",
    "dead_end",
    "source",
    "outlet",
    "pool",
)


@dataclass(frozen=True)
class Preset:
    tile_size: int
    frames: int
    frame_rate: float
    height_amplitude: float
    normal_strength: float
    foam_gain: float
    seed: int


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    t = clamp((value - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def normalize2(x: float, y: float) -> tuple[float, float]:
    length = math.hypot(x, y)
    return (0.0, -1.0) if length < 1e-8 else (x / length, y / length)


def hash_noise(x: float, y: float, phase: float, seed: int) -> float:
    value = math.sin(
        x * 127.1 + y * 311.7 + phase * 74.7 + (seed & 0xFFFF) * 0.00037
    ) * 43758.5453123
    return (value - math.floor(value)) * 2.0 - 1.0


def straight(x: float, y: float) -> tuple[float, float, float]:
    return 0.0, -1.0, clamp(math.exp(-pow(abs(x) * 1.2, 4.0)))


def corner(x: float, y: float) -> tuple[float, float, float]:
    dx, dy = x - 0.58, y - 0.58
    tx, ty = normalize2(dy, -dx)
    exit_bias = smoothstep(-0.05, 0.9, x) * smoothstep(-0.95, 0.3, y)
    fx = tx * (1.0 - exit_bias) + exit_bias
    fy = ty * (1.0 - exit_bias)
    return (*normalize2(fx, fy), clamp(0.3 + 0.7 * math.exp(-math.hypot(dx, dy))))


def tee(x: float, y: float) -> tuple[float, float, float]:
    branch = smoothstep(0.05, 0.85, -y)
    return (*normalize2(math.tanh(x * 3.2) * branch, -(1.0 - branch * 0.78)), 0.88)


def cross(x: float, y: float) -> tuple[float, float, float]:
    swirl = 0.26 * math.sin((x - y) * 2.4)
    return (*normalize2(math.tanh(x * 2.6) * 0.58 + swirl, -math.tanh(y * 2.6) * 0.58 - 0.55), 0.94)


def dead_end(x: float, y: float) -> tuple[float, float, float]:
    stop = smoothstep(0.2, -0.82, y)
    recirculation = smoothstep(-0.15, -0.85, y)
    return (*normalize2(math.sin(x * math.pi) * recirculation * 0.72, -(1.0 - stop) + recirculation * 0.18), 0.68)


def source(x: float, y: float) -> tuple[float, float, float]:
    radius = max(0.08, math.hypot(x, y))
    return (*normalize2(x / radius * 0.62, y / radius * 0.62 - smoothstep(-0.25, 0.8, y)), 1.0)


def outlet(x: float, y: float) -> tuple[float, float, float]:
    funnel = smoothstep(0.95, -0.15, y)
    return (*normalize2(-x * funnel * 0.88, -1.0), clamp(0.5 + funnel * 0.5))


def pool(x: float, y: float) -> tuple[float, float, float]:
    radius = max(0.1, math.hypot(x, y))
    return (*normalize2(-y / radius * 0.18, x / radius * 0.18 - 0.08), 0.2)


FIELDS: tuple[Callable[[float, float], tuple[float, float, float]], ...] = (
    straight,
    corner,
    tee,
    cross,
    dead_end,
    source,
    outlet,
    pool,
)


def surface(tile: int, x: float, y: float, phase: float, seed: int) -> tuple[float, float]:
    flow_x, flow_y, energy = FIELDS[tile](x, y)
    along = x * flow_x + y * flow_y
    across = -x * flow_y + y * flow_x
    broad = math.sin(along * 8.2 - phase * 1.55 + tile * 0.63)
    medium = math.sin(along * 17.4 - phase * 2.85 + across * 3.2)
    fine = math.sin(along * 31.0 - phase * 5.1 - across * 8.4)
    grain = hash_noise(x * 7.1, y * 7.1, phase, seed + tile * 977)

    if tile == 1:
        broad += smoothstep(0.1, 1.0, x - y * 0.25) * 0.76
    elif tile == 2:
        broad += math.exp(-x * x * 12.0) * math.sin(phase * 2.0 - y * 5.0) * 0.68
    elif tile == 3:
        broad += math.sin(x * 10.0 + phase) * math.sin(y * 9.0 - phase * 1.3) * 0.46
    elif tile == 4:
        broad += math.cos(y * 7.0 + phase * 1.2) * smoothstep(0.1, -0.92, y) * 0.82
    elif tile == 5:
        radius = math.hypot(x, y)
        broad += math.sin(radius * 17.5 - phase * 3.8) * math.exp(-radius * 1.9) * 1.25
    elif tile == 6:
        funnel = math.exp(-(x * x * 6.0 + (y + 0.62) ** 2 * 4.0))
        broad -= funnel * 1.15
        medium += funnel * math.sin(phase * 4.0 + x * 16.0)
    elif tile == 7:
        radius = math.hypot(x, y)
        broad = math.sin(radius * 9.0 - phase * 0.75) * 0.54
        medium *= 0.24
        fine *= 0.08
        grain *= 0.14

    height = (0.045 + energy * 0.085) * (
        broad * 0.58 + medium * 0.27 + fine * 0.095 + grain * 0.055
    )
    crest = smoothstep(0.34, 0.92, broad * 0.52 + medium * 0.31 + fine * 0.17)
    foam = crest * energy * 0.62
    edge = smoothstep(0.58, 0.98, max(abs(x), abs(y)))
    foam += smoothstep(0.15, 0.9, abs(across) * energy) * edge * 0.28

    if tile == 1:
        foam += smoothstep(0.2, 0.95, x) * smoothstep(-0.8, 0.6, -y) * 0.34
    elif tile == 2:
        foam += math.exp(-x * x * 13.0) * smoothstep(0.7, -0.35, y) * 0.4
    elif tile == 3:
        foam += math.exp(-(x * x + y * y) * 5.5) * 0.48
    elif tile == 4:
        foam += smoothstep(-0.15, -0.92, y) * 0.4
    elif tile == 5:
        radius = math.hypot(x, y)
        foam += math.exp(-radius * radius * 7.5) * 0.78
        foam += math.exp(-((radius - 0.5) ** 2) * 45.0) * 0.32
    elif tile == 6:
        foam += math.exp(-(x * x * 8.0 + (y + 0.7) ** 2 * 10.0)) * 0.66
    elif tile == 7:
        foam *= 0.12

    return height, clamp(foam)


def load_preset(path: Path) -> Preset:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != 1:
        raise ValueError("preset schemaVersion must be 1")
    preset = Preset(
        tile_size=int(raw["tileSize"]),
        frames=int(raw["frames"]),
        frame_rate=float(raw["frameRate"]),
        height_amplitude=float(raw["heightAmplitude"]),
        normal_strength=float(raw["normalStrength"]),
        foam_gain=float(raw["foamGain"]),
        seed=int(raw["seed"]),
    )
    if not 16 <= preset.tile_size <= 256 or not 4 <= preset.frames <= 32:
        raise ValueError("preset tileSize/frames are outside supported bounds")
    return preset


def make_atlas(preset: Preset) -> tuple[int, int, array, array]:
    width = preset.tile_size * preset.frames
    height = preset.tile_size * len(TILES)
    pixels = array("f", [0.0]) * (width * height * 4)
    preview = array("f", [0.0]) * (width * height * 4)
    epsilon = 2.0 / max(2, preset.tile_size - 1)

    for tile in range(len(TILES)):
        for frame in range(preset.frames):
            phase = TAU * frame / preset.frames
            for py in range(preset.tile_size):
                y = (py + 0.5) / preset.tile_size * 2.0 - 1.0
                atlas_y = tile * preset.tile_size + py
                for px in range(preset.tile_size):
                    x = (px + 0.5) / preset.tile_size * 2.0 - 1.0
                    h, foam = surface(tile, x, y, phase, preset.seed)
                    hx = surface(tile, x + epsilon, y, phase, preset.seed)[0]
                    hy = surface(tile, x, y + epsilon, phase, preset.seed)[0]
                    nx = -(hx - h) / epsilon * preset.normal_strength
                    ny = -(hy - h) / epsilon * preset.normal_strength
                    length = math.sqrt(nx * nx + ny * ny + 1.0)
                    nx /= length
                    ny /= length
                    encoded_h = clamp(0.5 + h / preset.height_amplitude * 0.5)
                    encoded_foam = clamp(foam * preset.foam_gain)
                    atlas_x = frame * preset.tile_size + px
                    offset = (atlas_y * width + atlas_x) * 4
                    pixels[offset : offset + 4] = array(
                        "f", (nx * 0.5 + 0.5, ny * 0.5 + 0.5, encoded_h, encoded_foam)
                    )
                    depth = clamp(0.34 + encoded_h * 0.66)
                    shallow = (0.05, 0.72, 0.82)
                    deep = (0.005, 0.16, 0.38)
                    light = clamp(0.72 + nx * 0.18 - ny * 0.12)
                    preview[offset] = clamp((shallow[0] * (1-depth) + deep[0] * depth) * light + encoded_foam * 0.76)
                    preview[offset+1] = clamp((shallow[1] * (1-depth) + deep[1] * depth) * light + encoded_foam * 0.86)
                    preview[offset+2] = clamp((shallow[2] * (1-depth) + deep[2] * depth) * light + encoded_foam * 0.9)
                    preview[offset+3] = 1.0
    return width, height, pixels, preview


def save_image(path: Path, width: int, height: int, pixels: array, name: str) -> None:
    image = bpy.data.images.new(name=name, width=width, height=height, alpha=True, float_buffer=False)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()


def write_manifest(output: Path, preset: Preset, width: int, height: int) -> None:
    manifest = {
        "schemaVersion": 1,
        "generator": {"name": "Blender", "version": bpy.app.version_string, "mode": "procedural-runtime-atlas"},
        "atlas": {
            "file": "surface-atlas.png", "width": width, "height": height,
            "tileSize": preset.tile_size, "frames": preset.frames,
            "rows": len(TILES), "frameRate": preset.frame_rate,
            "colorSpace": "linear",
        },
        "runtime": {"heightStrength": 0.038, "normalStrength": 0.34, "foamStrength": 0.86},
        "channels": {"r": "normalX", "g": "normalY", "b": "height", "a": "foam"},
        "tiles": [{"name": name, "row": row} for row, name in enumerate(TILES)],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    preset = load_preset(args.preset.resolve())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    width, height, pixels, preview = make_atlas(preset)
    save_image(output / "surface-atlas.png", width, height, pixels, "MazeCraft Water Atlas")
    save_image(output / "surface-preview.png", width, height, preview, "MazeCraft Water Preview")
    write_manifest(output, preset, width, height)
    print(f"Baked Blender water atlas {width}x{height}: {preset.frames} frames × {len(TILES)} tiles")


if __name__ == "__main__":
    main()
