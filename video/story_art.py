#!/usr/bin/env python3
"""Story-video copy of app/art-src/make_art.py (as it stood on h2-landing-page): the stick
figures, jar and coins that video/draw_my_life.py and make_story.py draw with. The landing
page's make_art.py has since dropped some of them, so the video keeps its own copy.

Draws the landing page's crayon art and renders it to transparent PNGs in app/assets/.

    python3 app/art-src/make_art.py

Needs Google Chrome (headless screenshot) and ffmpeg (crop). Re-running overwrites the PNGs.
Every asset is seeded, so the output is repeatable.
"""
import json, math, os, random, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crayon_lib import *  # noqa: F401,F403

HERE = os.path.dirname(os.path.abspath(__file__))
# The video only borrows the drawing functions; anything this module writes goes to a temp folder.
OUT = os.path.join(tempfile.gettempdir(), "sats-jar-story-art")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp(prefix="satsjar-art-")

INK = ["#141414", "#1f1f1f", "#0b0b0b"]
ORANGE = ["#f59a1f", "#f7a82c", "#ee8420"]
YELLOW = ["#f7c32a", "#fad23c", "#f4b81e"]
RED = ["#e8412f", "#ee5440", "#d93a29"]
PINK = ["#f27aa8", "#f58fb5", "#ea6a9c"]
BLUE = ["#2f6fd8", "#4682e6", "#2860c4"]
GREEN = ["#3a9d4f", "#4fb062", "#2f8c44"]
LILAC = ["#b79bdc", "#c6aee6", "#a98acf"]

JOBS = []  # (name, w, h, svg)


def add(name, w, h, body, seed):
    JOBS.append((name, w, h, svg_doc(w, h, body, seed)))


def seeded(n):
    random.seed(n)


# ------------------------------------------------------------------ jar
JAR_BODY_LOCAL = ([(172, 186), (165, 236)] + quad((165, 236), (150, 262), (150, 330))[1:] + [(150, 560)]
                  + quad((150, 560), (150, 622), (215, 624))[1:] + [(385, 624)]
                  + quad((385, 624), (450, 622), (450, 560))[1:] + [(450, 330)]
                  + quad((450, 330), (450, 262), (435, 236))[1:] + [(428, 186)])
JX, JY = 130, 170  # local -> png offset


def jar_pts(scale=1.0, dx=0, dy=0):
    return [((x - JX) * scale + dx, (y - JY) * scale + dy) for x, y in JAR_BODY_LOCAL]


seeded(11)
add("jar", 340, 470, brk_line(jar_pts(), INK, 10, 3, amp=2.4, dense=6, seg=(9, 20)), 3)

# ------------------------------------------------------------------ coins (4 variants)
def coin_body(seed, R=90):
    seeded(seed)
    c = (100, 100); s = R / 212
    f = hatch_circle(c, R - 4, rad(52), 11, ["#f9c93a", "#f6b81e", "#fbd957", "#f4a91c"], 11)
    f += hatch_circle(c, R - 5, rad(-35), 15, ["#f39a28", "#f6ae2a", "#fbd957"], 9,
                      keep=lambda p, t: (p[0] - 100) + (p[1] - 100) > 20 + t * s)
    f += hatch_circle(c, R - 14, rad(52), 14, ["#fff1a8", "#fde68a"], 7,
                      keep=lambda p, t: (p[0] - 100) + (p[1] - 100) < -85 + t * s)
    f += ring(c, R - 1, ["#ee7d1c", "#f29328", "#e86a14"], 10, 3, 2.2)
    f += ring(c, R * .8, ["#f5a21a", "#ee8c1c"], 6, 2, 1.6)

    def P(x, y): return (100 + (x - 300) * s, 100 + (y - 300) * s)
    skel = [[(262, 206), (262, 394)],
            [(262, 212), (322, 212)] + quad((322, 212), (366, 212), (366, 252))[1:] + quad((366, 252), (366, 292), (322, 292))[1:] + [(262, 292)],
            [(262, 292), (332, 292)] + quad((332, 292), (382, 292), (382, 342))[1:] + quad((382, 342), (382, 392), (332, 392))[1:] + [(262, 392)],
            [(293, 176), (293, 208)], [(331, 176), (331, 208)], [(293, 392), (293, 426)], [(331, 392), (331, 426)]]
    b = ""
    for sk in skel:
        b += brk_line([P(*p) for p in sk], ["#e0600c", "#d9560a", "#e8700f"], 11, 3, amp=1.6, dense=3, seg=(6, 12))
    f += f'<g transform="rotate(14 100 100)">{b}</g>'
    return f


