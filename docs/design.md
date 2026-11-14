# Design source of truth

The landing page (`app/landing/`) sets Sats Jar's look and voice. The web app wears the same look, so going from "Make a jar" into the app feels like one product. Every value below is read from `app/landing/landing.css`, `index.html` and `landing.js`.

## Audience and tone

- **Who:** a grandparent, parent, aunt or child who loves someone, not a crypto user (`docs/personas.md`). The landing says "a child you love", "Grandparents, aunties, friends", never "wallet", "NEAR" or "gas".
- **Voice:** warm, short, concrete. Second person ("Put Bitcoin in a jar for a child you love"). Sentences of one idea. Trust is stated plainly, not sold ("Sats Jar hides the plumbing, not the trust").
- **Words:** the glossary's (jar, top-up, allowance, guardian, handover, unlock date). "Bitcoin", "sats" and "Testnet demo" are fine. "Check it yourself" is the proof phrase.
- **Feel:** drawn by hand in crayon, black on white with a few pops of colour. Playful but never childish in what it says.

## Type

| Role | Font | Size | Notes |
|---|---|---|---|
| Display (h1) | Caveat Brush 400 | `clamp(3.3rem, 8.4vw, 6.9rem)`, line-height .98 | grain mask (`.grainy`) |
| Section heading (h2) | Caveat Brush 400 | `clamp(2.4rem, 5vw, 3.6rem)`, line-height 1 | grain mask |
| Card heading (h3) | Caveat Brush 400 | 1.75–1.9rem, line-height 1.1 | grain mask |
| Kicker | Caveat Brush | 1.45rem, blue, rotated −1.5° | one short line above a heading |
| Logo | Caveat Brush | 1.9rem, coin icon 44px rotated −8° | |
| Body | DM Sans 400 | 1.0625rem, line-height 1.55 | antialiased |
| Lede | DM Sans | 1.15–1.2rem, max 33–40rem wide | |
| Small / note | DM Sans | .95rem, muted | |
| Button | DM Sans 700 | 1.05rem, line-height 1 | |

Fonts load from Google Fonts: `Caveat Brush` and `DM Sans` (opsz 9..40, weights 400/500/700). Fallbacks: hand `"Segoe Print", "Bradley Hand", "Chalkboard SE", cursive`; body `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.

## Colour

| Token | Hex | Use on the landing |
|---|---|---|
| ink | `#141414` | text, borders, primary button fill |
| paper | `#ffffff` | page background |
| muted | `#55524d` | small print |
| orange | `#f59a1f` | primary button shadow, underline |
| yellow | `#f7c32a` | testnet dot, nav hover highlight, number swatch, "you're trusting" bullets |
| red | `#e8412f` | (frame art) |
| pink | `#f27aa8` | underline art |
| blue | `#2f6fd8` | kicker, focus ring |
| green | `#3a9d4f` | "you can check" bullets |
| lilac | `#b79bdc` | ghost button shadow, swatch |

Status colours the app needs and the landing doesn't have are drawn from this palette: done = green, refusal = red on a pale tint, waiting = yellow.

## Space and layout

- Page width 1180px on the landing (`--wrap`); gutter 1.25rem. Sections pad 3.5rem top and bottom.
- Grids collapse to one column under 900px; buttons go full width under 480px.
- Generous white space; nothing boxed in grey. Cards are hand-drawn frames (`frame-1..4.png`) slightly rotated (−1.5° to 1°), not ruled rectangles.

## Parts

- **Primary button:** ink fill, white text, 3px ink border, wobbly radius `16px 20px 14px 22px / 20px 14px 22px 16px`, padding 1rem 1.5rem, hard offset shadow `5px 5px 0 orange`.
- **Ghost button:** white fill, ink text, same border and radius, shadow `5px 5px 0 lilac`.
- **Pill (role picker):** white, 2px ink border, fully round, DM Sans 500 .95rem; pressed = ink fill, white text.
- **Testnet note:** a yellow blob dot with a 2px ink border, then muted text.
- **Bullets:** blob dots (`border-radius: 50% 40% 55% 45%`), green or yellow, 2px ink border.
- **Swatches and underlines:** crayon PNGs (`swatch-*.png`, `underline-*.png`) behind a word to highlight it.
- **Doodles:** small crayon stars, hearts, dots, spirals, absolutely placed, decorative only (`alt=""`).
- **Footer:** 3px ink rule on top.
- **Focus:** 3px blue outline, 3px offset, 6px radius.

## Motion

- Buttons: `transform` and `box-shadow` over .12s; hover lifts 2px up-left and grows the shadow to 8px; press pushes 3px down-right and shrinks the shadow to 1px.
- Nav links: a yellow highlighter sweeps in under the text (.2s).
- Pop-in: `cubic-bezier(.3, 1.5, .5, 1)` over .55s, a small overshoot.
- Everything decorative; `prefers-reduced-motion` turns transitions and animations off.
