#!/usr/bin/env python3
"""Sats Jar story video, sketch version: crayon people, ten beats, three "boil" variants each.

    python3 video/make_story.py              # draw + render every beat, then assemble the MP4
    python3 video/make_story.py beat 4b      # re-draw one beat (and rebuild the MP4)
    python3 video/make_story.py draw         # only write the SVGs

Needs Google Chrome and ffmpeg. See video/script.md for the storyboard and voice-over.
Reuses the crayon drawing helpers and the stick figures from app/art-src.
"""
import math, os, random, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app", "art-src"))
import story_art as M  # noqa: E402  (stick figures, jar, coins)
from crayon_lib import *  # noqa: E402,F401,F403

W, H = 1920, 1080
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK = os.environ.get("STORY_WORK", "/private/tmp/claude-502/story")
FONT_CSS = open(os.path.join(HERE, "archivo-embed.css")).read()
INK, ORANGE, YELLOW, RED, PINK, BLUE, GREEN, LILAC = M.INK, M.ORANGE, M.YELLOW, M.RED, M.PINK, M.BLUE, M.GREEN, M.LILAC
PALE = {"y": ["#fff4d8", "#ffecbd"], "p": ["#fde4ec", "#fbd5e2"], "b": ["#e3edfb", "#d4e4f9"],
        "g": ["#e0f1e4", "#cfe9d6"], "l": ["#eee6f8", "#e3d8f3"], "w": ["#fffdf8", "#fbf6ea"]}
BROWN = M.BROWN
POPS = [ORANGE, PINK, BLUE, GREEN, YELLOW, RED, LILAC]


# ------------------------------------------------------------------ frame assembly
class Frame:
    """Layers drawn in order. 'art' layers get the crayon texture; 'raw' layers (text, white underlays) are crisp."""
    def __init__(self):
        self.layers = []

    def raw(self, svg):
        self.layers.append(("raw", svg, None))

    def art(self, svg, region=None):
        self.layers.append(("art", svg, region))

    def text(self, x, y, s, size=48, weight=800, fill="#141414", anchor="middle", opacity=1, rot=0):
        t = f' transform="rotate({rot} {x} {y})"' if rot else ""
        self.raw(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}" opacity="{opacity}"{t}>{s}</text>')


def doc(frame, v):
    defs, body = [], []
    n = 0
    for kind, svg, region in frame.layers:
        if kind == "raw":
            body.append(svg)
            continue
        n += 1
        x0, y0, x1, y1 = region or (0, 0, W, H)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        seed = 5 + v * 11 + n * 3
        defs.append(f'''<filter id="w{n}" filterUnits="userSpaceOnUse" x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}">
<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="{seed}" result="w"/>
<feDisplacementMap in="SourceGraphic" in2="w" scale="5" result="d"/>
<feTurbulence type="fractalNoise" baseFrequency="{0.30 + 0.02 * (n % 4)}" numOctaves="3" seed="{seed + 20}" result="g"/>
<feColorMatrix in="g" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4.2 0 0 0 -1.25" result="m"/>
<feComposite in="d" in2="m" operator="in"/></filter>''')
        body.append(f'<g filter="url(#w{n})" fill="none" stroke-linecap="round" stroke-linejoin="round">{svg}</g>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
            f'<defs><style>{FONT_CSS} text{{font-family:"ArchivoEmbed","Archivo",Arial,sans-serif}}</style>{"".join(defs)}</defs>'
            f'<rect width="{W}" height="{H}" fill="#fffdf9"/>{"".join(body)}</svg>')


# ------------------------------------------------------------------ small drawing helpers
def box(x0, y0, x1, y1, cols, ang=50, sp=16, w=14, outline=True, ow=7, amp=2.0):
    p = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    s = hatch_poly(p, rad(ang), sp, cols, w)
    if outline:
        s += brk_line(p + [p[0]], INK, ow, 2, amp=amp, dense=8, seg=(10, 22))
    return s


def poly(pts, cols, ang=50, sp=14, w=12, ow=7):
    return hatch_poly(pts, rad(ang), sp, cols, w) + brk_line(pts + [pts[0]], INK, ow, 2, amp=2.0, dense=8, seg=(10, 22))


def disc(cx, cy, r, cols, w=12, sp=13, ang=50, ow=7):
    return M.hatch_circle((cx, cy), r - 2, rad(ang), sp, cols, w) + ring((cx, cy), r, INK, ow, 2, 1.6)


def line(pts, cols=None, w=7, passes=2, amp=2.0):
    return brk_line(pts, cols or INK, w, passes, amp=amp, dense=8, seg=(10, 22))


def under(frame, svg_path_d, fill="#fffdf9"):
    frame.raw(f'<path d="{svg_path_d}" fill="{fill}"/>')