for i in range(4):
    add(f"coin-{i + 1}", 200, 200, coin_body(100 + i), 10 + i)

# ------------------------------------------------------------------ figures
def face(extra=""):
    s = brk_line([(138, 84), (138, 91)], INK, 7, 1, amp=.3, dense=2, seg=(3, 4))
    s += brk_line([(162, 84), (162, 91)], INK, 7, 1, amp=.3, dense=2, seg=(3, 4))
    s += brk_line(quad((135, 104), (150, 120), (165, 104), 10), INK, 6, 1, amp=.6, dense=3, seg=(5, 8))
    return s + extra


def head(): return ring((150, 92), 36, INK, 8, 2, 2)


def limbs(skirt=False, arms=((100, 205), (200, 205)), shoulder=(150, 162), hip=(150, 236), legs=((128, 342), (172, 342))):
    s = ""
    for ax, ay in arms:
        s += brk_line([shoulder, (ax, ay)], INK, 8, 2, amp=1.6)
    if skirt:
        for (lx, ly), hx in zip(legs, (132, 168)):
            s += brk_line([(hx, 262), (lx + (hx - 150) * .3, ly)], INK, 8, 2, amp=1.4)
    else:
        s += brk_line([(150, 130), hip], INK, 9, 2, amp=1.6)
        for lx, ly in legs:
            s += brk_line([hip, (lx, ly)], INK, 8, 2, amp=1.6)
    # little feet
    for lx, ly in legs:
        d = -16 if lx < 150 else 16
        s += brk_line([(lx, ly), (lx + d, ly + 4)], INK, 8, 1, amp=.8, dense=3, seg=(4, 6))
    return s


def dress(colors, hem=262, half=46):
    poly = [(150, 148), (150 + half + 8, hem), (150 - half - 8, hem)]
    s = hatch_poly(poly, rad(60), 11, colors, 12)
    s += brk_line(poly + [poly[0]], INK, 7, 2, amp=1.4, dense=5, seg=(8, 18))
    return s


def shirt(colors):
    poly = [(124, 146), (176, 146), (180, 210), (120, 210)]
    s = hatch_poly(poly, rad(58), 11, colors, 12)
    s += brk_line(poly + [poly[0]], INK, 7, 2, amp=1.2, dense=5, seg=(8, 18))
    return s


def bow(x, y, colors):
    a = [(x, y), (x - 20, y - 12), (x - 20, y + 12)]
    b = [(x, y), (x + 20, y - 12), (x + 20, y + 12)]
    return hatch_poly(a, 0, 6, colors, 8) + hatch_poly(b, 0, 6, colors, 8) + brk_line(a + [a[0]], INK, 4, 1, amp=.6) + brk_line(b + [b[0]], INK, 4, 1, amp=.6)


def heart_pts(cx, cy, size, n=40):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * size / 16, cy - y * size / 16))
    return pts


def heart(cx, cy, size, colors, w=9):
    p = heart_pts(cx, cy, size)
    return hatch_poly(p, rad(55), 9, colors, w) + brk_line(p + [p[0]], INK, 5, 1, amp=.8, dense=4, seg=(8, 16))


def star_pts(cx, cy, R, r=None, n=5, rot=-90):
    r = r or R * .42; pts = []
    for i in range(n * 2):
        a = rad(rot + 180 * i / n); rr = R if i % 2 == 0 else r
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def star(cx, cy, R, colors, w=8):
    p = star_pts(cx, cy, R)
    return hatch_poly(p, rad(60), 8, colors, w) + brk_line(p + [p[0]], INK, 4, 1, amp=.6, dense=4, seg=(6, 12))


FIGS = {}

