#!/usr/bin/env python3
"""Render assets at their CSS target size and report optical alpha bounds."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def parse_size(value: str) -> tuple[int, int]:
    try:
        width, height = (int(part) for part in value.lower().split("x", 1))
    except ValueError as error:
        raise argparse.ArgumentTypeError("size must be WIDTHxHEIGHT") from error
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("size must be positive")
    return width, height


def threshold_bbox(alpha: Image.Image, floor: int):
    return alpha.point(lambda value: 255 if value >= floor else 0).getbbox()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cell", type=parse_size, default=(338, 256))
    parser.add_argument("--optical-floor", type=int, default=120)
    parser.add_argument("--gap", type=int, default=20)
    parser.add_argument("--fit", choices=("stretch", "contain"), default="stretch")
    args = parser.parse_args()

    cell_width, cell_height = args.cell
    label_height = 28
    sheet = Image.new(
        "RGBA",
        (
            len(args.images) * cell_width + max(0, len(args.images) - 1) * args.gap,
            cell_height + label_height,
        ),
        (224, 224, 220, 255),
    )
    draw = ImageDraw.Draw(sheet)
    report = []

    for index, path in enumerate(args.images):
        image = Image.open(path).convert("RGBA")
        alpha_bbox = image.getchannel("A").getbbox()
        optical_bbox = threshold_bbox(image.getchannel("A"), args.optical_floor)
        rendered = image.copy()
        if args.fit == "stretch":
            rendered = rendered.resize((cell_width, cell_height), Image.Resampling.LANCZOS)
            offset = (0, 0)
        else:
            rendered.thumbnail((cell_width, cell_height), Image.Resampling.LANCZOS)
            offset = ((cell_width - rendered.width) // 2, (cell_height - rendered.height) // 2)
        x = index * (cell_width + args.gap)
        sheet.alpha_composite(rendered, (x + offset[0], offset[1]))
        draw.rectangle((x, 0, x + cell_width - 1, cell_height - 1), outline=(70, 80, 88, 255), width=1)
        draw.text((x + 6, cell_height + 7), path.stem, fill=(25, 30, 35, 255))
        report.append(
            {
                "path": str(path),
                "size": list(image.size),
                "alpha_bbox": list(alpha_bbox) if alpha_bbox else None,
                "optical_bbox": list(optical_bbox) if optical_bbox else None,
                "optical_floor": args.optical_floor,
                "render_cell": [cell_width, cell_height],
                "fit": args.fit,
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(args.output, quality=92)
    print(json.dumps({"output": str(args.output), "assets": report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
