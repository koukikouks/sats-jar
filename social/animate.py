"""Short looping animations of three post cards, for X (10 s, 1600x900, H.264).

Each card from make_cards.py is rendered once as a base frame (its [data-layer] parts hidden) and
once per layer (that part alone on a clear background); the layers are then revealed over time.
Run from the repo root with a Python that has Pillow and NumPy:  python social/animate.py [name ...]
"""
import math, os, subprocess, sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_cards as mc  # noqa: E402

FPS, DUR = 24, 10.0
TMP = os.environ.get("CARD_TMP", "/tmp/sats-jar-cards")


def shot(html, png, clear=False):
    path = png[:-4] + ".html"
    open(path, "w").write(html)
    args = [mc.CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--window-size={mc.W},{mc.H}", "--virtual-time-budget=4000", "--allow-file-access-from-files",
            f"--screenshot={png}", "file://" + path]
    if clear:
        args.insert(1, "--default-background-color=00000000")
    subprocess.run(args, check=True, capture_output=True)
    return Image.open(png).convert("RGBA")


def render_layers(name, fn, layers):
    d = os.path.join(TMP, name); os.makedirs(d, exist_ok=True)
    mc.LAYER_CSS[0] = "[data-layer]{visibility:hidden!important}"
    base = shot(fn(), os.path.join(d, "base.png"))
    out = {}
    for L in layers:
        mc.LAYER_CSS[0] = (f"html,body{{background:transparent!important}} body *{{visibility:hidden!important}} "
                           f"[data-layer='{L}'],[data-layer='{L}'] *{{visibility:visible!important}}")
        out[L] = np.asarray(shot(fn(), os.path.join(d, f"{L}.png"), clear=True)).astype(np.float32) / 255
    mc.LAYER_CSS[0] = ""
    return np.asarray(base.convert("RGB")).astype(np.float32) / 255, out


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def over(dst, layer, alpha=1.0, mask=None):
    a = layer[..., 3:4] * alpha
    if mask is not None:
        a = a * mask[..., None]
    return dst * (1 - a) + layer[..., :3] * a


def scaled(layer, s):
    """The layer scaled by s about the centre of its visible pixels."""
    if abs(s - 1) < 1e-3:
        return layer
    ys, xs = np.nonzero(layer[..., 3] > 0.01)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
    crop = Image.fromarray((layer[y0:y1, x0:x1] * 255).astype(np.uint8), "RGBA")
    w, h = max(1, int((x1 - x0) * s)), max(1, int((y1 - y0) * s))
    crop = np.asarray(crop.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    out = np.zeros_like(layer)
    ty, tx = int(cy - h / 2), int(cx - w / 2)
    sy0, sx0 = max(0, -ty), max(0, -tx)
    ty, tx = max(0, ty), max(0, tx)
    hh, ww = min(h - sy0, out.shape[0] - ty), min(w - sx0, out.shape[1] - tx)
    out[ty:ty + hh, tx:tx + ww] = crop[sy0:sy0 + hh, sx0:sx0 + ww]
    return out


def pop(t):
    """Scale for a stamp landing: big and faint, then a small overshoot, then settled."""
    if t < 0: return None
    if t < .16: return 1.7 - .8 * ease(t / .16)
    if t < .3: return .9 + .1 * ease((t - .16) / .14)
    return 1.0


def encode(name, frames):
    out = os.path.join(mc.OUT, f"{name}.mp4")
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{mc.W}x{mc.H}",
                          "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "18", "-preset", "slow",
                          "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write((np.clip(f, 0, 1) * 255).astype(np.uint8).tobytes())
    p.stdin.close(); p.wait()
    print("wrote", out)


def fade_out(t):
    return 1 - ease((t - (DUR - .45)) / .45)


def anim_zero():
    base, L = render_layers("02-zero-keys", mc.card_zero, ["ring"])
    cx, cy = 450, 390
    yy, xx = np.mgrid[0:mc.H, 0:mc.W]
    ang = (np.arctan2(xx - cx, -(yy - cy)) % (2 * math.pi)) / (2 * math.pi)  # 0 at top, clockwise
    for i in range(int(FPS * DUR)):
        t = i / FPS
        p = ease((t - .5) / 1.5) * 1.08
        m = np.clip((p - ang) * 30, 0, 1)
        yield over(base, L["ring"], fade_out(t), m)


def anim_refusals():
    names = [f"s{i}" for i in range(3)] + [f"t{i}" for i in range(3)]
    base, L = render_layers("03-refusals", mc.card_refusals, names)
    for i in range(int(FPS * DUR)):
        t = i / FPS; f = base.copy(); fo = fade_out(t)
        for r in range(3):
            t0 = .9 + 2.0 * r
            s = pop(t - t0)
            if s is not None:
                f = over(f, scaled(L[f"s{r}"], s), min(1, (t - t0) / .1) * fo)
            f = over(f, L[f"t{r}"], ease((t - t0 - .3) / .35) * fo)
        yield f


def anim_roadmap():
    names = ["path", "cta"] + [f"p{i}" for i in range(3)] + [f"l{i}" for i in range(3)]
    base, L = render_layers("07-roadmap", mc.card_roadmap, names)
    xx = np.arange(mc.W)[None, :].repeat(mc.H, 0)
    pins_x = [200, 800, 1400]
    x_at = lambda t: 170 + 1260 * ease((t - .5) / 3.6) if t > .5 else 0
    t_pin = []
    for px in pins_x:  # when the drawn path reaches each pin
        t = .5
        while x_at(t) < px - 10 and t < DUR: t += 1 / FPS
        t_pin.append(t)
    for i in range(int(FPS * DUR)):
        t = i / FPS; fo = fade_out(t)
        f = over(base, L["path"], fo, np.clip((x_at(t) - xx) / 12, 0, 1))
        for k in range(3):
            s = pop(t - t_pin[k])
            if s is not None:
                f = over(f, scaled(L[f"p{k}"], s), min(1, (t - t_pin[k]) / .1) * fo)
            f = over(f, L[f"l{k}"], ease((t - t_pin[k] - .25) / .4) * fo)
        f = over(f, L["cta"], ease((t - t_pin[2] - 1.0) / .5) * fo)
        yield f


ANIMS = {"02-zero-keys-anim": anim_zero, "03-refusals-anim": anim_refusals, "07-roadmap-anim": anim_roadmap}

if __name__ == "__main__":
    for name, fn in ANIMS.items():
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        encode(name, fn())