def fig_daughter():
    s = limbs(skirt=True) + dress(PINK) + head() + face()
    s += brk_line(quad((116, 92), (150, 36), (184, 92), 16), INK, 9, 2, amp=1.6)                  # hair top
    s += brk_line([(118, 84), (106, 150)], INK, 9, 2, amp=1.6) + brk_line([(182, 84), (194, 150)], INK, 9, 2, amp=1.6)
    s += bow(172, 56, RED)
    return s
FIGS["daughter"] = fig_daughter

def fig_niece():
    s = limbs(skirt=True) + dress(YELLOW, half=40) + head() + face()
    s += brk_line(quad((116, 86), (150, 44), (184, 86), 16), INK, 9, 2, amp=1.6)
    for sx in (-1, 1):
        cx = 150 + sx * 52
        s += brk_line([(150 + sx * 34, 70), (cx, 84)], INK, 6, 1, amp=.8, dense=4, seg=(4, 8))
        s += ring((cx, 98), 15, INK, 8, 2, 1.4)
    s += ring((130, 52), 8, PINK, 7, 1, .8) + ring((130, 52), 2, YELLOW, 5, 1, .3)
    return s
FIGS["niece"] = fig_niece

def fig_granddaughter():
    s = limbs(skirt=True) + dress(LILAC, half=50) + head() + face()
    s += brk_line(quad((114, 90), (150, 38), (186, 90), 16), INK, 9, 2, amp=1.6)
    s += brk_line(quad((116, 70), (150, 48), (184, 70), 12), BLUE, 10, 2, amp=1.2)                  # headband
    for sx in (-1, 1):
        pts = [(150 + sx * 34, 108), (150 + sx * 42, 120), (150 + sx * 34, 132), (150 + sx * 44, 144), (150 + sx * 36, 156)]
        s += brk_line(pts, INK, 8, 2, amp=1.0, dense=4)
    s += heart(150, 200, 12, RED, 6)
    return s
FIGS["granddaughter"] = fig_granddaughter

def fig_sister():
    s = limbs(skirt=True) + dress(RED, half=44) + head() + face()
    s += brk_line(quad((116, 88), (150, 54), (184, 88), 14), INK, 9, 2, amp=1.4)
    s += ring((150, 40), 15, INK, 8, 2, 1.2)                                                         # bun
    s += brk_line([(128, 66), (140, 78)], INK, 6, 1, amp=.5, dense=3, seg=(4, 6)) + brk_line([(172, 66), (160, 78)], INK, 6, 1, amp=.5, dense=3, seg=(4, 6))
    s += star(150, 214, 15, YELLOW, 6)
    return s
FIGS["little sister"] = fig_sister

def fig_son():
    s = limbs() + shirt(BLUE) + head() + face()
    sp = [(116, 76), (124, 52), (134, 70), (142, 44), (152, 68), (162, 44), (170, 70), (180, 52), (184, 76)]
    s += brk_line(sp, INK, 8, 2, amp=1.0, dense=4)
    return s
FIGS["son"] = fig_son

def fig_nephew():
    s = limbs() + shirt(YELLOW) + head() + face()
    cap = [(112, 78), (188, 78), (184, 58), (166, 46), (134, 46), (116, 58)]
    s += hatch_poly(cap, rad(30), 9, GREEN, 10) + brk_line(cap + [cap[0]], INK, 7, 2, amp=1.2, dense=5, seg=(8, 16))
    s += brk_line([(150, 78), (212, 80)], INK, 8, 2, amp=1.0, dense=4)                              # brim
    return s
FIGS["nephew"] = fig_nephew

def fig_grandson():
    s = limbs() + shirt(LILAC) + head()
    s += ring((136, 88), 11, INK, 6, 1, .8) + ring((164, 88), 11, INK, 6, 1, .8)
    s += brk_line([(147, 88), (153, 88)], INK, 5, 1, amp=.3, dense=2, seg=(2, 3))
    s += brk_line([(138, 88), (138, 90)], INK, 6, 1, amp=.2, dense=2, seg=(2, 3)) + brk_line([(162, 88), (162, 90)], INK, 6, 1, amp=.2, dense=2, seg=(2, 3))
    s += brk_line(quad((135, 108), (150, 120), (165, 108), 10), INK, 6, 1, amp=.6, dense=3, seg=(5, 8))
    s += brk_line(quad((116, 80), (150, 46), (184, 80), 14), INK, 9, 2, amp=1.6)
    return s
