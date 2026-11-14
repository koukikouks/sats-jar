"""Shrink the landing page's PNGs (app/landing/assets) in place: resize to twice their largest
on-screen size, then reduce to a 256-colour palette (the crayon art survives it with no visible
change).

Run after make_art.py, which writes the full-size art:
    python app/art-src/optimize_assets.py
Needs Pillow. Running it twice is harmless: images already at or below their width are only
re-quantized.
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "landing" / "assets"

# name pattern -> widest it needs to be (2x its largest CSS width on the landing page)
WIDTHS = {
    "coin-*.png": 220,        # pile coins ~110px, logo 44px
    "figure-*.png": 400,      # hero card figure ~230px
    "patch-*.png": 520,       # hero card fill ~260px
    "frame-*.png": 640,       # hero card ~260px, and the step cards up to ~460px wide
    "jar.png": 680,           # hero jar ~350px
    "step-*.png": 520,        # step art ~70% of a step card
    "underline-*.png": 1200,  # hero underline, full word width
    "swatch-*.png": 600,      # lilac swatch 300px; yellow behind small labels
    "doodle-*.png": 240,      # hero doodles ~60px
    "grain.png": 512,         # lettering mask, tiled at 256px
}


def optimize(path: Path, width: int) -> tuple[int, int]:
    before = path.stat().st_size
    im = Image.open(path).convert("RGBA")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im = im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
    im.save(path, "PNG", optimize=True)
    return before, path.stat().st_size


if __name__ == "__main__":
    total_before = total_after = 0
    for pattern, width in WIDTHS.items():
        for path in sorted(ASSETS.glob(pattern)):
            before, after = optimize(path, width)
            total_before += before
            total_after += after
            print(f"{path.name:28} {before // 1024:5} KB -> {after // 1024:4} KB")
    print(f"{'total':28} {total_before // 1024:5} KB -> {total_after // 1024:4} KB")
