# Sats Jar X posts

Drafts only. Nothing here has been posted. Every image is 1600×900 (16:9). The teaser video is 1080×1350 (4:5), 14 s, and loops cleanly: the jar fills, holds full, then fades back to empty.

NEAR's handle on X is **@NEARProtocol**.

## Warm-up teaser (post this first)

**Asset:** `01-teaser-jar-loop.mp4`

> Something patient is coming to @NEARProtocol

The word is "patient" because the jar waits for years, pays a little each month, and nobody can rush it. It's an odd word for a launch, so it makes people look twice. It's also the one claim the whole product keeps.

Backups:
- "Something little is coming to @NEARProtocol" (little ones, little coins)
- "Something for later is coming to @NEARProtocol" (Grandpa's line from the video)

Optional reply a day later, still without explaining:
> One coin today. A few more every birthday.
>
> It's not for you. It's for later.

## Launch thread

**1/** Asset: the Draw My Life video, or `09-grandpas-first-coin.png` until it's up.
> Meet Sats Jar: a piggy bank for a kid's real Bitcoin.
>
> Anyone who loves them can drop sats in. They get a little each month. On the day you choose, the whole jar becomes theirs, and no adult can touch it again.
>
> Live on testnet 👇

**2/** No asset.
> Today a kid's Bitcoin sits with an exchange, a relative, or a seed phrase in a drawer.
>
> Whoever holds it can spend it, lose it, or never hand it over.
>
> Families don't want a wallet. They want a jar with rules.

**3/** Asset: `06-handover.png`.
> The rules:
> • a capped allowance each period, only to the kid's address
> • emergencies need 2 guardians and wait out a public delay
> • at handover, every coin moves to an address only the kid's recovery phrase can reach

**4/** Asset: `02-zero-keys.png`.
> Who enforces the rules? Not us.
>
> The jar contract on @NEARProtocol has zero access keys. It builds each Bitcoin payment itself and asks NEAR's MPC network to sign it, only when the rules say yes.
>
> Native Bitcoin. Nothing wrapped.

**5/** Asset: `08-demo-timing.png`.
> Don't trust a thread. Jar 1 lived its whole life on testnet in one evening: top-up, allowance, emergency payment, handover, and every refused attempt.
>
> Each step links to the explorer. [README Testnet proof link]

**6/** Asset: `03-refusals.png`.
> Try to break it yourself. Open jar 1's public record, press "Spend it without holding it", and watch the contract say no.
>
> app.satsjar.app/proof/1

## Standalone posts

| Post | Asset |
|---|---|
| The story ("Grandpa put in the first coin…") | `09-grandpas-first-coin.png` |
| The number zero | `02-zero-keys.png` |
| Refusals ("Our favourite feature is the word no") | `03-refusals.png` |
| Why a jar (four ways to save) | `04-ways-to-save.png` |
| For relatives ("Grandma doesn't need a new app") | `05-relatives-top-up.png` |
| Handover | `06-handover.png` |
| Demo timing | `08-demo-timing.png` |
| Roadmap and feedback | `07-roadmap.png` |
| No crypto UX, honest gaps, engagement question, gift angle | text only |
| Behind the scenes ("Why crayons?") | a clip from the Draw My Life video |

## Check before posting

- Open each link first. The README says `satsjar.app` and `app.satsjar.app`, but the repo's homepage is `sats-jar-two.vercel.app`.
- Don't post anything about yield. The README roadmap doesn't include it.
- `09-grandpas-first-coin.png` is a still from the v3 video. If the video changes, take a new still.

To rebuild the cards: `python3 social/make_cards.py`. To rebuild one card: `python3 social/make_cards.py 07-roadmap`.