def rect_d(x0, y0, x1, y1, r=0):
    if not r:
        return f"M{x0} {y0} H{x1} V{y1} H{x0} Z"
    return (f"M{x0 + r} {y0} H{x1 - r} Q{x1} {y0} {x1} {y0 + r} V{y1 - r} Q{x1} {y1} {x1 - r} {y1} "
            f"H{x0 + r} Q{x0} {y1} {x0} {y1 - r} V{y0 + r} Q{x0} {y0} {x0 + r} {y0} Z")


def rr_pts(x0, y0, x1, y1, r):
    return rrect(x0, y0, x1, y1, r)


def hand(cx, foot, k, loc, squeeze=1.0, flip=False):
    """Canvas position of a point in a 300x380 stick-figure picture placed with M.place."""
    sx = -k if flip else k
    return (cx + (loc[0] - 150) * sx, foot - (346 - loc[1]) * k * squeeze)


def bubble(f, x0, y0, x1, y1, tail, lines, size=44):
    """Speech bubble: white underlay (so it hides what is behind), crayon outline, crisp text."""
    tx, ty = tail
    midx = (x0 + x1) / 2
    d = rect_d(x0, y0, x1, y1, 38)
    tri = f"M{midx - 30} {y1 - 2} L{tx} {ty} L{midx + 34} {y1 - 2} Z"
    f.raw(f'<path d="{d}" fill="#ffffff"/><path d="{tri}" fill="#ffffff"/>')
    pts = rr_pts(x0, y0, x1, y1, 38)
    f.art(line(pts + [pts[0]], INK, 7, 2, 1.6) + line([(midx - 30, y1), (tx, ty), (midx + 34, y1)], INK, 7, 1, 1.0),
          region=(x0 - 20, y0 - 20, max(x1, tx) + 20, max(y1, ty) + 20))
    n = len(lines)
    for i, t in enumerate(lines):
        f.text(midx, (y0 + y1) / 2 + (i - (n - 1) / 2) * (size * 1.2) + size * 0.34, t, size=size, weight=800)


def tag(f, x, y, s):
    """Chapter tag, top-left, with a crayon underline."""
    f.text(x, y, s, size=54, weight=800, anchor="start")
    wtxt = len(s) * 29
    f.art(line([(x, y + 18), (x + wtxt * 0.5, y + 24), (x + wtxt, y + 16)], ORANGE, 13, 2, 1.5), region=(x - 20, y, x + wtxt + 40, y + 50))


def hud(f, n_coins, seed=0):
    """The small jar in the corner that fills as the years go by."""
    s, dx, dy = 0.34, 50, 902
    f.art(M.jar_scene(s, dx, dy, n_coins, seed), region=(dx - 20, dy - 10, dx + 140, dy + 170))


def phone(f, x0, y0, x1, y1, tilt=0):
    d = rect_d(x0, y0, x1, y1, 36)
    f.raw(f'<path d="{d}" fill="#ffffff"/>')
    pts = rr_pts(x0, y0, x1, y1, 36)
    f.art(line(pts + [pts[0]], INK, 11, 2, 1.8) + line([(x0 + (x1 - x0) * 0.4, y0 + 22), (x0 + (x1 - x0) * 0.6, y0 + 22)], INK, 8, 1, .5),
          region=(x0 - 20, y0 - 20, x1 + 20, y1 + 20))


def qr(f, x0, y0, cell, seed=7):
    """A QR-looking square, drawn crisp like a printed sign (three finder corners plus random cells)."""
    rnd = random.Random(seed)
    n = 7
    g = [[rnd.random() < .5 for _ in range(n)] for _ in range(n)]
    for (ox, oy) in [(0, 0), (n - 3, 0), (0, n - 3)]:
        for i in range(3):
            for j in range(3):
                g[oy + j][ox + i] = not (i == 1 and j == 1)
    rects = "".join(f'<rect x="{x0 + i * cell}" y="{y0 + j * cell}" width="{cell}" height="{cell}"/>'
                    for j in range(n) for i in range(n) if g[j][i])
    f.raw(f'<g fill="#141414">{rects}</g>')


def sparkles(cx, cy, spread, n, seed=3, size=(10, 22)):
    rnd = random.Random(seed)
    s = ""
    for i in range(n):
        x = cx + rnd.uniform(-spread, spread); y = cy + rnd.uniform(-spread * .6, spread * .6)
        c = POPS[i % len(POPS)]
        if i % 3 == 0:
            s += M.star(x, y, rnd.uniform(*size), c, 6)
        elif i % 3 == 1:
            r = rnd.uniform(*size) * 0.7
            s += hatch_poly([(x - r, y - r / 2), (x + r, y - r / 2), (x + r, y + r / 2), (x - r, y + r / 2)], rad(30), 5, c, 7)
        else:
            s += disc(x, y, rnd.uniform(6, 11), c, 6, 6)
    return s


