#!/usr/bin/env python3
"""Sats Jar "Draw my life": a hand draws the story in crayon, in fast-forward, at 12 drawings a second.

    PY=/private/tmp/claude-502/dml-venv/bin/python
    $PY video/draw_my_life.py            # render every drawing layer (cached), then the video
    $PY video/draw_my_life.py still 4    # one PNG of scene 4 fully drawn (quick layout check)
    $PY video/draw_my_life.py timing     # print the scene timeline only

Scenes are timed to the voice-over script read at a natural pace (macOS `say` is used only to
measure each line; no voice goes into the film). Record the voice-over over the finished cut.

Every layer a scene adds (a head, a jar, a line of text) is rendered once with Chrome as a
transparent PNG, then revealed over time in the order it was drawn, with a crayon-holding hand at
the leading edge. Needs Google Chrome, ffmpeg, and Pillow + NumPy. Story: video/script-v2.md.
"""
import hashlib, math, os, random, subprocess, sys, tempfile, wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "app", "art-src"))
import make_story as S  # noqa: E402  (Frame, crayon helpers, props)
import story_art as M  # noqa: E402
from crayon_lib import brk_line, ring, hatch_poly, quad, rad, rrect, path  # noqa: E402

W, H = S.W, S.H
FPS = 12
WORK = os.environ.get("DML_WORK", "/private/tmp/claude-502/dml")
INK, ORANGE, YELLOW, RED, PINK, BLUE, GREEN, LILAC = S.INK, S.ORANGE, S.YELLOW, S.RED, S.PINK, S.BLUE, S.GREEN, S.LILAC
BROWN, GREY = M.BROWN, M.GREY
SKIN = ["#f6cfb0", "#f2c3a0"]
PALETTE = {"ink": INK, "orange": ORANGE, "yellow": YELLOW, "red": RED, "pink": PINK, "blue": BLUE,
           "green": GREEN, "lilac": LILAC, "brown": BROWN, "grey": GREY}
VOICE, RATE = "Samantha", 168


# ------------------------------------------------------------------ scenes are Frames whose layers are drawing steps
class Scene(S.Frame):
    def __init__(self, name):
        super().__init__()
        self.name = name
        self.segs = []
        self._group = None
        self._mode = None

    def say(self, vo, pause=0.35):
        """Start a voice-over segment: the layers added after this are drawn while it is spoken."""
        self.segs.append({"vo": vo, "start": len(self.layers), "pause": pause})

    def _add(self, kind, svg, region=None, mode=None):
        self.layers.append({"kind": kind, "svg": svg, "region": region, "mode": mode or self._mode, "group": self._group})

    def raw(self, svg):
        self._add("raw", svg)

    def art(self, svg, region=None):
        self._add("art", svg, region)

    def text(self, x, y, s, size=48, weight=800, fill="#141414", anchor="middle", opacity=1, rot=0):
        t = f' transform="rotate({rot} {x} {y})"' if rot else ""
        self._add("text", f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
                          f'fill="{fill}" opacity="{opacity}"{t}>{s}</text>', mode="lr")

    def erase(self, group):
        self.layers.append({"kind": "erase", "target": group, "group": None})

    @contextmanager
    def group(self, name):
        old, self._group = self._group, name
        yield
        self._group = old

    @contextmanager
    def mode(self, m):
        old, self._mode = self._mode, m
        yield
        self._mode = old


