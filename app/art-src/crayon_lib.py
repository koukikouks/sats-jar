"""Crayon stroke helpers for the landing-page art.

Each stroke is drawn as a bundle of fine parallel streaks that drop out along their length,
which is how wax catches on paper's tooth. Output is plain SVG path strings.
"""
import math, random

rad = math.radians


def smooth(n, amp, step=7):
    k = n // step + 3
    v = [random.uniform(-amp, amp) for _ in range(k)]
    out = []
    for i in range(n):
        t = i / step; a = int(t); f = t - a; f = f * f * (3 - 2 * f)
        out.append(v[a] * (1 - f) + v[a + 1] * f)
    return out


def path(pts):
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)


def stroke(pts, color, w, op=0.9):
    pts = [tuple(p) for p in pts]
    n = len(pts)
    if n < 2:
        return ""
    if w < 3:
        return f'<path d="{path(pts)}" stroke="{color}" stroke-width="{w:.1f}" opacity="{op:.2f}"/>'
    K = max(3, int(round(w / 2.0)))
    norms = []
    for i in range(n):
        a = pts[max(0, i - 1)]; b = pts[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1
        norms.append((-dy / L, dx / L))
    out = []
    for k in range(K):
        off = ((k + .5) / K - .5) * w + random.uniform(-.25, .25) * w / K
        i0 = int(random.uniform(0, .05) * n); i1 = n - int(random.uniform(0, .06) * n)
        seg = [(pts[i][0] + norms[i][0] * off, pts[i][1] + norms[i][1] * off) for i in range(i0, max(i0 + 2, i1))]
        Lt = sum(math.dist(seg[j], seg[j + 1]) for j in range(len(seg) - 1))
        da = []; t = 0
        while t < Lt:
            on = w * random.uniform(2, 9); da.append(on); t += on
            g = w * random.uniform(.1, .7) if random.random() < .7 else 0.01
            da.append(g); t += g
        o = op * random.uniform(.55, 1)
        out.append(f'<path d="{path(seg)}" stroke="{color}" stroke-width="{w / K * 1.7:.2f}" opacity="{o:.2f}" '
                   f'stroke-linecap="butt" stroke-dasharray="{" ".join(f"{d:.1f}" for d in da)}"/>')
    return "\n".join(out)


def quad(p0, p1, p2, n=14):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in [i / n for i in range(n + 1)]]


def jitter(pts, amp, dense=5):
    d = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        k = max(1, int(math.dist(a, b) / dense))
        for i in range(1, k + 1):
            d.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    o = smooth(len(d), amp); o2 = smooth(len(d), amp)
    return [(p[0] + o[i], p[1] + o2[i]) for i, p in enumerate(d)]


def brk_line(pts, cols, w, passes=2, amp=2.0, dense=5, seg=(7, 16)):
    """A hand-drawn line: a few wobbly passes, each lifted slightly now and then."""
    cols = cols if isinstance(cols, (list, tuple)) else [cols]
    out = []
    for _ in range(passes):
        d = jitter(pts, amp, dense=dense); i = 0
        while i < len(d) - 2:
            L = random.randint(*seg); sg = d[i:i + L + 1]
            if len(sg) > 1:
                out.append(stroke(sg, random.choice(cols), w * random.uniform(.8, 1.2), random.uniform(.82, .97)))
            i += L + random.choice([0, 0, 0, 0, 1])
    return "\n".join(out)


def ring(c, R, cols, w, passes=2, wob=2, rx=None, ry=None):
    """Closed loop drawn in lifted arcs (circle or ellipse)."""
    cols = cols if isinstance(cols, (list, tuple)) else [cols]
    rx = rx or R; ry = ry or R
    out = []
    for _ in range(passes):
        a = random.uniform(0, 6.28); tot = 0
        while tot < 6.28 * random.uniform(.97, 1.12):
            L = random.uniform(1.2, 2.6); n = 34; o = smooth(n + 1, wob)
            pts = [(c[0] + (rx + o[i]) * math.cos(a + L * i / n), c[1] + (ry + o[i]) * math.sin(a + L * i / n)) for i in range(n + 1)]
            out.append(stroke(pts, random.choice(cols), w * random.uniform(.8, 1.2), random.uniform(.82, .97)))
            a += L + random.uniform(.02, .1); tot += L + .06
    return "\n".join(out)