def floor_and_wall(f, wall, floor_y, floor="l"):
    f.art(hatch_poly([(0, 0), (W, 0), (W, floor_y), (0, floor_y)], rad(70), 26, PALE[wall], 28), region=(0, 0, W, floor_y))
    f.art(hatch_poly([(0, floor_y), (W, floor_y), (W, H), (0, H)], rad(8), 24, PALE[floor], 26), region=(0, floor_y, W, H))
    f.art(line([(0, floor_y), (W * .5, floor_y + 4), (W, floor_y - 2)], INK, 6, 1, 1.5), region=(0, floor_y - 20, W, floor_y + 24))


# ------------------------------------------------------------------ people (all on the 300x380 stick-figure grid)
def figure_svg(kind, arms=None, **kw):
    if kind == "grandpa":
        s = M.limbs(arms=arms or ((98, 210), (206, 228))) + M.shirt(GREEN) + M.head() + M.face()
        s += (M.tuft(113, 78) + M.tuft(109, 98) + M.tuft(187, 78) + M.tuft(191, 98) + M.tuft(150, 52, 11) + M.tuft(128, 56, 8) + M.tuft(172, 56, 8))
        s += ring((136, 88), 11, INK, 5, 1, .6) + ring((164, 88), 11, INK, 5, 1, .6)
        s += brk_line([(147, 88), (153, 88)], INK, 4, 1, amp=.3, dense=2, seg=(2, 3))
        s += brk_line(quad((138, 106), (150, 100), (162, 106), 8), M.GREY, 7, 1, amp=.5, dense=3, seg=(4, 6))
        if arms is None:
            s += brk_line([(206, 228), (214, 356)], BROWN, 8, 2, amp=1.0) + brk_line(quad((196, 232), (206, 218), (216, 228), 8), BROWN, 8, 1, amp=.6, dense=3, seg=(4, 6))
        return s
    if kind == "grandma":
        s = M.limbs(skirt=True, arms=arms or ((100, 205), (200, 205))) + M.dress(LILAC, half=42) + M.head() + M.face()
        s += M.tuft(150, 36, 15) + M.tuft(113, 78) + M.tuft(109, 98) + M.tuft(187, 78) + M.tuft(191, 98) + M.tuft(128, 54, 9) + M.tuft(172, 54, 9)
        s += ring((136, 88), 11, INK, 5, 1, .6) + ring((164, 88), 11, INK, 5, 1, .6)
        s += brk_line([(147, 88), (153, 88)], INK, 4, 1, amp=.3, dense=2, seg=(2, 3))
        s += M.heart(150, 176, 8, RED, 5)
        return s
    if kind == "mom":
        body = [(150, 148), (178, 196), (200, 238), (194, 262), (106, 262), (100, 238), (122, 196)]
        s = M.limbs(skirt=True, arms=arms or ((98, 214), (200, 214))) + poly(body, BLUE, 58, 11, 12, 7) + M.head() + M.face()
        s += brk_line(quad((114, 92), (150, 36), (186, 92), 16), INK, 9, 2, amp=1.4) + ring((196, 74), 13, INK, 8, 1, 1)
        s += M.heart(150, 220, 13, RED, 6)
        return s
    if kind == "dad":
        s = M.limbs(arms=arms or ((98, 210), (205, 215))) + M.shirt(GREEN) + M.head() + M.face()
        s += brk_line(quad((116, 80), (150, 40), (184, 80), 14), INK, 9, 2, amp=1.4)
        return s
    if kind == "auntie":
        s = M.limbs(skirt=True, arms=arms or ((100, 205), (200, 205))) + M.dress(YELLOW, half=44) + M.head() + M.face()
        for cx, cy in [(120, 62), (136, 46), (154, 42), (172, 48), (184, 64), (116, 82), (188, 84)]:
            s += ring((cx, cy), 10, INK, 6, 1, .6)
        s += ring((113, 112), 4, YELLOW, 5, 1, .3) + ring((187, 112), 4, YELLOW, 5, 1, .3)
        return s
    if kind == "girl12":
        return M.girl(arms or ((100, 205), (200, 205)), hair_len=150)
    if kind == "teen":
        s = M.girl(arms or ((100, 205), (200, 205)), hair_len=172)
        s += brk_line([(132, 150), (128, 232)], BLUE, 10, 1, amp=1) + brk_line([(168, 150), (172, 232)], BLUE, 10, 1, amp=1)
        s += box(84, 158, 108, 236, PINK[:1] if False else BLUE, 50, 8, 9, True, 5) + box(192, 158, 216, 236, BLUE, 50, 8, 9, True, 5)
        return s
    if kind == "grad":
        s = M.girl(arms or ((100, 205), (200, 205)), hair_len=190, grown=True)
        s += poly([(86, 54), (150, 30), (214, 54), (150, 78)], INK, 40, 6, 9, 5) + brk_line([(150, 78), (150, 96)], INK, 6, 1, amp=.5, dense=3, seg=(4, 6))
        s += brk_line([(206, 56), (216, 96)], YELLOW, 8, 1, amp=.6, dense=3, seg=(4, 6)) + disc(216, 100, 7, YELLOW, 6, 6, 40, 4)
        return s
    raise KeyError(kind)


