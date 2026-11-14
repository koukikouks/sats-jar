"""Image cards for the Sats Jar X posts.

Builds one 1600x900 HTML page per card (the landing page's black-on-white with crayon pops,
crayon marks drawn with app/art-src/crayon_lib.py) and screenshots each with headless Chrome.
Run from the repo root:  python3 social/make_cards.py
"""
import math, os, random, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app", "art-src"))
from crayon_lib import brk_line, ring, hatch_poly, quad, svg_doc  # noqa: E402

OUT = os.path.join(ROOT, "social")
TMP = os.environ.get("CARD_TMP", "/tmp/sats-jar-cards")
ASSETS = "file://" + os.path.join(ROOT, "app", "assets")
FONT = open(os.path.join(ROOT, "video", "archivo-embed.css")).read()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

INK, ORANGE, RED, BLUE, GREEN = "#141414", "#f59a1f", "#e8412f", "#2f6fd8", "#3a9d4f"
W, H = 1600, 900
# Animation support: page() appends this CSS. "" shows everything; social/animate.py sets it to
# hide the [data-layer] parts (the base frame) or to show one layer alone on a clear background.
LAYER_CSS = [""]


def svg(w, h, body, seed, style=""):
    doc = svg_doc(w, h, body, seed=seed).replace("<svg ", f'<svg style="{style}" ', 1)
    return doc


def cross(cx, cy, r, seed):
    random.seed(seed)
    b = brk_line([(cx - r, cy - r), (cx + r, cy + r)], [RED, "#c9311f"], 9, passes=2, amp=1.5)
    b += brk_line([(cx + r, cy - r), (cx - r, cy + r)], [RED, "#c9311f"], 9, passes=2, amp=1.5)
    return b


def check(cx, cy, r, seed):
    random.seed(seed)
    return brk_line([(cx - r, cy), (cx - r * .25, cy + r * .75), (cx + r, cy - r * .8)], [GREEN, "#2f8a42"], 10, passes=2, amp=1.5)


def no_stamp(cx, cy, seed):
    random.seed(seed)
    return ring((cx, cy), 0, [RED, "#c9311f"], 7, passes=2, wob=2.5, rx=74, ry=48)


def page(body, extra_css=""):
    return f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
