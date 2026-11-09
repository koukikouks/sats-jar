# Jar NFT is locked until unlock, then fully transferable

> Amended by ADR 0009: the jar first changes hands at handover, from the family account to the child's account; it is freely transferable only after that.

The nfts track's example centres on selling an NFT that owns a wallet. A jar that can change hands before unlock could be sold or phished, and whoever holds it at unlock takes the child's Bitcoin, so the jar NFT cannot be transferred before the unlock date (R13). From unlock on it is an ordinary NFT that controls its Bitcoin: transferring it moves control of the coins, and the track's seller threat model and transfer tests (including a sale in the middle of a payout) apply to post-unlock jars and to the handover at unlock itself.

## Considered Options

- Transferable before unlock, with the rule riding along: matches the track prompt literally but lets a buyer or phisher collect everything at unlock. Rejected.