# ------------------------------------------------------------------ people, drawn in parts (head, body, limbs)
def face(mood="smile"):
    eye_l = brk_line([(138, 84), (138, 91)], INK, 7, 1, amp=.3, dense=2, seg=(3, 4))
    eye_r = brk_line([(162, 84), (162, 91)], INK, 7, 1, amp=.3, dense=2, seg=(3, 4))
    smile = brk_line(quad((135, 104), (150, 120), (165, 104), 10), INK, 6, 1, amp=.6, dense=3, seg=(5, 8))
    if mood == "sad":
        return eye_l + eye_r + brk_line(quad((136, 116), (150, 103), (164, 116), 10), INK, 6, 1, amp=.6, dense=3, seg=(5, 8))
    if mood == "wink":
        return eye_l + brk_line([(155, 90), (162, 83), (169, 90)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4)) + smile
    if mood == "joy":
        return (brk_line([(132, 90), (138, 83), (144, 90)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
                + brk_line([(156, 90), (162, 83), (168, 90)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
                + S.poly(quad((132, 102), (150, 128), (168, 102), 10), RED, 40, 5, 6, 5))
    return eye_l + eye_r + smile


def glasses():
    return (ring((136, 88), 11, INK, 5, 1, .6) + ring((164, 88), 11, INK, 5, 1, .6)
            + brk_line([(147, 88), (153, 88)], INK, 4, 1, amp=.3, dense=2, seg=(2, 3)))


def girl_hair(length, grown=False):
    s = brk_line(quad((116, 92), (150, 36), (184, 92), 16), INK, 9, 2, amp=1.6)
    s += brk_line([(118, 84), (106, length)], INK, 9, 2, amp=1.6) + brk_line([(182, 84), (194, length)], INK, 9, 2, amp=1.6)
    s += M.bow(172, 56, RED)
    if grown:
        s += ring((113, 116), 4, YELLOW, 5, 1, .3) + ring((187, 116), 4, YELLOW, 5, 1, .3)
    return s


def parts(kind, arms=None, mood="smile"):
    """[head (with face and hair), body, limbs] on the 300x380 stick-figure grid."""
    A = arms or ((100, 205), (200, 205))
    f = face(mood)
    if kind == "grandpa":
        hair = "".join(M.tuft(*t) for t in [(113, 78), (109, 98), (187, 78), (191, 98)])  # bald on top
        tache = S.poly([(132, 104), (150, 98), (168, 104), (160, 112), (150, 108), (140, 112)], GREY, 20, 4, 6, 4)
        return [M.head() + f + glasses() + hair + tache, M.shirt(GREEN), M.limbs(arms=A)]
    if kind == "dad":
        return [M.head() + f + brk_line(quad((116, 80), (150, 40), (184, 80), 14), INK, 9, 2, amp=1.4), M.shirt(BLUE), M.limbs(arms=A)]
    if kind == "lee":
        hat = S.box(112, 34, 188, 64, BROWN, 60, 8, 9, True, 5) + brk_line([(96, 66), (204, 66)], INK, 8, 2, amp=.8)
        return [M.head() + f + glasses() + hat, M.shirt(ORANGE), M.limbs(arms=A)]
    if kind == "mom":
        body = [(150, 148), (178, 196), (200, 238), (194, 262), (106, 262), (100, 238), (122, 196)]
        hair = brk_line(quad((114, 92), (150, 36), (186, 92), 16), INK, 9, 2, amp=1.4) + ring((196, 74), 13, INK, 8, 1, 1)
        return [M.head() + f + hair, S.poly(body, BLUE, 58, 11, 12, 7) + M.heart(150, 220, 13, RED, 6), M.limbs(skirt=True, arms=A)]
    if kind == "auntie":
        curls = "".join(ring((cx, cy), 10, INK, 6, 1, .6) for cx, cy in [(120, 62), (136, 46), (154, 42), (172, 48), (184, 64), (116, 82), (188, 84)])
        curls += ring((113, 112), 4, YELLOW, 5, 1, .3) + ring((187, 112), 4, YELLOW, 5, 1, .3)
        return [M.head() + f + curls, M.dress(YELLOW, half=44), M.limbs(skirt=True, arms=A)]
    if kind in ("girl", "teen", "grown"):
        length = {"girl": 150, "teen": 172, "grown": 190}[kind]
        return [M.head() + f + girl_hair(length, kind == "grown"), M.dress(PINK), M.limbs(skirt=True, arms=A)]
    raise KeyError(kind)


def person(sc, kind, cx, foot, k, arms=None, mood="smile", flip=False, squeeze=1.0):
    head, body, limbs = parts(kind, arms, mood)
    for p, m in ((head, "arc"), (body, "tb"), (limbs, "tb")):
        sc._add("art", M.place(p, cx, foot, k, flip, squeeze), mode=m)


def at(cx, foot, k, loc, flip=False, squeeze=1.0):
    return S.hand(cx, foot, k, loc, squeeze, flip)


def baby(sc, cx, foot, k=1.0):
    blanket = [(cx - 52 * k, foot - 10 * k), (cx - 40 * k, foot - 70 * k), (cx + 40 * k, foot - 70 * k), (cx + 52 * k, foot - 10 * k)]
    head = S.disc(cx, foot - 100 * k, 34 * k, ["#fde3d0"], 9, 9, 40, 6)
    head += brk_line([(cx - 12 * k, foot - 104 * k), (cx - 12 * k, foot - 98 * k)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
    head += brk_line([(cx + 12 * k, foot - 104 * k), (cx + 12 * k, foot - 98 * k)], INK, 6, 1, amp=.3, dense=2, seg=(3, 4))
    head += brk_line(quad((cx - 10 * k, foot - 88 * k), (cx, foot - 80 * k), (cx + 10 * k, foot - 88 * k), 8), INK, 5, 1, amp=.4, dense=3, seg=(4, 6))
    sc._add("art", head + M.bow(cx + 18 * k, foot - 130 * k, RED), mode="arc")
    sc._add("art", S.poly(blanket, PINK, 55, 9, 10, 6), mode="lr")


# ------------------------------------------------------------------ jars and coins
def jar_box(cx, base, s):
    return cx - 170 * s, base - 454 * s


def jar(sc, cx, base, s, n=0, seed=0):
    dx, dy = jar_box(cx, base, s)
    sc._add("art", M.jar_scene(s, dx, dy, n, seed), mode="tb")


def coin_in_jar(sc, cx, base, s, i, seed=None):
    dx, dy = jar_box(cx, base, s)
    x = M.PILE[i][0] / 100 * 340 * s + dx
    y = M.PILE[i][1] / 100 * 470 * s + dy
    sc._add("art", S.coin_at(x, y, 47 * s, 100 + i if seed is None else seed), mode="arc")
    return x, y


def coin(sc, x, y, r, seed=120):
    sc._add("art", S.coin_at(x, y, r, seed), mode="arc")


def dotted_arc(sc, p0, p1, p2, col=BLUE):
    pts = quad(p0, p1, p2, 30)
    s = f'<path d="{path(pts)}" stroke="{col[0]}" stroke-width="8" stroke-dasharray="2 18" stroke-linecap="round" fill="none"/>'
    end = pts[-1]; prev = pts[-3]
    a = math.atan2(end[1] - prev[1], end[0] - prev[0])
    for da in (2.6, -2.6):
        s += brk_line([(end[0] + 30 * math.cos(a + da), end[1] + 30 * math.sin(a + da)), end], col, 7, 1, amp=.4, dense=3, seg=(4, 6))
    sc._add("raw", s, mode="lr" if p2[0] >= p0[0] else "rl")


def underline(sc, x0, x1, y, col=ORANGE, w=12):
    sc._add("art", brk_line([(x0, y), ((x0 + x1) / 2, y + 7), (x1, y - 3)], col, w, 2, amp=1.5), mode="lr")


def heart(sc, x, y, size, col=RED):
    sc._add("art", M.heart(x, y, size, col, 8), mode="arc")


def stamp(sc, cx, cy, w, h, lines, rot=-8):
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    c, s_ = math.cos(rad(rot)), math.sin(rad(rot))
    pts = [(cx + x * c - y * s_, cy + x * s_ + y * c) for x, y in pts]
    sc._add("art", brk_line(pts + [pts[0]], RED, 12, 3, amp=2.2) , mode="lr")
    for i, t in enumerate(lines):
        sc.text(cx, cy + (i - (len(lines) - 1) / 2) * 76 + 24, t, size=66, fill=RED[0], rot=rot)


def label(sc, x, y, s, size=44, col="#141414", anchor="middle"):
    sc.text(x, y, s, size=size, fill=col, anchor=anchor)


# ------------------------------------------------------------------ the scenes
def s0():
    sc = Scene("title")
    sc.say("This is my life. [[slnc 150]] And my jar.", 0.3)
    sc.text(900, 470, "Draw my life", size=190)
    underline(sc, 340, 1460, 515, ORANGE, 16)
    sc.text(900, 650, "(and my jar)", size=96, fill=ORANGE[2])
    jar(sc, 1610, 760, .62, 0)
    coin_in_jar(sc, 1610, 760, .62, 0)
    return sc


def s1():
    sc = Scene("day1")
    gx, gf, gk = 600, 1020, 1.85
    sc.say("The day I was born, Grandpa made me a jar.", 0.2)
    S.tag(sc, 90, 120, "Day 1")
    person(sc, "grandpa", gx, gf, gk, arms=((88, 214), (232, 128)))
    bx, by = at(gx, gf, gk, (88, 214))
    baby(sc, bx - 30, by + 70, 1.55)
    jar(sc, 1380, 960, 1.0, 0)
    sc.say("One coin. [[slnc 150]] This one's for later.", 0.4)
    hx, hy = at(gx, gf, gk, (232, 128))
    coin(sc, hx + 14, hy - 24, 34, 140)
    dotted_arc(sc, (hx + 50, hy - 50), (1100, 160), (1350, 470))
    coin_in_jar(sc, 1380, 960, 1.0, 0)
    S.bubble(sc, 110, 170, 640, 380, (500, 450), ["This one's", "for later."], size=60)
    return sc


def s2():
    sc = Scene("rules")
    sc.say("Then he set the rule.", 0.15)
    jar(sc, 560, 990, 1.3, 1)
    card = (1000, 160, 1840, 940)
    sc.raw(f'<path d="{S.rect_d(*card, 18)}" fill="#ffffff"/>')
    pts = rrect(*card, 18)
    sc._add("art", brk_line(pts + [pts[0]], INK, 9, 2, amp=2.2, dense=8, seg=(10, 22)), mode="tb")
    sc._add("art", brk_line(quad((700, 420), (860, 330), (1000, 300), 16), BROWN, 7, 2, amp=1.2), mode="lr")
    sc.text(1420, 300, "THE RULE", size=92, fill=RED[2])
    underline(sc, 1180, 1660, 330, RED, 12)
    sc.say("A little each month. [[slnc 100]] All of it at eighteen.", 0.15)
    sc.text(1060, 440, "1. A little each month.", size=54, anchor="start")
    sc.text(1060, 550, "2. All of it at 18.", size=54, anchor="start")
    sc.say("And nobody can change it. [[slnc 150]] Not even him.", 0.4)
    sc.text(1060, 660, "3. Nobody can change it.", size=54, anchor="start")
    sc.text(1060, 760, "Not even me.", size=54, anchor="start")
    sc.text(1560, 870, "- Grandpa", size=52, fill=BLUE[2])
    return sc


def s3():
    """Milestones: first steps, first day of school, first lost tooth; someone drops a coin in each time."""
    sc = Scene("milestones")
    jx, jb, js = 960, 1050, .7
    mouth = (jx, jb - 454 * js + 14)
    sc.say("First steps. [[slnc 120]] First day of school. [[slnc 120]] First lost tooth.", 0.15)
    jar(sc, jx, jb, js, 1)
    for x in (640, 1280):
        sc.raw(f'<path d="M{x} 170 L{x} 620" stroke="#c9c2b4" stroke-width="5" stroke-dasharray="2 16" stroke-linecap="round"/>')
    sc.text(330, 210, "Age 1: first steps", size=42, fill=ORANGE[2])
    person(sc, "girl", 200, 580, .62, arms=((50, 150), (250, 150)), mood="joy")
    sc.raw('<g fill="#9a9387">' + "".join(f'<ellipse cx="{70 + i * 34}" cy="{600 + (i % 2) * 14}" rx="9" ry="5"/>' for i in range(4)) + '</g>')
    person(sc, "auntie", 470, 580, .82, arms=((100, 205), (250, 110)))
    sc.text(960, 210, "Age 5: first day of school", size=42, fill=BLUE[2])
    sc._add("art", S.poly([(670, 360), (780, 280), (890, 360)], RED, 50, 12, 12, 7) + S.box(690, 360, 870, 580, YELLOW, 50, 14, 14, True, 7)
            + S.box(755, 480, 805, 580, BROWN, 50, 9, 10, True, 6), mode="tb")
    sc.text(780, 420, "SCHOOL", size=28)
    person(sc, "girl", 1170, 580, .72, arms=((90, 215), (210, 215)), mood="joy")
    sc._add("art", S.box(at(1170, 580, .72, (176, 150))[0], at(1170, 580, .72, (176, 150))[1],
                          at(1170, 580, .72, (214, 230))[0], at(1170, 580, .72, (214, 230))[1], GREEN, 50, 8, 9, True, 5), mode="tb")
    person(sc, "mom", 1010, 580, .82, arms=((50, 110), (200, 214)))
    sc.text(1600, 210, "Age 7: lost a tooth", size=42, fill=GREEN[2])
    person(sc, "girl", 1690, 580, .8, arms=((100, 215), (240, 150)), mood="joy")
    tx, ty = at(1690, 580, .8, (240, 150))
    sc._add("art", S.poly([(tx - 16, ty - 52), (tx + 16, ty - 52), (tx + 14, ty - 26), (tx + 6, ty - 18), (tx, ty - 28), (tx - 6, ty - 18), (tx - 14, ty - 26)],
                          ["#ffffff"], 40, 5, 5, 5), mode="tb")
    person(sc, "lee", 1420, 580, .82, arms=((40, 100), (205, 215)))
    sc.say("Every big moment, someone dropped a coin in.", 0.4)
    for i, hand in enumerate([at(470, 580, .82, (250, 110)), at(1010, 580, .82, (50, 110)), at(1420, 580, .82, (40, 100))]):
        hx, hy = hand
        dotted_arc(sc, (hx, hy + 10), ((hx + mouth[0]) / 2, 720), (mouth[0] + (hx - mouth[0]) * .06, mouth[1] - 20))
        coin_in_jar(sc, jx, jb, js, i + 1)
    return sc


def s4():
    sc = Scene("age9")
    sc.say("When money got tight,", 0.1)
    S.tag(sc, 90, 120, "Age 9")
    person(sc, "dad", 760, 990, 1.45, arms=((96, 236), (206, 60)), mood="sad")
    sc.raw(f'<rect x="480" y="752" width="560" height="330" fill="#fffdf9"/>')
    sc._add("art", S.box(470, 740, 1050, 770, BROWN, 10, 9, 10, True, 7)
            + brk_line([(510, 770), (510, 1060)], INK, 9, 2, amp=1) + brk_line([(1010, 770), (1010, 1060)], INK, 9, 2, amp=1), mode="lr")
    sc._add("art", S.box(560, 690, 670, 740, ["#ffffff"], 40, 30, 4, True, 5), mode="lr")
    sc.text(615, 727, "BILL", size=26, fill=RED[2])
    sc._add("art", brk_line([(1300, 700), (1800, 696)], BROWN, 12, 2, amp=1.2), mode="lr")
    jar(sc, 1550, 696, .7, 4)
    sc.say("the rule said no. [[slnc 120]] Nobody could touch it.", 0.5)
    stamp(sc, 1550, 400, 520, 190, ["THE RULE", "SAYS NO"], rot=-8)
    return sc


def s5():
    sc = Scene("age12")
    sc.say("At twelve, my monthly gift bought this sketchbook.", 0.4)
    S.tag(sc, 90, 120, "Age 12")
    person(sc, "girl", 760, 1010, 1.6, arms=((60, 230), (250, 150)), mood="joy")
    S.phone(sc, 1120, 260, 1520, 900)
    sc.text(1320, 440, "Your monthly", size=48)
    sc.text(1320, 500, "gift arrived!", size=48)
    coin(sc, 1320, 660, 70, 131)
    bk = (180, 470, 460, 820)
    sc.raw(f'<path d="{S.rect_d(*bk, 10)}" fill="#ffffff"/>')
    sc._add("art", S.box(*bk, ["#fff6e0"], 60, 30, 6, True, 8)
            + "".join(ring((200 + i * 36, 470), 11, INK, 5, 1, .5) for i in range(8)), mode="tb")
    sc.text(320, 620, "Draw", size=50)
    sc.text(320, 676, "my life", size=50)
    return sc


def s6():
    sc = Scene("age16")
    sc.say("Grandpa moved into a care home.", 0.15)
    S.tag(sc, 90, 120, "Age 16")
    # the care home, top left: a long low building with a sign, Grandpa waving from the garden
    sc._add("art", S.poly([(80, 330), (330, 240), (580, 330)], RED, 50, 12, 12, 7) + S.box(100, 330, 560, 600, LILAC, 50, 14, 14, True, 7), mode="tb")
    sc._add("art", "".join(S.box(x, 380, x + 70, 440, BLUE, 50, 8, 8, True, 5) for x in (140, 300, 460))
            + S.box(300, 500, 360, 600, BROWN, 50, 9, 9, True, 5), mode="lr")
    sc.raw('<path d="M180 470 H560 V500 H180 Z" fill="#ffffff"/>')
    sc.text(370, 495, "Sunny Days Care Home", size=24)
    sx, sf, sk = 690, 600, .8
    person(sc, "grandpa", sx, sf, sk, arms=((84, 232), (236, 150)), mood="wink")
    cx0, cy0 = at(sx, sf, sk, (84, 232)); cx1, cy1 = at(sx, sf, sk, (74, 356))
    sc._add("art", brk_line([(cx0, cy0), (cx1, cy1)], BROWN, 9, 2, amp=.8), mode="tb")
    sc.say("But every birthday, a coin still arrived.", 0.5)
    sc._add("art", S.box(820, 820, 1100, 960, PINK, 50, 12, 12, True, 7) + S.box(850, 760, 1070, 822, YELLOW, 50, 12, 12, True, 7), mode="tb")
    sc.text(960, 720, "16", size=80, fill=BLUE[2])
    person(sc, "teen", 1330, 1010, 1.55, mood="joy")
    jar(sc, 1730, 990, .7, 6)
    jdx, jdy = jar_box(1730, 990, .7)
    hx, hy = at(sx, sf, sk, (236, 150))
    sc._add("art", S.box(hx - 2, hy - 40, hx + 26, hy + 6, INK, 50, 5, 6, True, 4), mode="tb")
    dotted_arc(sc, (hx + 40, hy - 30), (1250, 80), (1720, jdy + 10))
    coin_in_jar(sc, 1730, 990, .7, 6)
    sc.text(1260, 220, "love, Grandpa", size=44, fill=BLUE[2])
    return sc


def full_jar_rows(cx, base, s, R=30, seed=3):
    """Coins packed to the brim and heaped over the top, as rows from the bottom up (canvas x, y, r)."""
    rnd = random.Random(seed)
    dx, dy = jar_box(cx, base, s)
    rows, y, i = [], 470 * .93 - R, 0
    while y > -40:
        if y > 470 * .14:
            x0, x1 = 340 * .11 + R, 340 * .89 - R
        else:  # the heap above the rim: narrower each row
            h = (470 * .14 - y) / (470 * .14 + 40)
            half = (340 * .39 - R) * (1 - h * .85)
            x0, x1 = 170 - half, 170 + half
        n = max(1, int((x1 - x0) / (1.7 * R)) + 1)
        xs = [x0 + (x1 - x0) * k / max(1, n - 1) for k in range(n)] if n > 1 else [170]
        if i % 2 and n > 2:
            xs = [x + .85 * R * (1 if x < 170 else -1) * .5 for x in xs]
        rows.append([(px * s + dx + rnd.uniform(-.15, .15) * R * s, (y + rnd.uniform(-.15, .15) * R) * s + dy, R * s) for px in xs])
        y -= 1.45 * R; i += 1
    return rows


def s7():
    sc = Scene("age18")
    jx, jb, js = 1380, 1010, 1.4
    sc.say("At eighteen, the jar became mine.", 0.15)
    S.tag(sc, 90, 120, "Age 18")
    person(sc, "grandpa", 190, 1010, 1.4, arms=((40, 110), (210, 220)), mood="joy")
    person(sc, "grown", 470, 1010, 1.6, arms=((60, 230), (250, 140)), mood="joy")
    S.phone(sc, 700, 220, 960, 640)
    sc.text(830, 380, "The jar", size=44)
    sc.text(830, 436, "is yours", size=44)
    sc.text(830, 492, "now.", size=44)
    jar(sc, jx, jb, js, 0)
    sc.say("Every coin, from everyone who loved me.", 0.15)
    rows = full_jar_rows(jx, jb, js)
    for ri, row in enumerate(rows):
        sc._add("art", "".join(S.coin_at(x, y, r, 150 + (ri * 7 + k) % 9) for k, (x, y, r) in enumerate(row)), mode="lr")
    for x, y in ((1050, 1000), (1700, 990), (1760, 1030)):
        coin(sc, x, y, 34, 160 + x % 7)
    sc._add("art", S.sparkles(jx, 300, 330, 12, seed=21, size=(14, 26)), mode="lr")
    for x, y, s, col in [(1100, 300, "Grandpa", BLUE), (1080, 180, "Mum", BLUE), (1530, 180, "Aunt", ORANGE), (1730, 300, "Mr. Lee", GREEN), (1790, 470, "Dad", GREEN)]:
        label(sc, x, y, s, size=40, col=col[2])
    sc.say("And Grandpa's first one, [[slnc 120]] right at the bottom.", 0.9)
    x0, y0, r0 = rows[0][0]
    sc._add("art", ring((x0, y0), r0 + 22, RED, 9, 2, 3), mode="arc")
    sc.text(1010, 850, "Grandpa's", size=44, fill=RED[2])
    sc.text(1010, 902, "first coin", size=44, fill=RED[2])
    sc._add("art", brk_line(quad((1090, 920), (1140, 960), (x0 - r0 - 18, y0), 10), RED, 8, 2, amp=.8), mode="lr")
    return sc


def s8():
    sc = Scene("end")
    sc.say("Some gifts grow up with you.", 0.2)
    sc.text(960, 330, "Some gifts grow", size=124)
    sc.text(960, 470, "up with you.", size=124)
    underline(sc, 600, 1320, 505, ORANGE, 16)
    sc.say("Sats Jar.", 1.6)
    coin(sc, 700, 680, 62, 102)
    sc.text(1010, 714, "Sats Jar", size=96)
    sc.text(960, 860, "Start a jar for someone you love.", size=56, fill=BLUE[2])
    sc._add("raw", '<text x="960" y="1010" font-size="30" font-weight="500" text-anchor="middle" fill="#6b6b6b">'
                   'Testnet demo. Test coins only, no real money.</text>', mode="instant")
    return sc


SCENES = [s0, s1, s2, s3, s4, s5, s6, s7, s8]


def build_scenes():
    out = []
    for i, fn in enumerate(SCENES):
        random.seed(5000 + 31 * i)
        out.append(fn())
    return out


# ------------------------------------------------------------------ rendering layers with Chrome
FILTER = '''<filter id="w" filterUnits="userSpaceOnUse" x="{x}" y="{y}" width="{w}" height="{h}">
<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="{s}" result="w"/>
<feDisplacementMap in="SourceGraphic" in2="w" scale="5" result="d"/>
<feTurbulence type="fractalNoise" baseFrequency="0.32" numOctaves="3" seed="{s2}" result="g"/>
<feColorMatrix in="g" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4.2 0 0 0 -1.25" result="m"/>
<feComposite in="d" in2="m" operator="in"/></filter>'''


def layer_svg(layer, seed, w=W, h=H):
    head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><defs><style>{S.FONT_CSS} text{{font-family:"ArchivoEmbed","Archivo",Arial,sans-serif}}</style>'
    if layer["kind"] == "art":
        x0, y0, x1, y1 = layer["region"] or (0, 0, w, h)
        f = FILTER.format(x=max(0, x0), y=max(0, y0), w=min(w, x1) - max(0, x0), h=min(h, y1) - max(0, y0), s=seed, s2=seed + 20)
        return head + f + f'</defs><g filter="url(#w)" fill="none" stroke-linecap="round" stroke-linejoin="round">{layer["svg"]}</g></svg>'
    return head + f'</defs>{layer["svg"]}</svg>'


def chrome_png(svg, png, w=W, h=H):
    if os.path.exists(png):
        return png
    d = tempfile.mkdtemp(prefix="c", dir=WORK)
    src = os.path.join(d, "l.svg")
    open(src, "w").write(svg)
    subprocess.run([S.CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={d}/ud",
                    "--default-background-color=00000000", f"--window-size={w},{h}", f"--screenshot={png}.tmp.png", "file://" + src],
                   capture_output=True, timeout=300)
    os.replace(png + ".tmp.png", png)
    subprocess.run(["rm", "-rf", d])
    return png


def render_layers(scenes):
    os.makedirs(os.path.join(WORK, "layers"), exist_ok=True)
    jobs = []
    for si, sc in enumerate(scenes):
        for li, L in enumerate(sc.layers):
            if L["kind"] == "erase":
                continue
            svg = layer_svg(L, 7 + li * 3)
            L["png"] = os.path.join(WORK, "layers", hashlib.sha1(svg.encode()).hexdigest()[:16] + ".png")
            jobs.append((svg, L["png"]))
    todo = [j for j in jobs if not os.path.exists(j[1])]
    print(f"layers: {len(jobs)} ({len(todo)} to render)")
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: chrome_png(*j), todo))


# ------------------------------------------------------------------ the drawing hand
def hand_svg(tool):
    col = PALETTE.get(tool, INK)
    s = S.box(430, -130, 1300, 170, ["#a9c1e6", "#97b3df"], 60, 18, 18, True, 8)  # sleeve
    s += brk_line([(452, -130), (452, 170)], INK, 7, 2, amp=1) + brk_line([(480, -130), (480, 170)], INK, 5, 1, amp=1)
    palm = rrect(250, -95, 470, 135, 80)
    s += S.poly(palm, SKIN, 50, 11, 12, 7)
    if tool == "eraser":
        s += S.box(0, -46, 150, 46, PINK, 50, 9, 10, True, 7) + S.box(150, -46, 260, 46, BLUE, 50, 9, 10, True, 7)
    else:
        s += S.poly([(0, 0), (48, -21), (48, 21)], col, 30, 6, 8, 6)
        s += S.box(48, -22, 300, 22, col, 50, 8, 10, True, 6)
        s += brk_line([(110, -22), (110, 22)], INK, 6, 1, amp=.5) + brk_line([(118, -22), (118, 22)], INK, 4, 1, amp=.5)
        s += brk_line([(260, -22), (260, 22)], INK, 6, 1, amp=.5)
    s += S.poly(rrect(180, 52, 330, 104, 24), SKIN, 40, 9, 10, 6)
    s += S.poly(rrect(118, 12, 310, 66, 26), SKIN, 40, 9, 10, 6)
    s += S.poly(rrect(126, -76, 268, -14, 28), SKIN, 40, 9, 10, 6)
    return f'<g transform="translate(70 70) rotate(46)">{s}</g>'


HAND_W, HAND_H, HAND_TIP, HAND_K = 1100, 1200, (70, 70), 0.62


def render_hands():
    os.makedirs(os.path.join(WORK, "hands"), exist_ok=True)
    out = {}
    jobs = []
    for tool in list(PALETTE) + ["eraser"]:
        random.seed(77)
        svg = layer_svg({"kind": "art", "svg": hand_svg(tool), "region": None}, 9, HAND_W, HAND_H)
        png = os.path.join(WORK, "hands", hashlib.sha1(svg.encode()).hexdigest()[:16] + ".png")
        jobs.append((svg, png, HAND_W, HAND_H)); out[tool] = png
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda j: chrome_png(*j), jobs))
    hands = {}
    for t, p in out.items():
        im = Image.open(p).convert("RGBA")
        hands[t] = im.resize((int(HAND_W * HAND_K), int(HAND_H * HAND_K)), Image.LANCZOS)
    return hands


# ------------------------------------------------------------------ layer geometry: how each one gets drawn
class Op:
    def __init__(self, L):
        self.L = L
        self.kind = L["kind"]
        self.group = L.get("group")
        if self.kind == "erase":
            self.target = L["target"]; self.nat = 0.9; self.tool = "eraser"; self.instant = False
            return
        im = Image.open(L["png"]).convert("RGBA")
        a = np.asarray(im)[:, :, 3]
        ys, xs = np.nonzero(a > 8)
        if len(xs) == 0:
            self.img = None; self.instant = True; self.nat = 0; self.tool = None; return
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        self.x, self.y = int(x0), int(y0)
        self.img = im.crop((x0, y0, x1, y1))
        arr = np.asarray(self.img).astype(np.float32)
        self.alpha = arr[:, :, 3] / 255.0
        w, h = x1 - x0, y1 - y0
        on = self.alpha > .3
        rgb = arr[:, :, :3][on].mean(axis=0) if on.any() else np.array([255, 255, 255])
        self.instant = L.get("mode") == "instant" or rgb.mean() > 244
        self.tool = None if self.instant else min(PALETTE, key=lambda k: sum((int(PALETTE[k][0][i * 2 + 1:i * 2 + 3], 16) - rgb[i]) ** 2 for i in range(3)))
        cover = on.mean()
        mode = L.get("mode") or ("arc" if cover < .22 and max(w, h) / max(1, min(w, h)) < 1.6 else ("lr" if w >= h else "tb"))
        self.mode = mode
        area = on.sum()
        if self.kind == "text":
            self.nat = 0.12 + w / 1300
        else:
            self.nat = 0.07 + max(w, h) / 2400 + area / 650000
        if self.instant:
            self.nat = 0
        self._prep(w, h)

    def _prep(self, w, h):
        a = self.alpha > .2
        if self.mode == "arc":
            cy, cx = np.mean(np.nonzero(a), axis=1)
            yy, xx = np.mgrid[0:h, 0:w]
            th = (np.arctan2(xx - cx, -(yy - cy)) / (2 * np.pi)) % 1.0  # 0 at top, clockwise
            self.coord = th
            bins = np.minimum((th * 72).astype(int), 71)
            rr = np.hypot(xx - cx, yy - cy)
            self.track = []
            for b in range(72):
                sel = a & (bins == b)
                r = float(np.median(rr[sel])) if sel.any() else float(np.median(rr[a]))
                t = (b + .5) / 72 * 2 * np.pi
                self.track.append((cx + r * math.sin(t), cy - r * math.cos(t)))
            self.span = None
            return
        horiz = self.mode in ("lr", "rl")
        n = w if horiz else h
        idx = np.arange(n, dtype=np.float32)
        if self.mode in ("rl", "bt"):
            idx = idx[::-1].copy()
        self.coord = (idx[None, :] if horiz else idx[:, None]) / max(1, n - 1)
        prof = a if horiz else a.T  # rows: across, cols: along
        self.span = []
        for j in range(n):
            col = np.nonzero(prof[:, j])[0]
            self.span.append((col.min(), col.max()) if len(col) else None)
        if self.mode in ("rl", "bt"):
            self.span = self.span[::-1]
        last = None
        for j in range(n):
            if self.span[j] is None:
                self.span[j] = last
            last = self.span[j]
        first = next((s for s in self.span if s is not None), (0, 0))
        self.span = [s or first for s in self.span]

    def mask(self, f):
        """Alpha of this layer when a fraction f of it has been drawn."""
        soft = 0.04 if self.mode == "arc" else 0.025
        m = np.clip((f - self.coord) / soft + 1, 0, 1)
        return self.alpha * m

    def tip(self, f, t):
        if self.mode == "arc":
            b = min(71, int(f * 72))
            x, y = self.track[b]
            return self.x + x, self.y + y
        horiz = self.mode in ("lr", "rl")
        n = len(self.span)
        j = min(n - 1, int(f * (n - 1)))
        lo, hi = self.span[j]
        wig = .5 + .5 * math.sin(t * 2 * math.pi * 5.5)
        across = lo + (hi - lo) * wig
        along = j if self.mode in ("lr", "tb") else n - 1 - j
        return (self.x + along, self.y + across) if horiz else (self.x + across, self.y + along)

    def image_at(self, f):
        if f >= 1:
            return self.img
        arr = np.asarray(self.img).copy()
        arr[:, :, 3] = (self.mask(f) * 255).astype(np.uint8)
        return Image.fromarray(arr, "RGBA")


# ------------------------------------------------------------------ voice-over (guide) and timing
def vo_clip(text, key):
    os.makedirs(os.path.join(WORK, "vo"), exist_ok=True)
    p = os.path.join(WORK, "vo", hashlib.sha1(f"{VOICE}{RATE}{text}".encode()).hexdigest()[:14] + ".wav")
    if not os.path.exists(p):
        aiff = p + ".aiff"
        subprocess.run(["say", "-v", VOICE, "-r", str(RATE), "-o", aiff, text], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", aiff, "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", p], check=True)
        os.remove(aiff)
    with wave.open(p) as w:
        return p, w.getnframes() / w.getframerate()


def timeline(scenes):
    """Times for every op, voice clip and transition. Returns (events, total_seconds)."""
    t = 0.2
    ev = {"ops": [], "vo": [], "slides": [], "scene_spans": []}
    for si, sc in enumerate(scenes):
        sc_t0 = t
        for gi, seg in enumerate(sc.segs):
            end = sc.segs[gi + 1]["start"] if gi + 1 < len(sc.segs) else len(sc.layers)
            ops = sc.ops[seg["start"]:end]
            vo_path, vo_len = vo_clip(seg["vo"], f"{si}-{gi}")
            nat = sum(o.nat for o in ops) + 0.05 * len(ops)
            want = vo_len * 0.92
            k = min(1.6, max(0.4, want / nat)) if nat > 0 else 1
            ev["vo"].append((t + 0.15, vo_path))
            ot = t + 0.05
            for o in ops:
                d = o.nat * k
                ev["ops"].append((ot, ot + d, si, o))
                ot += d + (0.05 if d else 0)
            t = max(t + 0.1 + vo_len + seg["pause"], ot + 0.15)
        t += 0.15
        ev["scene_spans"].append((sc_t0, t, si))
        if si < len(scenes) - 1:
            ev["slides"].append((t, t + 0.35, si))
            t += 0.35
    return ev, t + 0.4


# ------------------------------------------------------------------ frames
def paper_textures(n=3):
    out = []
    rng = np.random.default_rng(3)
    for i in range(n):
        g = rng.normal(0, 1, (H // 3 + 1, W // 3 + 1)).astype(np.float32)
        g = np.repeat(np.repeat(g, 3, 0), 3, 1)[:H, :W]
        fine = rng.normal(0, 1, (H, W)).astype(np.float32)
        v = 251 + 1.6 * g + 1.2 * fine
        img = np.stack([v, v - 1.5, v - 5], -1).clip(0, 255).astype(np.uint8)
        out.append(Image.fromarray(img, "RGB").convert("RGBA"))
    return out


def paste(canvas, img, x, y):
    x, y = int(round(x)), int(round(y))
    w, h = img.size
    cx0, cy0 = max(0, -x), max(0, -y)
    cx1, cy1 = min(w, W - x), min(h, H - y)
    if cx1 <= cx0 or cy1 <= cy0:
        return
    canvas.alpha_composite(img if (cx0, cy0, cx1, cy1) == (0, 0, w, h) else img.crop((cx0, cy0, cx1, cy1)), (x + cx0, y + cy0))


OFF = (W + 320, H + 260)


def ease(u):
    return 1 - (1 - u) ** 3


def render_video(scenes, ev, total, out_path, hands):
    papers = paper_textures()
    ops_by_scene = {}
    for (a, b, si, o) in ev["ops"]:
        ops_by_scene.setdefault(si, []).append((a, b, o))
    # hand path: tool position at time t
    draw = [(a, b, o) for (a, b, si, o) in ev["ops"] if not o.instant and b > a]

    def hand_at(t):
        prev = nxt = None
        for (a, b, o) in draw:
            if a <= t <= b:
                f = (t - a) / (b - a)
                if o.kind == "erase":
                    return o.etip(f, t), o.tool
                return o.tip(f, t), o.tool
            if b < t:
                prev = (b, o)
            elif a > t and nxt is None:
                nxt = (a, o)
        p_end = (prev[1].etip(1, prev[0]) if prev[1].kind == "erase" else prev[1].tip(1, prev[0])) if prev else OFF
        n_start = (nxt[1].etip(0, nxt[0]) if nxt[1].kind == "erase" else nxt[1].tip(0, nxt[0])) if nxt else OFF
        tool = (nxt or prev or (0, None))[1]
        tool = tool.tool if tool else "ink"
        gp = t - prev[0] if prev else 99
        gn = nxt[0] - t if nxt else 99
        if prev and nxt and nxt[0] - prev[0] < 0.7:
            u = gp / (nxt[0] - prev[0])
            return (p_end[0] + (n_start[0] - p_end[0]) * u, p_end[1] + (n_start[1] - p_end[1]) * u), tool
        if gp < 0.3:
            u = ease(gp / 0.3)
            return (p_end[0] + (OFF[0] - p_end[0]) * u, p_end[1] + (OFF[1] - p_end[1]) * u), (prev[1].tool or "ink")
        if gn < 0.3:
            u = ease(1 - gn / 0.3)
            return (OFF[0] + (n_start[0] - OFF[0]) * u, OFF[1] + (n_start[1] - OFF[1]) * u), tool
        return OFF, tool

    # erase ops need the bounding box of their target group
    for si, sc in enumerate(scenes):
        for o in sc.ops:
            if o.kind == "erase":
                tg = [p for p in sc.ops if p.group == o.target and p.kind != "erase" and p.img is not None]
                o.targets = tg
                o.bx0 = min(p.x for p in tg); o.bx1 = max(p.x + p.img.size[0] for p in tg)
                o.by0 = min(p.y for p in tg); o.by1 = max(p.y + p.img.size[1] for p in tg)

                def etip(f, t, o=o):
                    x = o.bx0 + (o.bx1 - o.bx0) * f
                    wig = .5 + .5 * math.sin(t * 2 * math.pi * 4)
                    return x, o.by0 + (o.by1 - o.by0) * wig
                o.etip = etip

    n = int(total * FPS)
    rng = random.Random(9)
    proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                             "-i", "-", "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-crf", "17", "-preset", "medium", out_path],
                            stdin=subprocess.PIPE)
    for fi in range(n):
        t = fi / FPS
        jx, jy = rng.choice([-1, 0, 1]), rng.choice([-1, 0, 1])
        canvas = papers[fi % len(papers)].copy()
        # which scene is on the page, and is it sliding away?
        slide = 0
        si_now = None
        for (a, b, si) in ev["scene_spans"]:
            if a - 0.01 <= t < b:
                si_now = si
        for (a, b, si) in ev["slides"]:
            if a <= t < b:
                si_now = si
                slide = ease((t - a) / (b - a)) * (W + 80)
        if si_now is None:
            si_now = len(scenes) - 1 if t > 1 else 0
        erased = set()
        partial_erase = {}
        for (a, b, o) in ops_by_scene.get(si_now, []):
            if o.kind == "erase" and t >= a:
                f = 1 if t >= b else (t - a) / (b - a)
                for p in o.targets:
                    if f >= 1:
                        erased.add(id(p))
                    else:
                        partial_erase[id(p)] = (o, f)
        for (a, b, o) in ops_by_scene.get(si_now, []):
            if o.kind == "erase" or o.img is None or t < a or id(o) in erased:
                continue
            f = 1 if (t >= b or o.instant) else (t - a) / (b - a)
            img = o.image_at(f)
            if id(o) in partial_erase:
                eo, ef = partial_erase[id(o)]
                cut = eo.bx0 + (eo.bx1 - eo.bx0) * ef - o.x
                arr = np.asarray(img).copy()
                xs = np.arange(arr.shape[1])[None, :]
                arr[:, :, 3] = (arr[:, :, 3] * np.clip((xs - cut) / 18, 0, 1)).astype(np.uint8)
                img = Image.fromarray(arr, "RGBA")
            paste(canvas, img, o.x + jx - slide, o.y + jy)
        if not slide:
            (hx, hy), tool = hand_at(t)
            if (hx, hy) != OFF:
                hk = HAND_K
                paste(canvas, hands[tool or "ink"], hx - HAND_TIP[0] * hk + jx, hy - HAND_TIP[1] * hk + jy)
        proc.stdin.write(canvas.convert("RGB").tobytes())
        if fi % 120 == 0:
            print(f"  frame {fi}/{n}", flush=True)
    proc.stdin.close()
    proc.wait()


# ------------------------------------------------------------------ sound: guide voice plus crayon scratch
def build_audio(ev, total, with_voice, out_wav):
    sr = 48000
    n = int(total * sr) + sr
    mix = np.zeros(n, np.float32)
    rng = np.random.default_rng(4)
    noise = rng.normal(0, 1, n).astype(np.float32)
    spec = np.fft.rfft(noise)
    fr = np.fft.rfftfreq(n, 1 / sr)
    band = ((fr > 900) & (fr < 7000)).astype(np.float32) * (1 / np.sqrt(np.maximum(fr, 1) / 900))
    scratch = np.fft.irfft(spec * band, n).astype(np.float32)
    scratch /= np.abs(scratch).max()
    env = np.zeros(n, np.float32)
    for (a, b, si, o) in ev["ops"]:
        if o.instant or b <= a:
            continue
        i0, i1 = int(a * sr), int(b * sr)
        tt = np.arange(i1 - i0) / sr
        lvl = 0.10 if o.kind == "erase" else 0.06
        flutter = .55 + .45 * np.abs(np.sin(2 * np.pi * (6.5 if o.kind != "erase" else 4) * tt + rng.uniform(0, 3)))
        env[i0:i1] = np.maximum(env[i0:i1], lvl * flutter)
    k = int(0.012 * sr)
    env = np.convolve(env, np.ones(k) / k, mode="same")
    mix += scratch * env
    if with_voice:
        for (st, p) in ev["vo"]:
            with wave.open(p) as w:
                v = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
            i0 = int(st * sr)
            mix[i0:i0 + len(v)] += v[:max(0, n - i0)] * 0.9
    mix = np.clip(mix, -1, 1)
    with wave.open(out_wav, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())


# ------------------------------------------------------------------ main
def still(scenes, idx):
    sc = scenes[idx]
    canvas = paper_textures(1)[0]
    erased = set()
    for o in sc.ops:
        if o.kind == "erase":
            erased |= {id(p) for p in sc.ops if p.group == o.target and p.kind != "erase"}
    for o in sc.ops:
        if o.kind != "erase" and o.img is not None and id(o) not in erased:
            paste(canvas, o.img, o.x, o.y)
    out = os.path.join(WORK, f"still-{idx}.png")
    canvas.convert("RGB").save(out)
    return out


def main(args):
    os.makedirs(WORK, exist_ok=True)
    scenes = build_scenes()
    if args[:1] == ["still"]:
        idxs = [int(a) for a in args[1:]] or range(len(scenes))
        sub = [scenes[i] for i in idxs]
        render_layers(sub)
        for i in idxs:
            scenes[i].ops = [Op(L) for L in scenes[i].layers]
            print(still(scenes, i))
        return
    render_layers(scenes)
    for sc in scenes:
        sc.ops = [Op(L) for L in sc.layers]
    hands = render_hands()
    ev, total = timeline(scenes)
    for (a, b, si) in ev["scene_spans"]:
        print(f"scene {si} {scenes[si].name:9s} {a:6.2f} - {b:6.2f}")
    print(f"total {total:.1f}s")
    if args[:1] == ["timing"]:
        for (st, p) in ev["vo"]:
            print(f"  vo at {st:6.2f}")
        return
    silent = os.path.join(WORK, "picture.mp4")
    render_video(scenes, ev, total, silent, hands)
    for voice, name in ((False, "sats-jar-draw-my-life-v3.mp4"),):
        wav = os.path.join(WORK, f"audio-{int(voice)}.wav")
        build_audio(ev, total, voice, wav)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", silent, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                        "-shortest", "-movflags", "+faststart", os.path.join(HERE, name)], check=True)
        print("wrote", name)


if __name__ == "__main__":
    main(sys.argv[1:])
