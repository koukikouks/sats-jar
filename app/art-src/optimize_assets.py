"""Shrink the landing page's PNGs in place: resize to twice their largest on-screen size, then
reduce to a 256-colour palette (the crayon art survives it with no visible change).

Run after make_art.py, which writes the full-size art:
    python app/art-src/optimize_assets.py
Needs Pillow. Running it twice is harmless: images already at or below their width are only
re-quantized.
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# name pattern -> widest it needs to be (2x its largest CSS width on the landing page)
WIDTHS = {
    "coin-*.png": 220,       # pile coins ~100px, nav logo 40px, roadmap pin 36px
    "figure-*.png": 400,     # hero card figure ~200px
    "frame-*.png": 480,      # hero card frame ~230px
    "jar.png": 680,          # hero jar ~330px
    "step-*.png": 640,       # step art up to 280px (scaled to 70% on wide screens)
    "underline-*.png": 1200, # hero underline, full word width
    "eraser.png": 440,
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
