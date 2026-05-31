#!/usr/bin/env python3
"""Build Chrome extension icons.

Default mode renders extension/icons/source.svg into the PNG sizes required by
the extension. This intentionally uses only the Python standard library. The
renderer supports the SVG subset used by the bundled source file: rounded
rectangles, filled paths, and stroked paths.

For custom PNG artwork, export the required icon*.png files yourself and run:

    python scripts/build_icons.py --ico-only
"""

from __future__ import annotations

import argparse
import math
import re
import struct
import sys
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension" / "icons" / "source.svg"
OUT_DIR = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 64, 128, 256)
REQUIRED_PNG_SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4


def parse_color(value: str) -> tuple[int, int, int, int]:
    value = (value or "").strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError(f"unsupported color: {value!r}")
    return (
        int(value[1:3], 16),
        int(value[3:5], 16),
        int(value[5:7], 16),
        255,
    )


def blend_over(dst: tuple[int, int, int, int], src: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0:
        return (0, 0, 0, 0)
    out = []
    for i in range(3):
        out_c = (src[i] * sa + dst[i] * da * (1.0 - sa)) / out_a
        out.append(int(round(out_c)))
    out.append(int(round(out_a * 255)))
    return tuple(out)  # type: ignore[return-value]


def rounded_rect_contains(x: float, y: float, rx: float, ry: float, w: float, h: float, r: float) -> bool:
    if x < rx or y < ry or x > rx + w or y > ry + h:
        return False
    cx = min(max(x, rx + r), rx + w - r)
    cy = min(max(y, ry + r), ry + h - r)
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r + 1e-9


def tokenize_path(data: str) -> list[str]:
    return re.findall(r"[MmLlHhVvZz]|-?\d+(?:\.\d+)?", data)


def path_to_polygons(data: str) -> list[list[tuple[float, float]]]:
    tokens = tokenize_path(data)
    polygons: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    x = y = 0.0
    start = (0.0, 0.0)
    i = 0
    cmd = ""

    def close_current() -> None:
        nonlocal current
        if current:
            if current[-1] != current[0]:
                current.append(current[0])
            polygons.append(current)
            current = []

    while i < len(tokens):
        if re.fullmatch(r"[A-Za-z]", tokens[i]):
            cmd = tokens[i]
            i += 1

        if cmd in ("M", "m"):
            if i + 1 >= len(tokens):
                break
            if current:
                close_current()
            nx, ny = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cmd == "m":
                x += nx
                y += ny
            else:
                x, y = nx, ny
            start = (x, y)
            current.append((x, y))
            cmd = "l" if cmd == "m" else "L"
        elif cmd in ("L", "l"):
            if i + 1 >= len(tokens):
                break
            nx, ny = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cmd == "l":
                x += nx
                y += ny
            else:
                x, y = nx, ny
            current.append((x, y))
        elif cmd in ("H", "h"):
            nx = float(tokens[i])
            i += 1
            x = x + nx if cmd == "h" else nx
            current.append((x, y))
        elif cmd in ("V", "v"):
            ny = float(tokens[i])
            i += 1
            y = y + ny if cmd == "v" else ny
            current.append((x, y))
        elif cmd in ("Z", "z"):
            x, y = start
            close_current()
            cmd = ""
        else:
            raise ValueError(f"unsupported path command: {cmd!r}")

    close_current()
    return polygons


def point_in_poly(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i, pi in enumerate(poly):
        xi, yi = pi
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < cross:
                inside = not inside
        j = i
    return inside


def evenodd_contains(x: float, y: float, polygons: list[list[tuple[float, float]]]) -> bool:
    return sum(1 for poly in polygons if point_in_poly(x, y, poly)) % 2 == 1


def dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx = ax + t * dx
    cy = ay + t * dy
    return math.hypot(px - cx, py - cy)


def stroke_contains(x: float, y: float, points: list[tuple[float, float]], width: float) -> bool:
    radius = width / 2.0
    for a, b in zip(points, points[1:]):
        if dist_to_segment(x, y, a[0], a[1], b[0], b[1]) <= radius:
            return True
    return any(math.hypot(x - px, y - py) <= radius for px, py in points)


def render(size: int, elements: list[dict[str, object]]) -> list[tuple[int, int, int, int]]:
    scale = size / 128.0
    pixels: list[tuple[int, int, int, int]] = []
    samples = SUPERSAMPLE * SUPERSAMPLE

    for py in range(size):
        for px in range(size):
            accum = [0, 0, 0, 0]
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px + (sx + 0.5) / SUPERSAMPLE) / scale
                    y = (py + (sy + 0.5) / SUPERSAMPLE) / scale
                    color = (0, 0, 0, 0)
                    for element in elements:
                        kind = element["kind"]
                        if kind == "rect":
                            if rounded_rect_contains(x, y, element["x"], element["y"], element["w"], element["h"], element["rx"]):  # type: ignore[arg-type]
                                color = blend_over(color, element["fill"])  # type: ignore[arg-type]
                        elif kind == "path_fill":
                            if evenodd_contains(x, y, element["polygons"]):  # type: ignore[arg-type]
                                color = blend_over(color, element["fill"])  # type: ignore[arg-type]
                        elif kind == "path_stroke":
                            if stroke_contains(x, y, element["points"], element["width"]):  # type: ignore[arg-type]
                                color = blend_over(color, element["stroke"])  # type: ignore[arg-type]
                    for i in range(4):
                        accum[i] += color[i]
            pixels.append(tuple(v // samples for v in accum))  # type: ignore[arg-type]

    return pixels


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def get_png_bytes(size: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    rows = []
    for y in range(size):
        row = bytearray([0])
        for rgba in pixels[y * size:(y + 1) * size]:
            row.extend(rgba)
        rows.append(bytes(row))

    data = b"".join(rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(data, 9))
    png += png_chunk(b"IEND", b"")
    return png


def write_png(path: Path, size: int, pixels: list[tuple[int, int, int, int]]) -> None:
    png = get_png_bytes(size, pixels)
    path.write_bytes(png)


def write_ico(path: Path, png_data_list: list[tuple[int, bytes]]) -> None:
    header = struct.pack("<HHH", 0, 1, len(png_data_list))
    entries = []
    offset = 6 + 16 * len(png_data_list)
    for size, data in png_data_list:
        w = size if size < 256 else 0
        h = size if size < 256 else 0
        bytes_in_res = len(data)
        entry = struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, bytes_in_res, offset)
        entries.append(entry)
        offset += bytes_in_res

    with open(path, "wb") as f:
        f.write(header)
        for entry in entries:
            f.write(entry)
        for _, data in png_data_list:
            f.write(data)


def load_elements(source: Path) -> list[dict[str, object]]:
    if not source.exists():
        raise FileNotFoundError(source)
    if source.suffix.lower() != ".svg":
        raise ValueError(
            f"{source} is not an SVG file. This script does not resize arbitrary images. "
            "For PNG artwork, export icon16.png, icon32.png, icon48.png, and icon128.png, "
            "then run with --ico-only."
        )

    root = ET.fromstring(source.read_text(encoding="utf-8"))
    view_box = root.attrib.get("viewBox", "").strip()
    if view_box and view_box != "0 0 128 128":
        raise ValueError(f"unsupported SVG viewBox {view_box!r}; expected '0 0 128 128'")

    ns = "{http://www.w3.org/2000/svg}"
    elements: list[dict[str, object]] = []

    for child in list(root):
        tag = child.tag.removeprefix(ns)
        if tag == "rect":
            fill = parse_color(child.attrib.get("fill", "#000000"))
            elements.append({
                "kind": "rect",
                "x": float(child.attrib.get("x", "0")),
                "y": float(child.attrib.get("y", "0")),
                "w": float(child.attrib.get("width", "0")),
                "h": float(child.attrib.get("height", "0")),
                "rx": float(child.attrib.get("rx", "0")),
                "fill": fill,
            })
        elif tag == "path" and child.attrib.get("fill", "none") != "none":
            elements.append({
                "kind": "path_fill",
                "polygons": path_to_polygons(child.attrib["d"]),
                "fill": parse_color(child.attrib["fill"]),
            })
        elif tag == "path" and "stroke" in child.attrib:
            polygons = path_to_polygons(child.attrib["d"])
            points = [p for poly in polygons for p in poly]
            elements.append({
                "kind": "path_stroke",
                "points": points,
                "width": float(child.attrib.get("stroke-width", "1")),
                "stroke": parse_color(child.attrib["stroke"]),
            })
        else:
            raise ValueError(f"unsupported SVG element: {tag}")

    return elements


def read_png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError(f"{path} is not a valid PNG file")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def load_existing_pngs(out_dir: Path) -> list[tuple[int, bytes]]:
    missing = [f"icon{size}.png" for size in REQUIRED_PNG_SIZES if not (out_dir / f"icon{size}.png").exists()]
    if missing:
        raise FileNotFoundError(
            "missing required PNG icons: "
            + ", ".join(missing)
            + ". Export these files first, or run without --ico-only to render from source.svg."
        )

    png_data_list = []
    for size in SIZES:
        path = out_dir / f"icon{size}.png"
        if not path.exists():
            continue
        width, height = read_png_size(path)
        if width != size or height != size:
            raise ValueError(f"{path} is {width}x{height}; expected {size}x{size}")
        png_data_list.append((size, path.read_bytes()))
    return png_data_list


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build extension icon PNG/ICO files.")
    parser.add_argument(
        "--source",
        default=str(SOURCE),
        help="SVG source file to render. Default: extension/icons/source.svg",
    )
    parser.add_argument(
        "--ico-only",
        action="store_true",
        help="Build icon.ico from existing icon*.png files without rendering source.svg.",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.ico_only:
        png_data_list = load_existing_pngs(OUT_DIR)
        ico_path = OUT_DIR / "icon.ico"
        write_ico(ico_path, png_data_list)
        print(f"wrote {ico_path.relative_to(ROOT)}")
        return 0

    source = Path(args.source)
    if not source.is_absolute():
        source = ROOT / source
    elements = load_elements(source)
    png_data_list = []
    for size in SIZES:
        out = OUT_DIR / f"icon{size}.png"
        pixels = render(size, elements)
        png_bytes = get_png_bytes(size, pixels)
        out.write_bytes(png_bytes)
        print(f"wrote {out.relative_to(ROOT)}")
        png_data_list.append((size, png_bytes))

    ico_path = OUT_DIR / "icon.ico"
    write_ico(ico_path, png_data_list)
    print(f"wrote {ico_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
