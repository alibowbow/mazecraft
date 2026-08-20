#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, struct
from pathlib import Path
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
EXPECTED_TILES = ("straight","corner","tee","cross","dead_end","source","outlet","pool")

def read_png_ihdr(path: Path) -> tuple[int,int,int,int]:
    with path.open("rb") as f:
        if f.read(8) != PNG_SIGNATURE:
            raise ValueError(f"{path} is not PNG")
        length = struct.unpack(">I", f.read(4))[0]
        if f.read(4) != b"IHDR" or length != 13:
            raise ValueError(f"{path} has invalid IHDR")
        payload = f.read(13)
    w,h,bit_depth,color_type = struct.unpack(">IIBB", payload[:10])
    return w,h,bit_depth,color_type

def number(obj: dict[str,Any], key: str, minimum: float) -> float:
    value = obj.get(key)
    if isinstance(value,bool) or not isinstance(value,(int,float)) or value < minimum:
        raise ValueError(f"{key} must be >= {minimum}")
    return float(value)

def validate(root: Path) -> None:
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    atlas = manifest.get("atlas")
    if not isinstance(atlas,dict):
        raise ValueError("atlas must be an object")
    frames = int(number(atlas,"frames",1)); rows = int(number(atlas,"rows",1))
    tile_size = int(number(atlas,"tileSize",8)); width = int(number(atlas,"width",8)); height = int(number(atlas,"height",8))
    if width != frames * tile_size or height != rows * tile_size:
        raise ValueError("atlas dimensions do not match frames/rows/tileSize")
    if rows != len(EXPECTED_TILES):
        raise ValueError("atlas must contain eight tile rows")
    file_name = atlas.get("file")
    if not isinstance(file_name,str) or not file_name:
        raise ValueError("atlas.file is required")
    image_path = root / file_name
    png_w,png_h,bit_depth,color_type = read_png_ihdr(image_path)
    if (png_w,png_h) != (width,height):
        raise ValueError("PNG dimensions do not match manifest")
    if bit_depth != 8 or color_type != 6:
        raise ValueError("runtime atlas must be 8-bit RGBA")
    tiles = manifest.get("tiles")
    if not isinstance(tiles,list) or len(tiles) != len(EXPECTED_TILES):
        raise ValueError("tiles must contain eight rows")
    names = tuple(t.get("name") for t in tiles if isinstance(t,dict))
    row_values = tuple(t.get("row") for t in tiles if isinstance(t,dict))
    if names != EXPECTED_TILES or row_values != tuple(range(8)):
        raise ValueError("tile order/rows are invalid")
    if manifest.get("channels") != {"r":"normalX","g":"normalY","b":"height","a":"foam"}:
        raise ValueError("channel contract mismatch")
    print(f"Validated Blender water atlas {width}x{height}: {frames} frames × {rows} rows")

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("root",type=Path)
    validate(parser.parse_args().root.resolve())

if __name__ == "__main__": main()