FIGS["grandson"] = fig_grandson

def fig_brother():
    s = limbs() + shirt(RED) + head() + face()
    for pts in ([(122, 62), (116, 46), (134, 56)], [(146, 54), (144, 36), (158, 50)], [(170, 56), (182, 40), (180, 62)]):
        s += brk_line(pts, INK, 8, 2, amp=.8, dense=4)
    s += star(150, 178, 13, YELLOW, 6)
    return s
FIGS["little brother"] = fig_brother

def fig_loved():
    s = limbs(arms=((96, 130), (204, 130))) + head() + face()
    s += brk_line(quad((116, 90), (150, 48), (184, 90), 14), INK, 9, 2, amp=1.6)
    s += heart(150, 24, 19, RED, 8)
    s += brk_line([(128, 142), (172, 142)], BLUE, 12, 2, amp=1.0, dense=4)                          # scarf
    return s
FIGS["loved one"] = fig_loved

SLUG = {"daughter": "daughter", "niece": "niece", "granddaughter": "granddaughter", "little sister": "little-sister",
        "son": "son", "nephew": "nephew", "grandson": "grandson", "little brother": "little-brother", "loved one": "loved-one"}
for i, (name, fn) in enumerate(FIGS.items()):
    seeded(200 + i)
    add(f"figure-{SLUG[name]}", 300, 380, fn(), 30 + i)

# ------------------------------------------------------------------ frames and colour patches (collage)
def densify(pts, step=5):
    out = []
    for a, b in zip(pts, pts[1:] + pts[:1]):
        k = max(1, int(math.dist(a, b) / step))
        for i in range(k): out.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    return out


def wavy_rect(x0, y0, x1, y1, r, amp, wl):
    pts = densify(rrect(x0, y0, x1, y1, r), 3); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    out = []; run = 0
    for i, p in enumerate(pts):
        if i: run += math.dist(p, pts[i - 1])
        nx, ny = p[0] - cx, p[1] - cy; L = math.hypot(nx, ny) or 1
        o = amp * math.sin(2 * math.pi * run / wl)
        out.append((p[0] + nx / L * o, p[1] + ny / L * o))
    return out + [out[0]]


FW, FH = 320, 400
seeded(301)
sc = []
for i in range(120):
    t = 2 * math.pi * i / 120
    r = 1 + 0.045 * abs(math.sin(11 * t))
    sc.append((160 + 138 * r * math.cos(t), 200 + 178 * r * math.sin(t)))
sc.append(sc[0])
add("frame-1", FW, FH, brk_line(sc, ORANGE, 13, 2, amp=1.6, dense=4, seg=(14, 30)) + ring((160, 200), 0, ORANGE, 6, 0), 51)
seeded(302)
w1 = wavy_rect(20, 24, 300, 376, 26, 6, 30); w2 = wavy_rect(38, 42, 282, 358, 20, 4, 26)
add("frame-2", FW, FH, brk_line(w1, RED, 12, 2, amp=1.2, dense=4, seg=(14, 30)) + brk_line(w2, PINK, 7, 1, amp=1.2, dense=4, seg=(14, 30)), 52)
seeded(303)
sb = ""
for k in range(3):
    j = lambda v: v + random.uniform(-4, 4)
    sb += brk_line([(j(24), j(30)), (j(304), j(26))], BLUE, 9, 1, amp=1.8, dense=5)
    sb += brk_line([(j(300), j(20)), (j(304), j(380))], BLUE, 9, 1, amp=1.8, dense=5)
    sb += brk_line([(j(308), j(372)), (j(18), j(378))], BLUE, 9, 1, amp=1.8, dense=5)
    sb += brk_line([(j(22), j(384)), (j(20), j(22))], BLUE, 9, 1, amp=1.8, dense=5)
