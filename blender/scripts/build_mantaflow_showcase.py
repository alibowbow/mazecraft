#!/usr/bin/env python3
"""Build a cinematic Blender liquid scene from a MazeCraft project."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

import bpy
from mathutils import Vector

CELL = 1.0
WALL_THICKNESS = 0.14
WALL_HEIGHT = 0.72


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--resolution", type=int, default=128)
    parser.add_argument("--frames", type=int, default=180)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bake", action="store_true")
    parser.add_argument("--render", action="store_true")
    return parser.parse_args(argv)


def load_project(path: Path) -> dict[str, Any]:
    project = json.loads(path.read_text(encoding="utf-8"))
    graph = project.get("mazeGraph")
    if not isinstance(graph, dict):
        raise ValueError("project.mazeGraph is required")
    rows, cols, cells = graph.get("rows"), graph.get("cols"), graph.get("cells")
    if not isinstance(rows, int) or not isinstance(cols, int) or rows < 1 or cols < 1:
        raise ValueError("mazeGraph rows/cols are invalid")
    if not isinstance(cells, list) or len(cells) != rows * cols:
        raise ValueError("mazeGraph.cells must contain rows * cols cells")
    return project


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def box(
    name: str,
    location: tuple[float, float, float],
    size: tuple[float, float, float],
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    if obj is None:
        raise RuntimeError("failed to add cube")
    obj.name = name
    obj.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new(name="Rounded edges", type="BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    return obj


def material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    metallic: float = 0.0,
) -> bpy.types.Material:
    value = bpy.data.materials.new(name=name)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return value


def water_material() -> bpy.types.Material:
    value = material("Cinematic Water", (0.006, 0.2, 0.34, 1.0), 0.08)
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["IOR"].default_value = 1.333
        transmission = bsdf.inputs.get("Transmission Weight") or bsdf.inputs.get(
            "Transmission"
        )
        if transmission:
            transmission.default_value = 0.82
        coat = bsdf.inputs.get("Coat Weight")
        if coat:
            coat.default_value = 0.35
    return value


def cell_xy(rows: int, cols: int, row: int, col: int) -> tuple[float, float]:
    return (
        (col - (cols - 1) * 0.5) * CELL,
        ((rows - 1) * 0.5 - row) * CELL,
    )


def active_cells(graph: dict[str, Any]) -> Iterable[dict[str, Any]]:
    return (
        cell
        for cell in graph["cells"]
        if isinstance(cell, dict) and cell.get("active")
    )


def endpoint(project: dict[str, Any], key: str) -> tuple[int, int]:
    value = project.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"project.{key} is required")
    return int(value["row"]), int(value["col"])


def visual_opening(
    rows: int,
    cols: int,
    row: int,
    col: int,
    prefer_top: bool,
) -> str | None:
    candidates = (
        ("top", "left", "right", "bottom")
        if prefer_top
        else ("bottom", "right", "left", "top")
    )
    for direction in candidates:
        if direction == "top" and row == 0:
            return direction
        if direction == "bottom" and row == rows - 1:
            return direction
        if direction == "left" and col == 0:
            return direction
        if direction == "right" and col == cols - 1:
            return direction
    return None


def effector(obj: bpy.types.Object) -> None:
    modifier = obj.modifiers.new(name="Fluid Effector", type="FLUID")
    modifier.fluid_type = "EFFECTOR"
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()
    settings = modifier.effector_settings
    if settings and hasattr(settings, "surface_distance"):
        settings.surface_distance = 0.0015


def flow(obj: bpy.types.Object, behavior: str) -> None:
    modifier = obj.modifiers.new(name=f"Liquid {behavior.title()}", type="FLUID")
    modifier.fluid_type = "FLOW"
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()
    settings = modifier.flow_settings
    if not settings:
        raise RuntimeError("flow settings were not created")
    settings.flow_type = "LIQUID"
    settings.flow_behavior = behavior
    if hasattr(settings, "use_plane_init"):
        settings.use_plane_init = False
    if hasattr(settings, "surface_distance"):
        settings.surface_distance = 1.5


def build_maze(project: dict[str, Any]) -> None:
    graph = project["mazeGraph"]
    rows, cols = graph["rows"], graph["cols"]
    board_mat = material("Warm Porcelain", (0.92, 0.93, 0.9, 1.0), 0.25)
    wall_mat = material("Orange Walls", (1.0, 0.12, 0.01, 1.0), 0.18)
    board = box(
        "Maze Board",
        (0, 0, -0.1),
        (cols + 0.9, rows + 0.9, 0.2),
        0.08,
    )
    board.data.materials.append(board_mat)
    effector(board)

    start_row, start_col = endpoint(project, "startCell")
    end_row, end_col = endpoint(project, "endCell")
    openings = {
        (
            start_row,
            start_col,
            visual_opening(rows, cols, start_row, start_col, True),
        ),
        (
            end_row,
            end_col,
            visual_opening(rows, cols, end_row, end_col, False),
        ),
    }
    seen: set[tuple[str, int, int]] = set()
    for cell in active_cells(graph):
        row, col = int(cell["row"]), int(cell["col"])
        x, y = cell_xy(rows, cols, row, col)
        walls = cell.get("walls", {})
        specs = (
            (
                "top",
                (x, y + 0.5, WALL_HEIGHT / 2),
                (1.14, WALL_THICKNESS, WALL_HEIGHT),
                ("h", row, col),
            ),
            (
                "left",
                (x - 0.5, y, WALL_HEIGHT / 2),
                (WALL_THICKNESS, 1.14, WALL_HEIGHT),
                ("v", row, col),
            ),
            (
                "right",
                (x + 0.5, y, WALL_HEIGHT / 2),
                (WALL_THICKNESS, 1.14, WALL_HEIGHT),
                ("v", row, col + 1),
            ),
            (
                "bottom",
                (x, y - 0.5, WALL_HEIGHT / 2),
                (1.14, WALL_THICKNESS, WALL_HEIGHT),
                ("h", row + 1, col),
            ),
        )
        for direction, location, size, key in specs:
            if (row, col, direction) in openings:
                continue
            if not walls.get(direction, True) or key in seen:
                continue
            seen.add(key)
            wall = box(
                f"Wall {direction} {row}:{col}",
                location,
                size,
                0.035,
            )
            wall.data.materials.append(wall_mat)
            effector(wall)


def add_boundaries(project: dict[str, Any]) -> None:
    graph = project["mazeGraph"]
    rows, cols = graph["rows"], graph["cols"]
    sr, sc = endpoint(project, "startCell")
    er, ec = endpoint(project, "endCell")
    sx, sy = cell_xy(rows, cols, sr, sc)
    ex, ey = cell_xy(rows, cols, er, ec)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32,
        radius=0.18,
        depth=0.24,
        location=(sx, sy + 0.16, 1.12),
    )
    inlet = bpy.context.object
    if inlet is None:
        raise RuntimeError("failed to add inflow")
    inlet.name = "Liquid Inflow"
    flow(inlet, "INFLOW")
    outflow = box(
        "Liquid Outflow",
        (ex, ey - 0.42, 0.18),
        (0.52, 0.36, 0.64),
    )
    outflow.display_type = "WIRE"
    outflow.hide_render = True
    flow(outflow, "OUTFLOW")


def add_domain(
    project: dict[str, Any],
    cache: Path,
    resolution: int,
    frames: int,
) -> bpy.types.Object:
    graph = project["mazeGraph"]
    rows, cols = graph["rows"], graph["cols"]
    domain = box(
        "Liquid Domain",
        (0, 0.1, 1.2),
        (cols + 1.5, rows + 3.2, 2.7),
    )
    domain.display_type = "WIRE"
    modifier = domain.modifiers.new(name="Liquid Domain", type="FLUID")
    modifier.fluid_type = "DOMAIN"
    bpy.context.view_layer.objects.active = domain
    bpy.context.view_layer.update()
    settings = modifier.domain_settings
    if not settings:
        raise RuntimeError("domain settings were not created")
    settings.domain_type = "LIQUID"
    settings.resolution_max = max(32, min(512, resolution))
    settings.cache_type = "MODULAR"
    settings.cache_directory = str(cache)
    settings.cache_frame_start = 1
    settings.cache_frame_end = frames
    for name, value in (
        ("simulation_method", "APIC"),
        ("use_mesh", True),
        ("mesh_scale", 2),
        ("mesh_particle_radius", 1.4),
        ("use_spray_particles", True),
        ("use_foam_particles", True),
        ("use_bubble_particles", True),
    ):
        if hasattr(settings, name):
            setattr(settings, name, value)
    domain.data.materials.append(water_material())
    return domain


def camera_and_lights(project: dict[str, Any]) -> None:
    graph = project["mazeGraph"]
    rows, cols = graph["rows"], graph["cols"]
    bpy.ops.object.camera_add(
        location=(0, -rows * 0.18, max(rows, cols) * 1.55 + 4.0)
    )
    camera = bpy.context.object
    if camera is None:
        raise RuntimeError("failed to add camera")
    camera.data.lens = 52
    camera.rotation_euler = (
        Vector((0, 0, 0.2)) - camera.location
    ).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera
    for kind, location, energy, color, size in (
        (
            "Key",
            (-cols * 0.55, rows * 0.45, 8),
            1450,
            (1, 1, 1),
            max(rows, cols) * 0.8,
        ),
        (
            "Fill",
            (cols * 0.65, -rows * 0.4, 4.5),
            680,
            (0.22, 0.62, 1),
            max(rows, cols) * 0.65,
        ),
        (
            "Rim",
            (-cols * 0.5, -rows * 0.35, 3),
            520,
            (1, 0.32, 0.08),
            max(rows, cols) * 0.45,
        ),
    ):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = kind
        light.data.energy = energy
        light.data.color = color
        light.data.shape = "DISK"
        light.data.size = size


def setup_render(output: Path, frames: int, fps: int) -> None:
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = fps
    scene.render.resolution_x = 1080
    scene.render.resolution_y = 1920
    scene.render.resolution_percentage = 50
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output.parent / "frames" / "frame_")
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.world.color = (0.025, 0.035, 0.045)


def bake(domain: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    domain.select_set(True)
    bpy.context.view_layer.objects.active = domain
    for operator_name in ("bake_data", "bake_mesh", "bake_particles"):
        operator = getattr(bpy.ops.fluid, operator_name, None)
        if operator is None:
            continue
        result = operator()
        if "FINISHED" not in result:
            raise RuntimeError(f"{operator_name} did not finish: {result}")


def main() -> None:
    options = args()
    if not 32 <= options.resolution <= 512:
        raise ValueError("resolution must be in [32, 512]")
    project = load_project(options.project.resolve())
    output = options.output.resolve()
    cache = options.cache.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    clear_scene()
    build_maze(project)
    add_boundaries(project)
    domain = add_domain(project, cache, options.resolution, options.frames)
    camera_and_lights(project)
    setup_render(output, options.frames, options.fps)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    if options.bake:
        bake(domain)
        bpy.ops.wm.save_as_mainfile(filepath=str(output))
    if options.render:
        bpy.ops.render.render(animation=True)
    print(f"Saved cinematic Mantaflow scene: {output}")


if __name__ == "__main__":
    main()
