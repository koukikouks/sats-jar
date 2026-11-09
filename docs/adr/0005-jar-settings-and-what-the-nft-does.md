# Jar settings; the NFT shows the jar's life

The settings:

- **Unlock** at the date the giver sets, suggested as the child's 18th birthday. Only the date is stored.
- **Allowance:** up to the cap once per period of 30 days, paid automatically. The first period starts when the jar's first top-up is confirmed, not when the jar is created, so an empty jar builds up no allowance. Unused allowance carries over, so a family loses nothing when a payment waits, but at most three periods' allowance (3 × cap, the current period included) can be waiting at once. Anything beyond that lapses, so a long gap can never become a lump sum.
- **Guardians:** 2–3, named at creation. The giver may be one of them.
- **Emergency payment:** only to the child's address, at most three periods' allowance (3 × cap, so three months' for a monthly jar), approved by 2 guardians, then a 30-day public delay. The giver can cancel it during the delay. If the giver is gone, it goes through after the delay; it can still only pay the child, capped.
- **Child's address** is fixed until unlock. A changeable address would let adults redirect the money, and the claim is "to one fixed address" (R14).
- **Fees** come from the jar, never from the child's payment, and all fees in one period together never exceed 10% of the cap. If Bitcoin fees are higher, the payment waits and the allowance carries over. A payment smaller than half the cap (because the jar holds too little) is refused and waits for more top-ups, so nobody can turn small top-ups into fees by triggering many small payments. So high Bitcoin fees can never eat a child's allowance.
- **Bitcoin-only exit** two years after the unlock date (or after a re-homing), on Bitcoin alone (ADR 0006).
- **Jar name** is a nickname the giver picks, shown with a note that it is public. Never a child's full name.
- **Demo timing:** a jar can be created with shortened time (for example a 10-minute period and a 1-hour unlock), badged "Demo timing" everywhere it shows, so the flow can be shown honestly on camera (O21).

**What the NFT does** (O4), so the track is never a costume: the jar NFT is the account that owns the Bitcoin and carries the rule. Its image is generated on chain from the jar's state (a jar that fills as Bitcoin arrives, with balance, next allowance and unlock date), so it changes as the jar lives (dynamic NFT). Each jar has a history: what came in, what was paid out, what was refused, and who has held it. The family's jar page opens only for the holder's account and the guardians. The family account and the child's account are sub-accounts of the app's account, which uses the track's sub-account hint without users ever seeing it. Who holds the jar when is set by handover (ADR 0009).