add("frame-3", FW, FH, sb, 53)
seeded(304)
gb = ""
for pts in ([(26, 30), (294, 24)], [(296, 24), (292, 376)], [(294, 374), (26, 380)], [(24, 378), (30, 28)]):
    gb += brk_line(pts, GREEN, 20, 2, amp=2.4, dense=5, seg=(10, 22))
add("frame-4", FW, FH, gb, 54)

PATCH = [["#fde9b8", "#fcdf9a"], ["#fcd3e2", "#f9bfd5"], ["#d5e4fb", "#c2d8f8"], ["#d3ecd8", "#bfe3c8"]]
for i, cols in enumerate(PATCH):
    seeded(310 + i)
    poly = [(40, 40), (282, 36), (284, 366), (38, 362)] if i % 2 == 0 else [(46, 34), (278, 44), (274, 360), (42, 368)]
    add(f"patch-{i + 1}", FW, FH, hatch_poly(poly, rad(58), 12, cols, 15), 60 + i)

# ------------------------------------------------------------------ underlines
for i, (nm, col) in enumerate([("orange", ORANGE), ("pink", PINK), ("blue", BLUE), ("green", GREEN)]):
    seeded(320 + i)
    pts = [(14 + x, 22 + 7 * math.sin(x / 22)) for x in range(0, 560, 6)]
    add(f"underline-{nm}", 600, 44, brk_line(pts, col, 13, 2, amp=1.4, dense=4, seg=(14, 28)), 70 + i)

# ------------------------------------------------------------------ doodles (collage confetti)
seeded(330); add("doodle-star", 120, 120, star(60, 62, 46, YELLOW, 11), 80)
seeded(331); add("doodle-heart", 120, 120, heart(60, 60, 44, RED, 11), 81)
seeded(332)
sp = [(60 + (4 + 3.2 * t) * math.cos(t * 1.0), 60 + (4 + 3.2 * t) * math.sin(t * 1.0)) for t in [i / 4 for i in range(0, 64)]]
add("doodle-spiral", 120, 120, brk_line(sp, BLUE, 8, 1, amp=.5, dense=3, seg=(12, 22)), 82)
seeded(333); add("doodle-zigzag", 160, 80, brk_line([(10, 56), (36, 20), (62, 56), (88, 20), (114, 56), (140, 20)], GREEN, 10, 2, amp=1.2, dense=4), 83)
seeded(334)
dots = "".join(ring((cx, cy), r, PINK, 8, 1, .6) for cx, cy, r in [(30, 30, 9), (72, 24, 7), (94, 62, 10), (46, 70, 7), (18, 78, 6)])
add("doodle-dots", 120, 100, dots, 84)
seeded(335)
sp4 = star_pts(60, 60, 48, 11, 4, -90)
add("doodle-sparkle", 120, 120, hatch_poly(sp4, rad(60), 8, ORANGE, 8) + brk_line(sp4 + [sp4[0]], INK, 4, 1, amp=.6, dense=4, seg=(6, 12)), 85)

# ------------------------------------------------------------------ colour swatches (like the crayon patches in the collage)
for i, (nm, cols, ang) in enumerate([("lilac", LILAC, 30), ("yellow", YELLOW, -25), ("pink", PINK, 40)]):
    seeded(340 + i)
    add(f"swatch-{nm}", 300, 120, hatch_poly([(8, 12), (292, 8), (294, 110), (6, 114)], rad(ang), 13, cols, 15), 90 + i)

# ------------------------------------------------------------------ step art: one story across three panels
# 1 an empty jar, 2 the family tops it up (it starts to fill), 3 the beneficiary holds it full.
SW, SH = 320, 220
PILE = [(57.76, 85.64), (33.26, 85.64), (76.29, 76.91), (42.79, 71.19), (62.74, 64.28), (24.00, 62.77),
        (44.41, 55.23), (77.59, 52.43), (28.41, 44.19)]       # coin centres, % of the 340x470 jar picture
GREY = ["#cfcfcf", "#bdbdbd", "#d8d8d8"]
WHITE_HAIR = ["#e4e4e4", "#d2d2d2"]
BROWN = ["#8a5a2b", "#7a4d22"]


