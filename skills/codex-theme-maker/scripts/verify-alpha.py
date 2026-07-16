#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


def inspect(path: Path, corner_max: int) -> dict[str, Any]:
    result: dict[str, Any] = {"path": str(path), "errors": [], "warnings": []}
    try:
        with Image.open(path) as source:
            image = source.convert("RGBA")
    except Exception as error:
        result["errors"].append(f"cannot read image: {error}")
        result["ok"] = False
        return result

    alpha = image.getchannel("A")
    width, height = image.size
    corners = {
        "top_left": alpha.getpixel((0, 0)),
        "top_right": alpha.getpixel((width - 1, 0)),
        "bottom_left": alpha.getpixel((0, height - 1)),
        "bottom_right": alpha.getpixel((width - 1, height - 1)),
    }
    histogram = alpha.histogram()
    transparent = sum(histogram[:1])
    partial = sum(histogram[1:255])
    opaque = histogram[255]
    bbox = alpha.getbbox()

    result.update({
        "size": [width, height],
        "mode": "RGBA",
        "corners": corners,
        "bbox": list(bbox) if bbox else None,
        "transparentPixels": transparent,
        "partiallyTransparentPixels": partial,
        "opaquePixels": opaque,
    })

    if bbox is None:
        result["errors"].append("alpha channel contains no visible subject")
    if transparent == 0:
        result["errors"].append("alpha channel has no fully transparent pixels")
    bad_corners = [name for name, value in corners.items() if value > corner_max]
    if bad_corners:
        result["errors"].append(f"corners are not transparent enough: {', '.join(bad_corners)}")
    if partial == 0:
        result["warnings"].append("alpha has no partially transparent edge pixels; inspect for jagged edges")
    if bbox and (bbox[0] == 0 or bbox[1] == 0 or bbox[2] == width or bbox[3] == height):
        result["warnings"].append("subject touches at least one canvas edge; inspect clipping at render size")

    result["ok"] = not result["errors"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate alpha-channel theme assets.")
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--corner-max", type=int, default=8, help="Maximum accepted corner alpha (default: 8)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = [inspect(path.resolve(), args.corner_max) for path in args.files]
    ok = all(item["ok"] for item in results)
    output = {"ok": ok, "results": results}
    if args.json:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        for item in results:
            print(f"{'PASS' if item['ok'] else 'FAIL'} {item['path']}")
            for error in item["errors"]:
                print(f"  ERROR: {error}")
            for warning in item["warnings"]:
                print(f"  WARN: {warning}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
