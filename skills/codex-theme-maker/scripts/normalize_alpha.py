#!/usr/bin/env python3
"""Normalize a transparent PNG before strict gpt-image-2 verification."""

import argparse
import json
from pathlib import Path

from PIL import Image


def normalize(source: Path, output: Path, alpha_floor: int, padding: int) -> dict:
    image = Image.open(source).convert("RGBA")
    original_size = image.size
    alpha = image.getchannel("A").point(lambda value: 0 if value < alpha_floor else value)
    image.putalpha(alpha)

    # Fully transparent pixels must also have zero RGB or later compositing can
    # reveal matte-colored fringes.
    binary_alpha = alpha.point(lambda value: 255 if value else 0)
    image = Image.composite(
        image,
        Image.new("RGBA", image.size, (0, 0, 0, 0)),
        binary_alpha,
    )

    bbox = image.getbbox()
    if not bbox:
        raise SystemExit(f"empty alpha after normalization: {source}")
    image = image.crop(bbox)
    canvas = Image.new(
        "RGBA",
        (image.width + padding * 2, image.height + padding * 2),
        (0, 0, 0, 0),
    )
    canvas.paste(image, (padding, padding))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, "PNG")
    return {
        "source": str(source),
        "output": str(output),
        "original_size": list(original_size),
        "content_bbox": list(bbox),
        "normalized_size": list(canvas.size),
        "alpha_floor": alpha_floor,
        "padding": padding,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--alpha-floor", type=int, default=16)
    parser.add_argument("--padding", type=int, default=16)
    args = parser.parse_args()
    output = args.output or args.input
    report = normalize(args.input, output, args.alpha_floor, args.padding)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()