def jar_scene(s, dx, dy, ncoins, seed):
    """A jar at scale s (its top-left corner offset by dx, dy) with its first ncoins coins inside."""
    out = ""
    k = 47 * s / 90                                            # coin picture is 200 wide for a radius of 90
    for i in range(ncoins):
        cx = PILE[i][0] / 100 * 340 * s + dx
        cy = PILE[i][1] / 100 * 470 * s + dy
        out += f'<g transform="translate({cx - 100 * k:.1f} {cy - 100 * k:.1f}) scale({k:.3f})">{coin_body(100 + i)}</g>'
    out += brk_line(jar_pts(s, dx, dy), INK, 7, 2, amp=1.1, dense=5, seg=(8, 16))
    return out


def tuft(cx, cy, r=9):
    return hatch_poly([(cx + r * math.cos(t), cy + r * math.sin(t)) for t in [i * math.pi / 6 for i in range(12)]], rad(40), 5, WHITE_HAIR, 6) \
        + ring((cx, cy), r, INK, 4, 1, .5)


def fig_grandpa(give=None):
    s = limbs(arms=((98, 210), give or (206, 228))) + shirt(GREEN) + head() + face()
    s += tuft(113, 78) + tuft(109, 98) + tuft(187, 78) + tuft(191, 98) + tuft(150, 52, 11) + tuft(128, 56, 8) + tuft(172, 56, 8)
    s += ring((136, 88), 11, INK, 5, 1, .6) + ring((164, 88), 11, INK, 5, 1, .6)                         # glasses
    s += brk_line([(147, 88), (153, 88)], INK, 4, 1, amp=.3, dense=2, seg=(2, 3))
    s += brk_line(quad((138, 106), (150, 100), (162, 106), 8), GREY, 7, 1, amp=.5, dense=3, seg=(4, 6))  # moustache
    if not give:
        s += brk_line([(206, 228), (214, 356)], BROWN, 8, 2, amp=1.0)                                   # cane
        s += brk_line(quad((196, 232), (206, 218), (216, 228), 8), BROWN, 8, 1, amp=.6, dense=3, seg=(4, 6))
    return s


def fig_man(give=None):
    s = limbs(arms=(give or (98, 210), (205, 215))) + shirt(BLUE) + head() + face()
    s += brk_line(quad((116, 80), (150, 40), (184, 80), 14), INK, 9, 2, amp=1.4)
    return s


def fig_woman(give=None):
    s = limbs(skirt=True, arms=(give or (95, 215), (200, 210))) + dress(PINK, half=40) + head() + face()
    s += brk_line(quad((114, 92), (150, 36), (186, 92), 16), INK, 9, 2, amp=1.4)
    s += brk_line([(116, 88), (108, 128)], INK, 9, 2, amp=1.2) + brk_line([(184, 88), (192, 128)], INK, 9, 2, amp=1.2)
    return s


def fig_auntie(give=None):
    s = limbs(skirt=True, arms=((100, 205), give or (200, 205))) + dress(YELLOW, half=44) + head() + face()
    for cx, cy in [(120, 62), (136, 46), (154, 42), (172, 48), (184, 64), (116, 82), (188, 84)]:
        s += ring((cx, cy), 10, INK, 6, 1, .6)                                                          # curls
    s += ring((113, 112), 4, YELLOW, 5, 1, .3) + ring((187, 112), 4, YELLOW, 5, 1, .3)                  # earrings
    s += heart(150, 168, 9, RED, 5)                                                                     # brooch
    return s


def girl(arms, hair_len=150, grown=False):
    """The same girl in steps 1 and 3: red bow, black hair, pink dress. Grown up: longer hair and earrings."""
    s = limbs(skirt=True, arms=arms) + dress(PINK) + head() + face()
    s += brk_line(quad((116, 92), (150, 36), (184, 92), 16), INK, 9, 2, amp=1.6)
    s += brk_line([(118, 84), (106, hair_len)], INK, 9, 2, amp=1.6) + brk_line([(182, 84), (194, hair_len)], INK, 9, 2, amp=1.6)
    s += bow(172, 56, RED)
    if grown:
        s += ring((113, 116), 4, YELLOW, 5, 1, .3) + ring((187, 116), 4, YELLOW, 5, 1, .3)
    return s