def person(f, kind, cx, foot, k, arms=None, flip=False, squeeze=1.0, region_pad=40):
    svg = M.place(figure_svg(kind, arms), cx, foot, k, flip, squeeze)
    w = 160 * k + 60
    f.art(svg, region=(cx - w, foot - 400 * k * squeeze - region_pad, cx + w, foot + region_pad))


def baby(f, cx, foot, k=1.0):
    blanket = [(cx - 52 * k, foot - 10 * k), (cx - 40 * k, foot - 70 * k), (cx + 40 * k, foot - 70 * k), (cx + 52 * k, foot - 10 * k)]
    s = poly(blanket, PINK, 55, 9, 10, 6) + disc(cx, foot - 100 * k, 34 * k, [("#fde3d0")], 9, 9, 40, 6)
    s += brk_line([(cx - 12 * k, foot - 104 * k), (cx - 12 * k, foot - 98 * k)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
    s += brk_line([(cx + 12 * k, foot - 104 * k), (cx + 12 * k, foot - 98 * k)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
    s += brk_line(quad((cx - 10 * k, foot - 88 * k), (cx, foot - 80 * k), (cx + 10 * k, foot - 88 * k), 8), INK, 5, 1, amp=.4, dense=3, seg=(4, 6))
    s += M.bow(cx + 18 * k, foot - 130 * k, RED)
    f.art(s, region=(cx - 90, foot - 190 * k, cx + 90, foot + 20))


# ------------------------------------------------------------------ props
def balloons(f, cx, floor_y, flip=1):
    s = ""
    spec = [(-70, -430, 74, BLUE), (10, -520, 78, PINK), (80, -410, 72, YELLOW), (-20, -330, 66, GREEN)]
    for dx, dy, r, c in spec:
        bx, by = cx + dx * flip, floor_y + dy
        s += line([(bx, by + r), (cx + 6, floor_y - 40)], INK, 5, 1, 2)
    for dx, dy, r, c in spec:
        bx, by = cx + dx * flip, floor_y + dy
        s += disc(bx, by, r, c, 13, 14)
    f.art(s, region=(cx - 200, floor_y - 640, cx + 200, floor_y))


def bunting(f, x0, x1, y0, ysag):
    pts = quad((x0, y0), ((x0 + x1) / 2, ysag), (x1, y0), 40)
    s = line(pts, INK, 6, 1, 1.5)
    for i, t in enumerate([j / 11 for j in range(1, 11)]):
        idx = int(t * 40)
        x, y = pts[idx]
        tri = [(x - 38, y), (x + 38, y), (x, y + 86)]
        s += poly(tri, POPS[i % len(POPS)], 55, 11, 11, 6)
    f.art(s, region=(x0 - 20, y0 - 30, x1 + 20, ysag + 140))


def tree(f, cx, base_y, scale=1.0):
    s = ""
    for top, bot, half in [(-640, -330, 190), (-520, -190, 250), (-390, -40, 310)]:
        s += poly([(cx, base_y + top * scale), (cx - half * scale, base_y + bot * scale), (cx + half * scale, base_y + bot * scale)], GREEN, 62, 15, 16, 8)
    s += box(cx - 36 * scale, base_y - 40 * scale, cx + 36 * scale, base_y + 40 * scale, M.BROWN, 60, 10, 12, True, 6)
    s += M.star(cx, base_y - 660 * scale, 46 * scale, YELLOW, 9)
    for i, (dx, dy, c) in enumerate([(-80, -420, RED), (60, -480, BLUE), (-150, -250, YELLOW), (110, -300, RED), (0, -160, BLUE), (-210, -110, YELLOW), (190, -120, PINK), (-30, -330, PINK)]):
        s += disc(cx + dx * scale, base_y + dy * scale, 20 * scale, c, 9, 8)
    s += line([(cx - 120 * scale, base_y - 300 * scale), (cx - 20 * scale, base_y - 380 * scale), (cx + 100 * scale, base_y - 280 * scale), (cx + 190 * scale, base_y - 150 * scale)], YELLOW, 7, 1, 2)
    f.art(s, region=(cx - 360 * scale, base_y - 720 * scale, cx + 360 * scale, base_y + 60))


def gift(x, y, w, h, c1, c2):
    s = box(x, y, x + w, y + h, c1, 55, 9, 10, True, 6)
    s += line([(x + w / 2, y), (x + w / 2, y + h)], c2, 12, 1, 1) + line([(x, y + h / 2), (x + w, y + h / 2)], c2, 12, 1, 1)
    s += M.bow(x + w / 2, y - 4, c2)
    return s


def coin_at(cx, cy, r, seed):
    k = r / 90
    return f'<g transform="translate({cx - 100 * k:.1f} {cy - 100 * k:.1f}) scale({k:.3f})">{M.coin_body(seed)}</g>'


def arc_with_coin(f, p0, p1, p2, coin_pos, r, seed):
    pts = quad(p0, p1, p2, 24)
    arc = f'<path d="{path(pts)}" stroke="{BLUE[0]}" stroke-width="7" stroke-dasharray="2 16" stroke-linecap="round" opacity=".9"/>'
    f.art(arc + coin_at(coin_pos[0], coin_pos[1], r, seed), region=(min(p0[0], p2[0]) - 100, min(p0[1], p1[1], p2[1]) - 100, max(p0[0], p2[0]) + 100, max(p0[1], p2[1]) + 140))


def gasp(f, cx, cy, r):
    s = ""
    for a in [-70, -45, -20, 20, 45, 70]:
        x0 = cx + math.cos(rad(a - 90)) * r; y0 = cy + math.sin(rad(a - 90)) * r
        x1 = cx + math.cos(rad(a - 90)) * (r + 60); y1 = cy + math.sin(rad(a - 90)) * (r + 60)
        s += line([(x0, y0), (x1, y1)], ORANGE, 9, 1, 1)
    f.art(s, region=(cx - r - 100, cy - r - 100, cx + r + 100, cy + r + 20))


def mini_jar(f, cx, base_y, s, n, seed=0):
    dx = cx - 170 * s; dy = base_y - 454 * s
    f.art(M.jar_scene(s, dx, dy, n, seed), region=(dx - 20, dy - 10, dx + 330 * s + 20, dy + 470 * s))


# ------------------------------------------------------------------ the beats
def beat_0(v):
    f = Frame()
    f.art(hatch_poly([(0, 0), (W, 0), (W, H), (0, H)], rad(60), 40, PALE["w"], 40))
    f.text(W / 2, 330, "Some gifts grow", size=120)
    f.text(W / 2, 470, "up with them.", size=120)
    mini_jar(f, W / 2, 940, 0.9, 3, 0)
    f.art(M.heart(W / 2, 770, 46, PINK, 12), region=(W / 2 - 80, 700, W / 2 + 80, 840))
    f.art(sparkles(W / 2, 700, 380, 9, 11 + v, (14, 26)), region=(W / 2 - 520, 520, W / 2 + 520, 900))
    return f


def beat_1a(v):
    f = Frame()
    floor_and_wall(f, "y", 880, "l")
    bunting(f, 380, 1540, 150, 260)
    f.text(960, 105, "Welcome, baby!", size=68, rot=-1)
    balloons(f, 170, 880)
    balloons(f, 1860, 880, -1)
    # gift table with the QR sign
    f.art(box(1100, 700, 1780, 740, PALE["b"] + BLUE[:1], 40, 14, 14, True, 7) + line([(1140, 740), (1140, 880)], INK, 8, 1, 1.5) + line([(1740, 740), (1740, 880)], INK, 8, 1, 1.5),
          region=(1080, 680, 1800, 900))
    f.art(box(1140, 630, 1260, 700, PINK, 55, 10, 11, True, 6) + box(1165, 575, 1235, 630, YELLOW, 55, 9, 10, True, 6)
          + line([(1200, 575), (1200, 545)], RED, 8, 1, .5) + gift(1330, 640, 90, 60, GREEN, YELLOW) + gift(1440, 625, 100, 75, LILAC, PINK),
          region=(1150, 520, 1600, 720))
    f.raw(f'<path d="{rect_d(1570, 440, 1740, 700, 14)}" fill="#ffffff"/>')
    f.art(line(rr_pts(1570, 440, 1740, 700, 14) + [rr_pts(1570, 440, 1740, 700, 14)[0]], INK, 8, 2, 1.5)
          + M.heart(1655, 478, 17, RED, 6), region=(1550, 420, 1760, 720))
    f.text(1655, 530, "Baby's jar", size=26, weight=800)
    qr(f, 1600, 550, 20, 7)
    person(f, "mom", 470, 880, 1.28, arms=((98, 214), (172, 218)))
    person(f, "dad", 660, 880, 1.25)
    person(f, "grandma", 850, 880, 1.15)
    person(f, "auntie", 1010, 880, 1.2, arms=((100, 205), (240, 150)))
    bubble(f, 640, 250, 1090, 380, (850, 470), ["Everyone, scan", "the code!"], 40)
    tag(f, 60, 110, "The baby shower")
    hud(f, 1, 0)
    return f


def beat_1b(v):
    f = Frame()
    floor_and_wall(f, "y", 900, "l")
    f.art(box(0, 880, W, 940, PALE["b"] + BLUE[:1], 40, 14, 14, True, 7), region=(0, 860, W, 960))
    f.raw(f'<path d="{rect_d(1010, 230, 1520, 880, 22)}" fill="#ffffff"/>')
    pts = rr_pts(1010, 230, 1520, 880, 22)
    f.art(line(pts + [pts[0]], INK, 12, 2, 2) + M.heart(1265, 296, 34, RED, 10), region=(990, 210, 1540, 950))
    f.text(1265, 380, "Baby's jar", size=50)
    qr(f, 1085, 430, 56, 7)
    gh = hand(520, 960, 1.7, (225, 150), 0.93)
    person(f, "grandpa", 520, 960, 1.7, arms=((98, 210), (232, 148)), squeeze=0.93)
    phone(f, gh[0] - 20, gh[1] - 150, gh[0] + 110, gh[1] + 90)
    arc_with_coin(f, (gh[0] + 60, gh[1] - 180), (gh[0] + 200, gh[1] - 420), (1100, 290), (gh[0] + 330, gh[1] - 330), 54, 130)
    person(f, "mom", 1690, 960, 1.7, arms=((98, 214), (172, 218)))
    f.art(M.heart(1650, 250, 40, PINK, 10) + M.heart(1760, 300, 26, RED, 8), region=(1560, 170, 1840, 360))
    bubble(f, 1300, 70, 1860, 200, (1690, 340), ["What a lovely idea."], 44)
    tag(f, 60, 110, "The baby shower")
    hud(f, 1, 0)
    return f


def xmas_room(f):
    floor_and_wall(f, "b", 900, "p")
    f.art(box(1380, 200, 1700, 560, ["#f6f9ff"], 40, 22, 18, True, 8) + line([(1540, 200), (1540, 560)], INK, 7, 1, 1.5) + line([(1380, 380), (1700, 380)], INK, 7, 1, 1.5)
          + sparkles(1540, 380, 100, 6, 4, (6, 12)), region=(1360, 180, 1720, 580))


def beat_2a(v):
    f = Frame()
    xmas_room(f)
    tree(f, 330, 880, .95)
    f.art(gift(100, 830, 140, 70, RED, YELLOW) + gift(430, 820, 120, 80, BLUE, PINK) + gift(560, 850, 100, 52, GREEN, YELLOW), region=(60, 760, 700, 930))
    person(f, "girl12", 900, 900, 1.0)
    person(f, "grandma", 1250, 900, 1.3, arms=((100, 205), (245, 168)))
    bubble(f, 960, 90, 1480, 230, (1250, 520), ["Check your jar!"], 56)
    tag(f, 60, 110, "Age 12")
    hud(f, 4, 0)
    return f


def beat_2b(v):
    f = Frame()
    xmas_room(f)
    tree(f, 1500, 960, 0.7)
    person(f, "girl12", 520, 1070, 2.0, arms=((100, 205), (262, 172)))
    gasp(f, 520 + 0, 1070 - (346 - 92) * 2.0 + 0, 120)
    phone(f, 800, 280, 1190, 880)
    f.art(M.jar_scene(0.46, 855, 470, 9, 0) + line([(870, 340), (1120, 340)], INK, 7, 1, 1), region=(820, 300, 1180, 880))
    f.text(995, 440, "Grandma added", size=34, weight=800)
    f.text(995, 484, "to your jar", size=34, weight=800)
    bubble(f, 1290, 150, 1810, 300, (1100, 420), ["Wait... what?!"], 60)
    tag(f, 60, 110, "Age 12")
    hud(f, 4, 0)
    return f


def beat_2c(v):
    f = Frame()
    xmas_room(f)
    tree(f, 300, 940, .8)
    person(f, "girl12", 880, 1000, 1.75, arms=((100, 205), (252, 176)))
    person(f, "grandma", 1130, 1000, 1.75, arms=((48, 176), (200, 205)))
    f.art(M.heart(820, 250, 46, RED, 11) + M.heart(1010, 190, 60, PINK, 13) + M.heart(1200, 260, 40, RED, 10), region=(700, 110, 1320, 340))
    bubble(f, 1250, 60, 1850, 220, (1170, 420), ["Thank you,", "Grandma!"], 52)
    tag(f, 60, 110, "Age 12")
    hud(f, 4, 0)
    return f


def beat_3a(v):
    f = Frame()
    f.art(hatch_poly([(0, 0), (W, 0), (W, 740), (0, 740)], rad(75), 28, PALE["b"], 30), region=(0, 0, W, 740))
    f.art(hatch_poly([(0, 740), (W, 740), (W, H), (0, H)], rad(10), 24, PALE["g"], 26), region=(0, 740, W, H))
    f.art(line([(0, 740), (W / 2, 744), (W, 738)], INK, 6, 1, 1.5), region=(0, 720, W, 770))
    # car, boxes piled in the back
    car = [(1080, 790), (1080, 650), (1260, 620), (1340, 520), (1640, 520), (1740, 640), (1820, 660), (1820, 790)]
    f.art(poly(car, RED, 55, 16, 16, 8) + poly([(1360, 540), (1630, 540), (1700, 640), (1300, 640)], ["#e3f0fb", "#d2e6f7"], 40, 14, 12, 6)
          + gift(1520, 470, 110, 70, YELLOW, RED) + gift(1400, 460, 90, 80, LILAC, PINK)
          + disc(1230, 800, 62, INK, 10, 10, 40, 8) + disc(1680, 800, 62, INK, 10, 10, 40, 8), region=(1060, 420, 1840, 880))
    person(f, "mom", 330, 880, 1.35, arms=((98, 214), (228, 96)))
    person(f, "dad", 560, 880, 1.35, arms=((98, 210), (228, 100)))
    person(f, "teen", 880, 880, 1.28, arms=((74, 104), (200, 205)), flip=False)
    bubble(f, 80, 70, 640, 220, (330, 520), ["Take care,", "sweetheart!"], 52)
    bubble(f, 700, 230, 1230, 370, (560, 540), ["We're so proud of you."], 46)
    tag(f, 1400, 330, "College")
    hud(f, 6, 0)
    return f


def beat_3b(v):
    f = Frame()
    floor_and_wall(f, "g", 920, "y")
    person(f, "teen", 560, 1060, 2.1, arms=((100, 205), (236, 152)))
    f.art(sparkles(560, 300, 380, 7, 20 + v, (12, 24)), region=(100, 100, 1050, 520))
    gh = hand(560, 1060, 2.1, (236, 152))
    phone(f, gh[0] - 40, gh[1] - 150, gh[0] + 80, gh[1] + 70)
    f.raw(f'<path d="{rect_d(1010, 250, 1780, 560, 36)}" fill="#ffffff"/>')
    pts = rr_pts(1010, 250, 1780, 560, 36)
    f.art(line(pts + [pts[0]], INK, 10, 2, 2) + coin_at(1130, 405, 74, 140), region=(990, 230, 1800, 580))
    f.text(1250, 380, "Your monthly gift", size=56, anchor="start")
    f.text(1250, 450, "just arrived.", size=56, anchor="start")
    f.text(1250, 510, "From your jar", size=32, weight=700, anchor="start", fill="#6b6760")
    f.art(f'<path d="{path(quad((760, 600), (880, 540), (1000, 520), 20))}" stroke="{BLUE[0]}" stroke-width="7" stroke-dasharray="2 16" stroke-linecap="round" opacity=".9"/>', region=(700, 480, 1060, 640))
    tag(f, 60, 110, "College")
    hud(f, 6, 0)
    return f


def beat_4a(v):
    f = Frame()
    f.art(hatch_poly([(0, 0), (W, 0), (W, 760), (0, 760)], rad(75), 28, PALE["b"], 30), region=(0, 0, W, 760))
    f.art(hatch_poly([(0, 760), (W, 760), (W, H), (0, H)], rad(10), 24, PALE["g"], 26), region=(0, 760, W, H))
    f.art(line([(0, 760), (W / 2, 764), (W, 758)], INK, 6, 1, 1.5), region=(0, 740, W, 790))
    bunting(f, 120, 1800, 70, 160)
    f.art(sparkles(960, 330, 780, 22, 30 + v, (10, 24)), region=(100, 140, 1820, 640))
    person(f, "grad", 960, 930, 1.5, arms=((62, 100), (238, 100)))
    # the cap, in the air
    cap = [(1080, 250), (1180, 215), (1290, 250), (1180, 285)]
    f.art(poly(cap, INK, 40, 7, 10, 6) + line([(1180, 285), (1176, 320)], INK, 6, 1, .5) + disc(1176, 326, 9, YELLOW, 7, 6, 40, 4), region=(1040, 180, 1330, 360))
    person(f, "mom", 360, 900, 1.2, arms=((52, 100), (244, 100)))
    person(f, "dad", 560, 900, 1.2, arms=((52, 100), (244, 100)))
    person(f, "grandma", 1350, 900, 1.2, arms=((52, 100), (244, 100)))
    person(f, "grandpa", 1560, 900, 1.2, arms=((52, 100), (244, 100)), squeeze=0.93)
    person(f, "auntie", 1760, 900, 1.15, arms=((52, 100), (244, 100)))
    bubble(f, 420, 330, 900, 470, (880, 540), ["I can't believe", "I did it!"], 50)
    tag(f, 1360, 330, "Graduation")
    hud(f, 9, 0)
    return f


def beat_4b(v):
    f = Frame()
    f.art(hatch_poly([(0, 0), (W, 0), (W, H), (0, H)], rad(60), 40, PALE["y"], 40))
    f.art(sparkles(960, 540, 880, 34, 40 + v, (12, 28)), region=(0, 0, W, H))
    phone(f, 600, 70, 1320, 1010)
    f.text(960, 200, "Sats Jar", size=34, weight=700, fill="#6b6760")
    f.text(960, 330, "Congratulations,", size=76)
    f.text(960, 420, "graduate!", size=76)
    f.art(M.jar_scene(0.78, 960 - 170 * 0.78 - 8, 470, 9, 0), region=(700, 450, 1220, 870))
    f.text(960, 930, "Your jar is yours now.", size=52)
    return f


def beat_5(v):
    f = Frame()
    f.art(hatch_poly([(0, 0), (W, 0), (W, H), (0, H)], rad(60), 40, PALE["w"], 40))
    f.text(W / 2, 190, "Savings that grow with you.", size=104)
    f.text(W / 2, 262, "There for every step.", size=46, weight=700, fill="#6b6760")
    f.art(line([(340, 850), (W - 340, 854)], INK, 6, 1, 1.5), region=(300, 830, W - 300, 880))
    xs = [420, 800, 1180, 1560]
    baby(f, xs[0], 840, 1.0)
    person(f, "girl12", xs[1], 840, .72)
    person(f, "teen", xs[2], 840, .86)
    person(f, "grad", xs[3], 840, .92)
    for x, n, lab in zip(xs, (1, 4, 6, 9), ("Baby shower", "Age 12", "College", "Graduation")):
        mini_jar(f, x, 500, 0.30, n, 0)                       # same row of jars, one a little fuller each time
        f.text(x, 905, lab, size=30, weight=700, fill="#6b6760")
    f.art(coin_at(820, 985, 36, 150), region=(760, 935, 880, 1035))
    f.text(880, 1000, "Sats Jar", size=52, anchor="start")
    f.text(W / 2, 1056, "Testnet demo. Test coins only, no real money.", size=26, weight=700, fill="#8a867f")
    return f


# id, builder, seconds, pan (x drift, -1..1), zoom
BEATS = [
    ("0", beat_0, 3.0, 0.0, 1.05), ("1a", beat_1a, 4.2, -0.5, 1.07), ("1b", beat_1b, 4.0, 0.4, 1.08),
    ("2a", beat_2a, 3.4, 0.3, 1.07), ("2b", beat_2b, 3.2, -0.3, 1.09), ("2c", beat_2c, 3.4, 0.0, 1.08),
    ("3a", beat_3a, 4.0, 0.4, 1.07), ("3b", beat_3b, 3.4, -0.3, 1.08), ("4a", beat_4a, 4.0, 0.0, 1.07),
    ("4b", beat_4b, 4.0, 0.0, 1.06), ("5", beat_5, 5.2, 0.0, 1.04),
]
VARIANTS = 3


def write_svgs(ids=None):
    os.makedirs(os.path.join(WORK, "svg"), exist_ok=True)
    out = []
    for bid, fn, *_ in BEATS:
        if ids and bid not in ids:
            continue
        for v in range(VARIANTS):
            random.seed(1000 * (BEATS.index([b for b in BEATS if b[0] == bid][0]) + 1) + 97 * v)
            f = fn(v)
            p = os.path.join(WORK, "svg", f"b{bid}_v{v}.svg")
            open(p, "w").write(doc(f, v))
            out.append((bid, v, p))
    return out


def render_one(item):
    bid, v, svg = item
    png = os.path.join(WORK, "png", f"b{bid}_v{v}.png")
    ud = tempfile.mkdtemp(prefix="ud", dir=WORK)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={ud}",
                    f"--window-size={W},{H}", f"--screenshot={png}", "file://" + svg], capture_output=True, timeout=300)
    subprocess.run(["rm", "-rf", ud])
    return png


def build_video(out):
    clips = []
    os.makedirs(os.path.join(WORK, "clips"), exist_ok=True)
    for bid, _, dur, pan, zoom in BEATS:
        lst = os.path.join(WORK, "clips", f"b{bid}.txt")
        n = int(dur * 8) + 1
        with open(lst, "w") as fh:
            for i in range(n):
                fh.write(f"file '{os.path.join(WORK, 'png', f'b{bid}_v{i % VARIANTS}.png')}'\nduration 0.125\n")
        clip = os.path.join(WORK, "clips", f"b{bid}.mp4")
        frames = int(dur * 24)
        step = (zoom - 1.0) / frames
        xexpr = f"(iw-iw/zoom)/2+({pan}*(iw-iw/zoom)/2)*(on/{frames}*2-1)*-1" if pan else "(iw-iw/zoom)/2"
        vf = (f"fps=24,scale=2400:-2,zoompan=z='1+{step:.6f}*on':x='{xexpr}':y='(ih-ih/zoom)/2':d=1:s={W}x{H}:fps=24,"
              f"fade=t=in:st=0:d=0.2:color=white,fade=t=out:st={dur - 0.2:.2f}:d=0.2:color=white,format=yuv420p")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-t", str(dur),
                        "-vf", vf, "-c:v", "libx264", "-crf", "17", "-r", "24", clip], check=True)
        clips.append(clip)
    cl = os.path.join(WORK, "clips", "all.txt")
    open(cl, "w").write("".join(f"file '{c}'\n" for c in clips))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cl, "-c", "copy", "-movflags", "+faststart", out], check=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    os.makedirs(os.path.join(WORK, "png"), exist_ok=True)
    ids = args[1:] if args[:1] == ["beat"] else None
    items = write_svgs(ids)
    if args[:1] == ["draw"]:
        sys.exit(0)
    with ThreadPoolExecutor(5) as ex:
        for p in ex.map(render_one, items):
            print("rendered", os.path.basename(p))
    build_video(os.path.join(HERE, "sats-jar-story-v1.mp4"))
    print("video written")