<style>{FONT}
*{{box-sizing:border-box}} html,body{{margin:0;width:{W}px;height:{H}px;overflow:hidden}}
body{{background:#fff;color:{INK};font-family:"DM Sans",system-ui,sans-serif;position:relative}}
.d{{font-family:ArchivoEmbed,Archivo,sans-serif;font-weight:800;letter-spacing:-.025em;line-height:1.02;margin:0}}
.foot{{position:absolute;left:80px;bottom:56px;display:flex;align-items:center;gap:14px;font-family:ArchivoEmbed;font-weight:800;font-size:30px;letter-spacing:-.02em}}
.foot img{{width:46px;height:46px}} .foot span{{font-family:'DM Sans';font-weight:500;font-size:22px;color:#5b5852;letter-spacing:0;margin-left:10px}}
.abs{{position:absolute}} p{{margin:0}}
{extra_css}{LAYER_CSS[0]}</style></head><body>{body}
<div class="foot"><img src="{ASSETS}/coin-2.png">Sats Jar<span>testnet</span></div>
</body></html>"""


def card_zero():
    random.seed(4)
    o = ring((300, 300), 0, [ORANGE, "#e88a10"], 14, passes=3, wob=5, rx=250, ry=270)
    return page(f"""
<div class="abs" style="left:150px;top:90px;width:600px;height:600px">
 <div data-layer="ring" style="position:absolute;inset:0">{svg(600, 600, o, 4, "position:absolute;inset:0")}</div>
 <div class="d" style="position:absolute;inset:0;display:grid;place-items:center;font-size:440px;padding-bottom:20px">0</div>
</div>
<div class="abs" style="left:860px;top:230px;width:660px">
 <p class="d" style="font-size:78px">access keys on the jar contract.</p>
 <p style="font-size:34px;line-height:1.4;margin-top:34px;color:#3a3833">Nobody can redeploy it or sign as it. Not even us. It asks NEAR's MPC network to sign, and only when the rules say yes.</p>
</div>""")


def card_refusals():
    rows = [("SPEND_BEFORE_HANDOVER", "An outsider tried to spend jar 1 early."),
            ("NOT_A_GUARDIAN", "An outsider tried to approve an emergency payment."),
            ("NOT_THE_HOLDER", "After handover, the parent tried to spend.")]
    html = ""
    for i, (code, txt) in enumerate(rows):
        y = 290 + i * 160
        st = no_stamp(80, 55, 30 + i)
        html += f"""<div class="abs" style="left:80px;top:{y}px;width:1440px;height:120px;display:flex;align-items:center;gap:40px">
 <div data-layer="s{i}" style="position:relative;width:160px;height:110px;flex:none">{svg(160, 110, st, 30 + i, "position:absolute;inset:0")}
  <div class="d" style="position:absolute;inset:0;display:grid;place-items:center;color:{RED};font-size:46px;transform:rotate(-6deg)">NO</div></div>
 <div data-layer="t{i}"><p style="font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:34px">{code}</p>
 <p style="font-size:30px;color:#3a3833;margin-top:6px">{txt}</p></div></div>"""
    return page(f"""<p class="d abs" style="left:80px;top:90px;font-size:92px">Our favourite feature is “no”.</p>
<p class="abs" style="left:82px;top:200px;font-size:30px;color:#5b5852">Every refusal is on chain. Open jar 1's public record and try one yourself.</p>{html}""")


def card_ways():
    rows = [("An exchange account", "the exchange holds it", False),
            ("A seed phrase in a drawer", "it gets lost, or found", False),
            ("A shared wallet", "that relative can spend it", False),
            ("A Sats Jar", "a fixed rule, then it's theirs alone", True)]
    html = ""
    for i, (a, b, ok) in enumerate(rows):
        y = 250 + i * 128
        mark = check(40, 40, 28, 50 + i) if ok else cross(40, 40, 24, 50 + i)
        hl = f"background:url({ASSETS}/swatch-yellow.png) center/100% 100% no-repeat;padding:4px 18px;margin-left:-18px;" if ok else ""
        html += f"""<div class="abs" style="left:80px;top:{y}px;display:flex;align-items:center;gap:34px">
 {svg(80, 80, mark, 50 + i, "width:80px;height:80px;flex:none")}
 <p class="d" style="font-size:52px;{hl}">{a}</p><p style="font-size:34px;color:#5b5852">{b}</p></div>"""
    return page(f"""<p class="d abs" style="left:80px;top:90px;font-size:84px">Saving Bitcoin for a kid?</p>{html}
<img class="abs" src="{ASSETS}/jar.png" style="right:70px;top:300px;height:400px;opacity:.95">
<img class="abs" src="{ASSETS}/coin-1.png" style="right:150px;top:570px;width:100px;transform:rotate(-14deg)">
<img class="abs" src="{ASSETS}/coin-3.png" style="right:105px;top:495px;width:92px;transform:rotate(12deg)">""")


def card_art(img, title, lines, underline):
    return page(f"""<img class="abs" src="{ASSETS}/{img}" style="left:40px;top:120px;width:880px">
<div class="abs" style="left:940px;top:200px;width:600px">
 <p class="d" style="font-size:76px">{title}</p>
 <img src="{ASSETS}/{underline}" style="width:420px;margin:18px 0 26px">
 {''.join(f'<p style="font-size:34px;line-height:1.38;color:#3a3833;margin-bottom:16px">{l}</p>' for l in lines)}
</div>""")


def card_roadmap():
    random.seed(9)
    pts = quad((200, 440), (500, 240), (800, 520), 40) + quad((800, 520), (1100, 260), (1400, 400), 40)[1:]
    dots = ""
    for i in range(0, len(pts) - 1, 2):
        dots += brk_line([pts[i], pts[i + 1]], [INK], 5, passes=1, amp=.6)
    pins = ""
    stops = [(200, 440, ORANGE), (800, 520, BLUE), (1400, 400, GREEN)]
    for i, (x, y, c) in enumerate(stops):
        random.seed(70 + i)
        pin = hatch_poly([(x + 22 * math.cos(a / 8 * 6.283), y + 22 * math.sin(a / 8 * 6.283)) for a in range(8)], .6, 6, [c], 6)
        pin += ring((x, y), 26, [INK], 4, passes=1, wob=1.5)
        pins += f'<div data-layer="p{i}" class="abs" style="inset:0">{svg(W, H, pin, 70 + i, "position:absolute;inset:0")}</div>'
    labels = [(110, 495, "Mainnet", "real coins, not test ones"),
              (710, 575, "Face ID", "unlock without a PIN"),
              (1150, 455, "Top up with any coin", "through NEAR Intents, so a relative with no Bitcoin can still give")]
    lab = "".join(f'<div data-layer="l{i}" class="abs" style="left:{x}px;top:{y}px;width:{390 if i == 2 else 330}px"><p class="d" style="font-size:44px">{t}</p><p style="font-size:26px;color:#5b5852;margin-top:6px;line-height:1.35">{s}</p></div>'
                  for i, (x, y, t, s) in enumerate(labels))
    return page(f"""<p class="d abs" style="left:80px;top:80px;font-size:84px">Next on the map</p>
<div data-layer="path" class="abs" style="inset:0">{svg(W, H, dots, 9, "position:absolute;inset:0")}</div>{pins}{lab}
<p data-layer="cta" class="abs d" style="right:80px;bottom:56px;font-size:34px">What should we build next? ↓</p>""")


def card_header():
    """X profile header, 1500x500. X covers the bottom-left with the avatar, so text sits right."""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{FONT}
html,body{{margin:0;width:1500px;height:500px;overflow:hidden;background:#fff}}
.d{{font-family:ArchivoEmbed;font-weight:800;letter-spacing:-.025em;line-height:1.04;margin:0;color:{INK}}}</style></head><body>
<img src="{ASSETS}/step-2.png" style="position:absolute;left:330px;top:40px;height:430px">
<div style="position:absolute;left:1000px;top:150px;width:460px">
<p class="d" style="font-size:64px">Some gifts grow up with you.</p>
<img src="{ASSETS}/underline-orange.png" style="width:330px;margin-top:14px"></div>
</body></html>"""


def card_timing():
    return page(f"""<p class="abs" style="left:80px;top:110px;font-size:34px;color:#5b5852">On testnet, a jar lives its whole life in one evening.</p>
<p class="d abs" style="left:80px;top:190px;font-size:200px">1 month</p>
<p class="d abs" style="left:80px;top:400px;font-size:200px">= 10 minutes</p>
<img class="abs" src="{ASSETS}/underline-orange.png" style="left:80px;top:610px;width:1150px">
<p class="abs" style="left:80px;top:690px;font-size:34px;color:#3a3833;width:1300px">16 steps, from making the jar to handing it over. Each one a transaction you can open.</p>
<img class="abs" src="{ASSETS}/doodle-star.png" style="right:120px;top:150px;width:150px;transform:rotate(12deg)">""")


CARDS = {
    "02-zero-keys": card_zero,
    "03-refusals": card_refusals,
    "04-ways-to-save": card_ways,
    "05-relatives-top-up": lambda: card_art("step-2.png", "Grandma doesn't need a new app.",
                                            ["Scan the jar's QR from any Bitcoin wallet or exchange app.",
                                             "3 blocks deep, and it counts."], "underline-blue.png"),
    "06-handover": lambda: card_art("step-3.png", "Then it's theirs alone.",
                                    ["12 words on their own phone.", "2 guardians check in person.",
                                     "A public delay. Then every coin moves to an address only they can reach."], "underline-pink.png"),
    "07-roadmap": card_roadmap,
    "12-set-the-rules": lambda: card_art("step-1.png", "Set the rules once.",
                                         ["Who it's for, a monthly cap, the day it unlocks, and 2 or 3 guardians.",
                                          "After that, nobody can change them. Not even you."], "underline-orange.png"),
    "08-demo-timing": card_timing,
}

CARDS["13-x-header"] = card_header
SIZES = {"13-x-header": (1500, 500)}


def main():
    os.makedirs(TMP, exist_ok=True)
    only = sys.argv[1:]
    for name, fn in CARDS.items():
        if only and name not in only:
            continue
        html = os.path.join(TMP, name + ".html")
        open(html, "w").write(fn())
        png = os.path.join(OUT, name + ".png")
        w, h = SIZES.get(name, (W, H))
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        f"--window-size={w},{h}", "--virtual-time-budget=4000", "--allow-file-access-from-files",
                        f"--screenshot={png}", "file://" + html], check=True, capture_output=True)
        print("wrote", png)


if __name__ == "__main__":
    main()