def fig_girl_child():
    """Small, reaching up to the empty jar."""
    return girl(((100, 206), (222, 190)), hair_len=140)


def fig_girl_grown():
    """Grown up, holding the full jar out in front of her."""
    return girl(((226, 206), (236, 216)), hair_len=190, grown=True)


def place(fig_svg, cx, foot, k, flip=False, squeeze=1.0):
    """Put a 300x380 stick figure on the canvas: centre x, feet y, scale."""
    sx = -k if flip else k
    return (f'<g transform="translate({cx:.1f} {foot - 346 * k * squeeze:.1f}) scale({sx:.3f} {k * squeeze:.3f}) translate({-150} 0)">'
            f'{fig_svg}</g>')


def flight(p0, p1, p2, coin_at, coin_seed, scale=.17):
    """A token flying toward the jar: a dotted arc and a small coin at its start."""
    pts = quad(p0, p1, p2, 18)
    arc = (f'<path d="{path(pts)}" stroke="{BLUE[0]}" stroke-width="3" stroke-dasharray="1 7" '
           f'stroke-linecap="round" opacity=".85"/>')
    cx, cy = coin_at
    return arc + f'<g transform="translate({cx - 100 * scale:.1f} {cy - 100 * scale:.1f}) scale({scale})">{coin_body(coin_seed)}</g>'


# 1: the little girl beside the empty jar
seeded(350)
s1 = jar_scene(.40, 112, 18, 0, 0) + heart(180, 118, 30, PINK, 8) + place(fig_girl_child(), 92, 206, .35)
add("step-1", SW, SH, s1, 100)

# 2: the family drops tokens into the jar from both sides; the jar starts to fill.
# Each person holds a coin up in a raised hand; a dotted arc with an arrowhead runs from the hand down into the jar's mouth.
def hand(cx, foot, k, sq, ax, ay):
    return (cx + (ax - 150) * k, foot - 346 * k * sq + ay * k * sq)


def give_flight(h, mouth, lift, seed):
    """Coin in the giver's hand, an arc up and over, an arrowhead pointing down into the jar."""
    hx, hy = h
    mx, my = mouth
    ctrl = ((hx + mx) / 2, min(hy, my) - lift)
    pts = quad((hx + (4 if hx < mx else -4), hy - 20), ctrl, (mx, my - 12), 18)
    arc = (f'<path d="{path(pts)}" stroke="{BLUE[0]}" stroke-width="3" stroke-dasharray="1 7" '
           f'stroke-linecap="round" opacity=".9"/>')
    arc += brk_line([(mx - 7, my - 22), (mx, my - 11), (mx + 7, my - 22)], BLUE, 4, 1, amp=.3, dense=2, seg=(3, 4))
    return arc + f'<g transform="translate({hx - 15 + (4 if hx < mx else -4):.1f} {hy - 32:.1f}) scale(.15)">{coin_body(seed)}</g>'


seeded(351)
JS, JDX, JDY = .37, 97, 34
s2 = jar_scene(JS, JDX, JDY, 3, 0)
cfg = [  # figure, cx, k, squeeze, raised hand (figure coords), mouth x
    (fig_grandpa, 26, .34, .93, (214, 28), 132),
    (fig_auntie, 70, .34, .95, (226, 62), 150),
    (fig_man, 250, .34, 1.0, (74, 62), 172),
    (fig_woman, 294, .34, .97, (86, 28), 190),
]
figs, flights = "", ""
for i, (fn, cx, k, sq, g, mx) in enumerate(cfg):
    figs += place(fn(give=g), cx, 206, k, squeeze=sq)
    flights += give_flight(hand(cx, 206, k, sq, *g), (mx, JDY + 6), 18 if i % 2 else 34, 120 + i)
s2 += figs + flights
# one coin already dropping into the mouth
s2 += f'<g transform="translate({160 - 17:.1f} {JDY + 14:.1f}) rotate(-14) scale(.17)">{coin_body(130)}</g>'
add("step-2", SW, SH, s2, 101)

