# Bitcoin testnet3, with NEAR's maintained light client, proves deposits

R6 needs the contract to see that a top-up really exists on Bitcoin and is confirmed. On NEAR testnet the only maintained Bitcoin light client is `btc-client-v4.testnet`, the one Omni Bridge's testnet connector uses, and it tracks testnet3 within a few blocks. The only testnet4 instance stopped in August 2026. So the demo runs on testnet3, and the contract checks each top-up with a cross-contract call to that client (`verify_transaction_inclusion_with_heights`, the method satoshi-bridge uses now; the older `verify_transaction_inclusion` is open to a 64-byte-transaction proof forgery) and counts confirmations itself. The mainnet equivalent is `btc-client.bridge.near`, the client NEAR's own Bitcoin bridge relies on.

## Consequences

- The README must name what this trusts (R14): the client's single full-access key, its three pause managers, and its one permitted relayer (`btc-relayer.testnet`), checked 2026-11-05.
- Proofs only work for blocks the client still keeps (52,704 headers), which is ample for the demo.
- testnet3 faucets are scarcer than testnet4 ones and gated by CAPTCHAs, which the maintainer clears by hand.

## Considered Options

- testnet4 with our own light client and relayer: days of extra work, and it adds us as a trusted party. Rejected.
- signet: no light client found on NEAR testnet. Rejected.