def hatch_poly(poly, ang, sp, colors, w, over=2.5):
    """Fill a polygon with back-and-forth crayon hatching."""
    ca, sa = math.cos(-ang), math.sin(-ang)
    rp = [(x * ca - y * sa, x * sa + y * ca) for x, y in poly]
    ys = [p[1] for p in rp]; y = min(ys) + sp / 2; out = []; flip = False
    ca2, sa2 = math.cos(ang), math.sin(ang)
    while y < max(ys):
        xs = []; n = len(rp)
        for i in range(n):
            (x1, y1), (x2, y2) = rp[i], rp[(i + 1) % n]
            if (y1 <= y < y2) or (y2 <= y < y1):
                xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for a, b in zip(xs[0::2], xs[1::2]):
            a += random.uniform(-over * .4, over); b -= random.uniform(-over * .4, over)
            if b - a < 3:
                continue
            m = max(3, int((b - a) / 6)); o = smooth(m + 1, 1.6)
            pts = [(a + (b - a) * i / m, y + o[i]) for i in range(m + 1)]
            pts = [(px * ca2 - py * sa2, px * sa2 + py * ca2) for px, py in pts]
            if flip:
                pts.reverse()
            out.append(stroke(pts, random.choice(colors), w * random.uniform(.85, 1.15), random.uniform(.8, .97)))
            flip = not flip
        y += sp * random.uniform(.85, 1.15)
    return "\n".join(out)


def hatch_circle(c, R, ang, sp, colors, w, keep=None, over=(-3, 2)):
    d = (math.cos(ang), math.sin(ang)); nn = (-d[1], d[0]); out = []; s = -R + 3; flip = False
    while s < R - 2:
        h = math.sqrt(max(R * R - s * s, 1))
        a = random.uniform(*over); b = random.uniform(*over)
        m = 24
        pts = [[c[0] + s * nn[0] + (-h - a + (2 * h + a + b) * i / m) * d[0],
                c[1] + s * nn[1] + (-h - a + (2 * h + a + b) * i / m) * d[1]] for i in range(m + 1)]
        if keep:
            thr = random.uniform(-45, 45); run = []; best = []
            for p in pts:
                if keep(p, thr):
                    run.append(p)
                else:
                    if len(run) > len(best): best = run
                    run = []
            if len(run) > len(best): best = run
            pts = best
        if len(pts) >= 2:
            if flip: pts.reverse()
            o = smooth(len(pts), 2.2)
            pts = [(p[0] + nn[0] * o[i], p[1] + nn[1] * o[i]) for i, p in enumerate(pts)]
            out.append(stroke(pts, random.choice(colors), w * random.uniform(.8, 1.15), random.uniform(.78, .97)))
        flip = not flip; s += sp * random.uniform(.8, 1.2)
    return "\n".join(out)


def rrect(x0, y0, x1, y1, r):
    pts = []
    for (cx, cy, a0) in [(x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)]:
        for i in range(7):
            a = rad(a0 + 90 * i / 6); pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def svg_doc(w, h, body, seed=1, grain=0.5):
    """Wrap strokes in an SVG with a light paper-tooth mask (the wax skipping) and rough edges."""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
<defs><filter id="wax" filterUnits="userSpaceOnUse" x="0" y="0" width="{w}" height="{h}">
<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="{seed}" result="w"/>
<feDisplacementMap in="SourceGraphic" in2="w" scale="4" result="d"/>
<feTurbulence type="fractalNoise" baseFrequency="{grain}" numOctaves="3" seed="{seed + 20}" result="g"/>
<feColorMatrix in="g" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3.4 0 0 0 -0.55" result="m"/>
<feComposite in="d" in2="m" operator="in"/></filter></defs>
<g filter="url(#wax)" fill="none" stroke-linecap="round" stroke-linejoin="round">
{body}
</g></svg>
'''