# 3: the same girl, grown up, holding the full jar
seeded(352)
s3 = jar_scene(.38, 134, 33.5, 9, 0) + place(fig_girl_grown(), 92, 212, .58, squeeze=1.1)
s3 += star(282, 44, 15, YELLOW, 6) + star(300, 100, 9, ORANGE, 5) + star(40, 34, 10, YELLOW, 5)
add("step-3", SW, SH, s3, 102)

# ------------------------------------------------------------------ eraser (for the headline word swap)
seeded(360)
body = rrect(34, 34, 186, 98, 16)
sleeve = rrect(104, 34, 186, 98, 14)
er = hatch_poly(body, rad(52), 9, PINK, 11)
er += hatch_poly(sleeve, rad(52), 9, BLUE, 11)
er += brk_line([(104, 36), (104, 96)], INK, 6, 1, amp=.8)
er += brk_line(body + [body[0]], INK, 7, 2, amp=1.4, dense=5, seg=(8, 18))
er += brk_line([(120, 52), (170, 52)], ["#ffffff"], 5, 1, amp=.6) + brk_line([(120, 80), (170, 80)], ["#ffffff"], 5, 1, amp=.6)
add("eraser", 220, 130, f'<g transform="rotate(-10 110 66)">{er}</g>', 110)

# ------------------------------------------------------------------ pile layout for the jar (png px units)
random.seed(42)
R = 47; D = 2 * R * 0.8; INNER_L, INNER_R, FLOOR = 24.5, 315.5, 449.5
rest = []
for i in range(9):
    best = None
    for _ in range(12):
        x = random.uniform(INNER_L + R + 4, INNER_R - R - 4); y = FLOOR - R
        for (xj, yj, _r) in rest:
            dx = abs(x - xj)
            if dx < D: y = min(y, yj - math.sqrt(D * D - dx * dx))
        if best is None or y > best[1]: best = (x, y)
    rest.append((best[0], best[1], random.uniform(-35, 35)))
json.dump({"jar": [340, 470], "coinRadius": R, "neck": [46.5, 293.5],
           "coins": [{"x": round(x, 1), "y": round(y, 1), "rot": round(r, 1)} for x, y, r in rest]},
          open(os.path.join(OUT, "pile.json"), "w"), indent=1)
print("pile top y (png px):", round(min(r[1] for r in rest) - R, 1), file=sys.stderr)

# ------------------------------------------------------------------ grain mask (for crayon-textured lettering)
GRAIN_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="9" stitchTiles="stitch"/>
<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 -0.75"/></filter>
<rect width="256" height="256" filter="url(#g)"/></svg>'''
JOBS.append(("grain", 256, 256, GRAIN_SVG))

# Lettering texture: horizontal streaks plus pinholes, so filled letters look scribbled in with wax.
GRAIN_TEXT_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<filter id="g" x="0" y="0" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.035 0.42" numOctaves="3" seed="4" stitchTiles="stitch" result="streak"/>
<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="12" stitchTiles="stitch" result="pin"/>
<feColorMatrix in="streak" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.6 0 0 0 -0.62" result="a"/>
<feColorMatrix in="pin" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.2 0 0 0 -0.55" result="b"/>
<feComposite in="a" in2="b" operator="in"/></filter>
<rect width="256" height="256" filter="url(#g)"/></svg>'''
JOBS.append(("grain-text", 256, 256, GRAIN_TEXT_SVG))


# ------------------------------------------------------------------ render
def render(job):
    name, w, h, svg = job
    sp = os.path.join(TMP, name + ".svg"); open(sp, "w").write(svg)
    big = os.path.join(TMP, name + "-big.png"); out = os.path.join(OUT, name + ".png")
    ww, hh = max(w, 500), max(h, 500)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
                    "--force-device-scale-factor=2", f"--user-data-dir={os.path.join(TMP, 'ud-' + name)}",
                    f"--window-size={ww},{hh}", f"--screenshot={big}", "file://" + sp], capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", big, "-vf", f"crop={w * 2}:{h * 2}:0:0", out], check=True)
    return name


if __name__ == "__main__":
    only = sys.argv[1:]
    jobs = [j for j in JOBS if not only or any(j[0].startswith(o) for o in only)]
    with ThreadPoolExecutor(6) as ex:
        for n in ex.map(render, jobs):
            print("ok", n)
