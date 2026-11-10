# Stack notes (researched 2026-11-08)

Primary sources only: crates.io / npm metadata, upstream source at pinned commits, specs, and live testnet calls. Lines marked **measured** were run during this research (scratch code, not in the repo); the method is given so they can be rerun.

Short link names used below:
`MPC` = [near/mpc @ 3.18.0](https://github.com/near/mpc/tree/3.18.0) ·
`LC` = [Near-One/btc-light-client-contract @ ac30f6a](https://github.com/Near-One/btc-light-client-contract/tree/ac30f6afd53e2f1f64158deff62832499ec123d6) ·
`SDK` = [near/near-sdk-rs @ bacd081](https://github.com/near/near-sdk-rs/tree/bacd081a0bd648d840b814dab7677e1f3330afbb) ·
`CN` = [near/cargo-near @ c8facb8](https://github.com/near/cargo-near/tree/c8facb827d10feb4aeef571a0d6a4ec044097d0c) ·
`NW` = [near/near-workspaces-rs @ d2e8efc](https://github.com/near/near-workspaces-rs/tree/d2e8efc8785d12562db5a58a8ba142e1e559a921)

## Decision table

| Area | Choice | Pin |
|---|---|---|
| Contract SDK | near-sdk, features `["unstable"]` (only for `env::ecrecover`) | `near-sdk = "=5.30.1"`, `rust-toolchain.toml` channel `1.95.0` |
| Reproducible build | cargo-near Docker build, image from the `cargo near new` template | `sourcescan/cargo-near:0.22.0-rust-1.99.1` @ `sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb` |
| Contract tests | near-workspaces (sandbox 2.14.0 downloaded automatically) | `near-workspaces = "=0.24.0"` |
| Bitcoin tx building in the contract | Hand-rolled serialisation + BIP-143, hashing via `env::sha256_array` / `env::ripemd160_array` | `near-sdk-env = "=0.1.9"` in `btc/` (the leaf crate behind `near_sdk::env`; near-sdk itself will not build as a plain native dependency) |
| Bitcoin oracle in native tests | `bitcoin` crate as a dev-dependency only | `bitcoin = "=0.32.11"` |
| Jar key derivation in the contract | `k256` point arithmetic + `env::sha3_256` | `k256 = { version = "=0.13.4", default-features = false, features = ["arithmetic"] }` (same as MPC) |
| Signature check | `env::ecrecover(.., malleability_flag = true)` vs the stored derived key | (needs near-sdk `unstable`) |
| Regtest | `bitcoind` crate (renamed from `corepc-node`), auto-download | `bitcoind = { version = "=0.43.2", features = ["download", "30_2"] }`; no `brew install bitcoin` |
| TS NEAR library | near-api-js v7 (single package; not `@near-js/*`) | `near-api-js@7.4.0` (Node ≥ 22.22.2) |
| TS crypto | `@scure/bip39`, `@scure/bip32`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/btc-signer` | all `2.4.0` except `@scure/btc-signer@2.4.1` |
| NEAR HD key | SLIP-10 ed25519 at `m/44'/397'/0'`, hand-written on `@noble/hashes` (≈15 lines), cross-checked against near-api-js | — |
| Proof view: NEAR tx list | FastNEAR tx API (`tx.test.fastnear.com/v0/account`) or NearBlocks **v3** via the backend; error text from NEAR RPC `EXPERIMENTAL_tx_status` | — |
| Proof view: Bitcoin | mempool.space testnet3 (`/testnet/api`); Blockstream Esplora as fallback (same API shape) | — |
| Accounts | Sub-account of the app account; zero-balance account (182 bytes), so 0 NEAR needed | — |
| Testnet dev deploy and scripts | near-cli-rs (faucet account, deploy) + Node scripts on near-api-js and `@scure/btc-signer` (`scripts/`) | near-cli-rs 0.30.1 |

## 1. near-sdk-rs

- **Version.** Latest stable is 5.30.1 (2026-11-05); 5.30.0 (2026-10-27) is the "stable release for nearcore 2.14", and its MSRV is **Rust 1.95** ([crates.io](https://crates.io/crates/near-sdk), [SDK CHANGELOG](https://github.com/near/near-sdk-rs/blob/bacd081a0bd648d840b814dab7677e1f3330afbb/CHANGELOG.md)). Testnet runs nearcore 2.14.0-rc.5 at protocol 88 (live RPC `status`, 2026-11-08).
- **Features.** Defaults are fine. `env::ecrecover` is behind `#[cfg(feature = "unstable")]` ([SDK env.rs L595](https://github.com/near/near-sdk-rs/blob/bacd081a0bd648d840b814dab7677e1f3330afbb/near-sdk/src/environment/env.rs#L595)); the MPC contract itself enables `unstable` ([MPC Cargo.toml L186](https://github.com/near/mpc/blob/3.18.0/Cargo.toml#L186)). `sha256_array`, `ripemd160_array` and `sha3_256` are ungated ([SDK env.rs L39](https://github.com/near/near-sdk-rs/blob/bacd081a0bd648d840b814dab7677e1f3330afbb/near-sdk/src/environment/env.rs#L39)). The template puts `unit-testing` in dev-dependencies ([CN template](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near/src/commands/new/new-project-template/Cargo.template.toml)), but **don't**: in this workspace it mocks `near-sdk-env`'s host functions for every crate, and the `btc` tests then fail to link (`_sha256`, `_read_register`). Use `non-contract-usage` instead. Contract test dev-dependencies: `cargo-near-build = "=0.11.5"` (builds the wasm per feature set) and `tokio = "=1.54.1"`. NFT view tests (T09) add `near-contract-standards = "=5.30.1"` (NEP-171/177 reference types and their `assert_valid`, the oracle for the views' shape; it turns on near-sdk's `legacy` feature, which only exposes `near_sdk::collections`, in test builds only, never in the wasm) and `roxmltree = "=0.21.2"` (pure-Rust XML parser for the jar's SVG). The contract itself writes the NEP types by hand and base64 through `near_sdk::base64` (re-exported), so it gains no dependency. Don't enable `universal-accounts` (needs protocol 88 on every network and links an extra host function, [SDK Cargo.toml L117](https://github.com/near/near-sdk-rs/blob/bacd081a0bd648d840b814dab7677e1f3330afbb/near-sdk/Cargo.toml#L117)).
- **Size limits (live testnet `EXPERIMENTAL_protocol_config`).** `max_contract_size` is 4 MiB, but `max_transaction_size` is **1.5 MiB (1,572,864 B)**, so a deploy in one transaction must stay under about 1.5 MiB. `max_function_body_size` is 192 KiB. `max_total_prepaid_gas` is 1,000 TGas. `yield_timeout_length_in_blocks` is 200.
- **Keeping it small.** Use the template's release profile: `codegen-units = 1`, `opt-level = "z"`, `lto = true`, `debug = false`, `panic = "abort"`, `overflow-checks = true` ([CN template](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near/src/commands/new/new-project-template/Cargo.template.toml)). cargo-near runs `wasm-opt` for size automatically ([CN build/mod.rs L405](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near-build/src/near/build/mod.rs#L405)). NEAR's docs also suggest dropping `rlib` and replacing `unwrap`/`expect`/`assert!` with `env::panic_str` ([docs: production builds](https://docs.near.org/smart-contracts/anatomy/reduce-size)).
- **Measured sizes** (near-sdk 5.30.1, Rust 1.95.0, `cargo near build non-reproducible-wasm --no-abi`): baseline contract 54.9 KB; plus hand-rolled BIP-143 and DER, 61.3 KB; plus `bitcoin` 0.32.11, 78.8 KB; plus k256 ECDSA verify, 96.7 KB; k256 derivation plus hand-rolled together, 128.9 KB. Size is not the constraint.

**Gotchas**
1. The local default toolchain must be ≥ 1.95. Commit a `rust-toolchain.toml` pinning `1.95.0` (the template does, [CN template toolchain](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near/src/commands/new/new-project-template/rust-toolchain.toml)).
2. `env::ecrecover` needs the `unstable` feature. Pin near-sdk exactly (`=5.30.1`) so an `unstable` API change can't slip in.
3. The 1.5 MiB transaction limit, not the 4 MiB contract limit, is the practical ceiling.

## 2. cargo-near reproducible builds

```toml
[package]
repository = "https://github.com/koukikouks/sats-jar"   # NEP-330 link, shown by contract_source_metadata

[package.metadata.near.reproducible_build]
image = "sourcescan/cargo-near:0.22.0-rust-1.99.1"
image_digest = "sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb"
passed_env = []
container_build_command = ["cargo", "near", "build", "non-reproducible-wasm", "--locked"]
```

This is the exact block in today's `cargo near new` template ([CN template](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near/src/commands/new/new-project-template/Cargo.template.toml)), and the digest matches Docker Hub for that tag ([Docker Hub tags API](https://hub.docker.com/v2/repositories/sourcescan/cargo-near/tags)). A newer `0.23.0-rust-1.99.1` image (2026-11-06, `sha256:8013f039…`) exists, but 0.23.0 only bumps nearcore crates for deploy/RPC, with "no source changes" to building ([cargo-near PR #469](https://github.com/near/cargo-near/pull/469), [CN CHANGELOG](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/CHANGELOG.md)). So stay on 0.22.0, which is three weeks old. Local cargo-near 0.22.0 is fine.

- **Build:** run `cargo near build reproducible-wasm`. It clones the committed tree (uncommitted changes are ignored) and needs `Cargo.lock` committed ([CN README](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/README.md)). It prints the wasm's "SHA-256 checksum bs58" ([CN side_effects.rs L22](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/cargo-near-build/src/types/near/build/side_effects.rs#L22)).
- **Verify a deployed hash:** RPC `query` → `view_account` returns `code_hash`, the base58 SHA-256 of the deployed wasm. It must equal the checksum above. `near view <acct> contract_source_metadata` shows the NEP-330 build info (image, commit, command) ([docs: reproducible builds](https://docs.near.org/smart-contracts/anatomy/reproducible-builds), [NEP-330](https://github.com/near/NEPs/blob/master/neps/nep-0330.md)). Third parties can rebuild with [near-verify-rs](https://github.com/near/near-verify-rs) (v0.3.4) or NearBlocks "Verify and Publish".

**Gotchas**
1. The image is **linux/amd64 only** ([Docker Hub tag](https://hub.docker.com/v2/repositories/sourcescan/cargo-near/tags/0.22.0-rust-1.99.1)); on an arm64 Mac, Docker emulates it, so the build is slow. Do a dry run well before the locked deploy (see the measured result below).
2. Commit first. The build uses `HEAD`, so a dirty tree silently builds the old code.
3. `passed_env` must stay empty for NearBlocks/SourceScan verification ([CN README](https://github.com/near/cargo-near/blob/c8facb827d10feb4aeef571a0d6a4ec044097d0c/README.md)). Testnet-vs-regtest settings belong in init args, not in build-time env.

**Measured:** I built a scratch near-sdk 5.30.1 + k256 contract with exactly this block, on an arm64 Mac (Docker 27.5, emulated amd64). It took about 80 s, including the image pull. Two clean rebuilds gave the identical bs58 checksum. The host cargo-near 0.22.0 only drives Docker; the container's own cargo-near does the build.

## 3. near-workspaces (Rust)

- **Version.** 0.24.0 (2026-10-26), nearcore 2.14 crates ([crates.io](https://crates.io/crates/near-workspaces), [NW CHANGELOG](https://github.com/near/near-workspaces-rs/blob/d2e8efc8785d12562db5a58a8ba142e1e559a921/CHANGELOG.md)). It uses `near-sandbox = "0.4.0"`, whose default sandbox is 2.14.0 ([near-sandbox-rs config.rs](https://github.com/near/near-sandbox-rs/blob/main/src/config.rs)). MPC 3.18 tests with the same pair ([MPC Cargo.toml L185-188](https://github.com/near/mpc/blob/3.18.0/Cargo.toml#L185)). Note that the newer `cargo near new` template tests use `near-sandbox` plus `near-api` directly instead.
- **Usage:** `let worker = near_workspaces::sandbox().await?; let c = worker.dev_deploy(&wasm).await?;`. Stand-ins are just more `dev_deploy`s (or `create_account` plus `deploy`) of small mock contracts. The jar contract takes the signer and light-client account ids as init args. **Measured:** the sandbox starts in about 0.5–1 s, and the binary downloads automatically on first run.
- **Stand-in MPC signer:** a mock with `sign(request)` returning the real JSON shape (§4), signing in wasm with k256 under a fixed test root secret `x` and derived secret `x + tweak`, plus a `derived_public_key` view. Signatures then validate on regtest. By default it returns directly (no yield/resume); the `stall` and `slow` test modes yield like the live signer so stalled and late signings can be tested (T05).
- **Stand-in light client:** a mock `verify_transaction_inclusion_with_heights` (borsh args, §5) that checks the merkle proof against block roots the test registers from regtest, and returns heights the test controls.
- **Time travel:** `worker.fast_forward(delta_blocks)` ([NW impls.rs L350](https://github.com/near/near-workspaces-rs/blob/d2e8efc8785d12562db5a58a8ba142e1e559a921/workspaces/src/worker/impls.rs#L350)). Simulated time per block is the average of min and max block-production delay ([nearcore client.rs `sandbox_delta_time`](https://github.com/near/nearcore/blob/master/chain/client/src/client.rs)). **Measured:** 10,000 blocks took 85 s of wall time and advanced `block_timestamp` by 2,980 s (about 0.3 s per block).

**Gotchas**
1. Month-scale delays can't be fast-forwarded: 30 days would be about 8.7 M blocks, or about 20 h of wall time. Tests must use short per-jar timing (the spec's "demo timing": `period` and the delays as `create_jar`/init params) and fast-forward minutes, not months.
2. Assert on `env::block_timestamp` deltas, not block counts, since seconds-per-block is a sandbox config detail.
3. The sandbox needs macOS or Linux x86 ([NW README](https://github.com/near/near-workspaces-rs/blob/d2e8efc8785d12562db5a58a8ba142e1e559a921/README.md)). near-workspaces must be a dev-dependency only (it does not compile to wasm).

## 4. Bitcoin inside the NEAR contract

**rust-bitcoin vs hand-rolled: hand-roll.** **Measured:** `bitcoin = { version = "=0.32.11", default-features = false }` compiles to wasm and is small (+24 KB). But building a `Transaction` and a `SighashCache::p2wsh_signature_hash` left three **unresolved imports**, `rustsecp256k1_v0_10_0_context_preallocated_{size,create,destroy}` (the crate always depends on `secp256k1` C code, [crates.io deps](https://crates.io/crates/bitcoin/0.32.11/dependencies)). Every call then fails in the sandbox with `Link Error: unknown or invalid import`. The light client gets away with `bitcoin` because it only uses hashing ([LC Cargo.toml](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/contract/Cargo.toml)). The hand-rolled P2WSH serialisation, BIP-143 sighash and DER code is about 60 lines. With host-function hashing it **measured 1.64 TGas** per sighash call (whole transaction). Check it against the [BIP-143 test vectors](https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki), against rust-bitcoin in native unit tests, and against Bitcoin Core `testmempoolaccept` on regtest. Use `env::sha256_array` (twice for SHA256d) and `env::ripemd160_array` (HASH160), not the `sha2` crate.

**ECDSA check: `env::ecrecover`, not k256.** The MPC contract already verifies every response before returning it: `respond` checks the signature against the derived key via `ecrecover` with `malleability_flag = true` ([MPC sign.rs](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/api/sign.rs), [near-mpc-signature-verifier](https://github.com/near/mpc/blob/3.18.0/crates/near-mpc-signature-verifier/src/lib.rs)). A second check in our callback is cheap insurance: `env::ecrecover(sighash, r‖s, recovery_id, true)` and compare the result to the jar's stored 64-byte key, exactly as the reference verifier does. k256 verify would add about 40 KB and much more gas.

**Low-S and strict DER.** The MPC docs say "`r` is the x-coordinate of `big_r`, i.e. bytes `1..33`… `s` is low-s normalized" ([MPC contract README L111-117](https://github.com/near/mpc/blob/3.18.0/crates/contract/README.md#L111)). Even so, normalise defensively: if `s > n/2`, set `s = n − s`. Encode DER as `0x30 len 0x02 len(r) r 0x02 len(s) s`, with each integer stripped of leading zeros and given a `0x00` prefix when its top bit is set (BIP-66 strict DER, [BIP-66](https://github.com/bitcoin/bips/blob/master/bip-0066.mediawiki)). Then append `0x01` (SIGHASH_ALL). Low-S is a standardness rule ([BIP-146](https://github.com/bitcoin/bips/blob/master/bip-0146.mediawiki)), so high-S transactions would be non-standard and not relayed.

**MPC `sign` call** (live `v1.signer-prod.testnet`, `version()` = `"3.18.0"`):
- Args: `{"request": {"path": "<jar id>", "payload_v2": {"Ecdsa": "<64 hex chars>"}, "domain_id": 0}}`, with **1 yoctoNEAR** attached ([MPC sign.rs L28](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/api/sign.rs#L28), [SignRequestArgs](https://github.com/near/mpc/blob/3.18.0/crates/near-mpc-crypto-types/src/sign.rs)). The payload is the sighash bytes in the order the sighash function outputs them, with no further hashing ([MPC README](https://github.com/near/mpc/blob/3.18.0/crates/contract/README.md#L111)).
- Gas: the **live config requires 15 TGas** (`sign_call_gas_attachment_requirement_tera_gas: 15`, live `config()` view; default in [MPC config.rs L13](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/config.rs#L13)), although the README still says 10. The request is a yield; after `yield_timeout_length_in_blocks` = 200 (live protocol config) it fails via `fail_on_timeout` ([MPC sign.rs L199](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/api/sign.rs#L199)).
- Response (`SignatureResponse`, serde `tag = "scheme"`, [primitives.rs L167-250](https://github.com/near/mpc/blob/3.18.0/crates/near-mpc-crypto-types/src/primitives.rs#L167)). Observed on testnet today:
  `{"scheme":"Secp256k1","big_r":{"affine_point":"03630c4b…3f5fad"},"s":{"scalar":"0e25b7a3…cb7a8b"},"recovery_id":1}`
- View: `derived_public_key({"path", "predecessor", "domain_id"})` returns `"secp256k1:<base58 of 64-byte x‖y>"` ([MPC keys.rs L29](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/api/keys.rs#L29)). `public_key({})` returns the root, live value `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3`.

**Key derivation (epsilon/tweak):**
`tweak = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor_account_id + "," + path)`, read as a big-endian scalar. Then `derived = tweak·G + root` ([MPC kdf.rs](https://github.com/near/mpc/blob/3.18.0/crates/near-mpc-crypto-types/src/kdf.rs), [MPC crypto_shared/kdf.rs L13](https://github.com/near/mpc/blob/3.18.0/crates/contract/src/crypto_shared/kdf.rs#L13)). Here `predecessor` is the jar contract's account id.
**Measured:** a Python reimplementation, and the same formula in wasm (k256 `arithmetic` + `env::sha3_256`, run in the sandbox), both reproduced the live `derived_public_key(path="jar-1", predecessor="example.testnet")` exactly. The in-contract derivation cost **5.3 TGas** per call (whole transaction).

**Gotchas**
1. Don't put `bitcoin` (or anything pulling in `secp256k1-sys`) in the contract's normal dependencies. Use it only under `[dev-dependencies]`.
2. Address HRP differs (`tb1` testnet, `bcrt1` regtest), but scripts are identical. Store and compare `scriptPubKey` bytes, and take the network as an init arg.
3. The callback must treat a `sign` failure (timeout after 200 blocks) as retryable with the *same* transaction (spec story 30). Reserve inputs until a proof arrives, not until signing succeeds.

## 5. BTC light client (`btc-client-v4.testnet`)

`verify_transaction_inclusion_with_heights(#[serializer(borsh)] args: TxInclusionProof) -> Option<TxInclusionInfo>` ([LC lib.rs L371](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/contract/src/lib.rs#L371)). The method is `#[pause]`-able, the args are borsh, and **the return value is JSON**.

Borsh layout ([LC contract_args.rs L40](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/btc-types/src/contract_args.rs#L40); `H256` is borsh `[u8; 32]`, [hash.rs L9-11](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/btc-types/src/hash.rs#L9)):

```
tx_id                  [u8;32]   internal byte order = SHA256d(raw tx), i.e. display txid reversed
tx_block_blockhash     [u8;32]   internal order (display hash reversed)
tx_index               u64 LE
merkle_proof           u32 LE count, then count × [u8;32]
coinbase_tx_id         [u8;32]
coinbase_merkle_proof  u32 LE count, then count × [u8;32]   (must be the same length as merkle_proof)
→ {"tx_block_height": u64, "mainchain_tip_height": u64} | null
```

Proof building follows `merkle_proof_calculator`: duplicate the last element on odd levels, and push the sibling at each level ([LC merkle-tools lib.rs](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/merkle-tools/src/lib.rs)). **The block's txids:** `GET https://mempool.space/testnet/api/block/{hash}/txids` (Blockstream: same path under `blockstream.info/testnet/api`). Reverse each txid to internal order and build both proofs (index `i` and index 0).
**Measured:** I built a proof this way for testnet3 block 5,303,840 (29 txs, last tx) from each API and made a live view call. Both returned `{"tx_block_height":5303840,"mainchain_tip_height":5303846}`. The client tracked the tip exactly (`get_last_block_height` = mempool.space tip = 5,303,846).

**Gotchas**
1. It checks only merkle inclusion and main-chain membership. It does **not** enforce confirmations: compute `tip − height + 1` yourself. It also does not prove that `tx_id` is a real transaction ([LC lib.rs L355-363](https://github.com/Near-One/btc-light-client-contract/blob/ac30f6afd53e2f1f64158deff62832499ec123d6/contract/src/lib.rs#L355)). Take the raw tx bytes as input, compute the txid in the contract (SHA256d of the non-witness serialisation), and parse outputs from those bytes.
2. It panics, not returns null, for an unknown block, a non-main-chain block, an empty proof (blocks with only a coinbase), a length mismatch or a bad coinbase proof, and while paused. The callback must handle `PromiseError`. Only the last 52,704 headers are kept (`get_mainchain_size`, live).
3. The `mempool.space /tx/{txid}/merkle-proof` endpoint returns display-order hashes and no coinbase proof. Use `/block/{hash}/txids` instead.
4. **The proof window is short on testnet3.** 52,704 headers was about 127 h of blocks, but testnet3 now has block storms (about 19,000 blocks in 18 h on 2026-11-09), so a block leaves the window after 2–5 days. A top-up proven later can never be proven, and a payment whose block has left can never be confirmed (it stays signed, and PAYMENT_PENDING then blocks the jar). Prove promptly.

**Measured live (T06, 2026-11-09, dev contract `sats-jar-dev.testnet`, `evidence/dev-money-moment.json`).** `prove_topup` at exactly 60 TGas succeeded: own work 2.5 TGas, `verify_transaction_inclusion_with_heights` 1.8 TGas (of the 20 TGas given), callback 2.8 TGas. The light client ran 3–5 blocks behind mempool.space's tip. A 2-input `request_allowance` at exactly 80 TGas (2 × 15 + 30 + 20) signed first time: own work 4.8 TGas, each `sign` 4.2 TGas plus the signer's resume receipt 3.4 TGas, answered 5–6 NEAR blocks after the request; `on_payment_signed` 4.0 TGas. The signed transaction was accepted by testnet3 at 1 sat/vB (mempool.space `minimumFee` 1). The live answers had `recovery_id` 0 with `02` and 1 with `03` big_r prefixes. A second `request_allowance` while the first was signing failed with `ALREADY_PAID: the allowance for this period was already paid; next one in 23h 59m` (1.5 TGas). `confirm_payment` at exactly 60 TGas succeeded: own work 2.3 TGas, light client 1.8 TGas, callback 3.3 TGas. No stand-in mismatch was found.

## 6. Bitcoin Core regtest in Rust tests

- `corepc-node` is superseded: the regtest runner is published again as **`bitcoind`** (0.43.2, 2026-10-21), and the GitHub repo has moved to git.rust-bitcoin.org ([crates.io bitcoind](https://crates.io/crates/bitcoind), [rust-bitcoin/corepc README](https://github.com/rust-bitcoin/corepc)). Its RPC client is `corepc-regtest-client` 0.18.0, which includes `test_mempool_accept`, `generate_to_address`, `get_block` and `get_tx_out_proof`.
- **Auto-download:** features `["download", "<version>"]` (versions up to `31_1`). The build script downloads from bitcoincore.org, verifies the hash, and ad-hoc codesigns on arm64 macOS (bitcoind 0.43.2 `build.rs`, crate source). **Measured** with `features = ["download", "30_2"]`: the node started in 1.1 s, and `generate_to_address(101)` and `testmempoolaccept` work. **No `brew install bitcoin` is needed.** Offline/CI escape hatches: `BITCOIND_EXE`, `BITCOIND_SKIP_DOWNLOAD`, `BITCOIND_TARBALL_FILE` (crate README).

**Gotchas**
1. The download happens at *build* time, so the first `cargo test` needs network access and `tar`.
2. Use `testmempoolaccept` as the oracle for "is this signed tx valid and standard". It catches high-S, non-strict DER and fee or dust errors before testnet does.
3. Regtest addresses are `bcrt1…`. Don't let the contract's address validation reject regtest if tests feed it addresses (see §4 gotcha 2).

## 7. TypeScript stack

- **near-api-js vs near-kit.** docs.near.org lists both without ranking (`npm i near-api-js` / `npm i near-kit`, [docs: NEAR API](https://docs.near.org/tools/near-api)). near-api-js **7.x is one package** ("near-api-js v7 is a single package"); the `@near-js/*` packages last published 2.5.1 in Nov 2025 ([near-api-js README in npm tarball 7.4.0](https://www.npmjs.com/package/near-api-js), npm metadata). Choose **near-api-js 7.4.0**: official, 1.0+ semver, `Account.createSubAccount({accountOrPrefix, publicKey, nearToTransfer})`. near-kit is 0.20.2, pre-1.0.
- **Libraries.** `@scure/bip39`, `@scure/bip32`, `@noble/curves`, `@noble/hashes`, `@scure/base`: all 2.4.0. near-api-js itself pins `@noble/*` 2.2.0. `@scure/btc-signer` 2.4.1 is "Audited & minimal", with P2WPKH/P2WSH and `TEST_NETWORK` ([README](https://github.com/paulmillr/scure-btc-signer)). Choose it over `bitcoinjs-lib` 7.0.5, which needs a separately injected ECC library (`tiny-secp256k1`, WASM) for some features (bitcoinjs-lib README).
- **Test vectors:**
  - BIP-39: the spec points to [trezor/python-mnemonic vectors.json](https://github.com/trezor/python-mnemonic/blob/master/vectors.json) (passphrase "TREZOR") ([BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)).
  - BIP-84: the spec's vectors are mainnet only. `abandon ×11 about`, `m/84'/0'/0'/0/0` gives `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` ([BIP-84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)). **Measured** with `@scure/bip32` + `@scure/btc-signer`: the mainnet vector matches, and `m/84'/1'/0'/0/0` gives `tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl`. Cross-check testnet with Bitcoin Core descriptors on regtest.
  - SLIP-10 ed25519: "Test vector 1/2 for ed25519" ([SLIP-0010](https://github.com/satoshilabs/slips/blob/master/slip-0010.md)). NEAR has no official vector. NEAR's path is `m/44'/397'/0'` (SLIP-10 ed25519, all hardened) in `near-seed-phrase`, which near-api-js 7.4.0 wraps (`near-seed-phrase` 0.2.1 `index.js`, npm). **Measured:** for `abandon ×11 about`, both near-api-js `parseSeedPhrase` and a 15-line `@noble/hashes` SLIP-10 give `ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25`. Use that as a regression vector.
- **WebAuthn PRF.** MDN browser-compat-data 8.1.8 (2026-11-02) gives: `create()` with `prf` in Chrome, Edge and Chrome Android 116+, Safari and iOS 18+, and Firefox 139+; `get()` with `prf` in Chrome/Edge 116+ and Firefox 139+, with Safari listed as **not supported** (`impl_url` webkit.org/b/259934). WebKit says "Safari 18.0 adds support for the WebAuthn `prf` extension" ([WebKit blog](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)). The bug was resolved 2025-11-21 for security keys (hmac-secret), and a commenter there says platform-authenticator PRF is "well implemented in released Safari" ([WebKit bug 259934](https://bugs.webkit.org/show_bug.cgi?id=259934)). Treat PRF as working for iCloud Keychain passkeys on Safari/iOS 18+, unproven for security keys and older iOS. Feature-detect, and keep the PIN path (PBKDF2 → AES-GCM) as the always-available fallback.

**Gotchas**
1. near-api-js 7.4.0 declares `engines.node >= 22.22.2` (npm metadata). Pin Node in `.nvmrc` / CI.
2. `near-seed-phrase` pulls `bip39-light`, `tweetnacl` and Node `Buffer`. In the browser, derive with the scure/noble code above and use near-api-js only for `KeyPair`/transactions.
3. A PRF result may be missing from `create()`'s extension outputs. Always obtain the key with a `get()` and handle `prf.results` being absent ([W3C WebAuthn L3 §10.1.4](https://www.w3.org/TR/webauthn-3/#prf-extension)).

## 8. Data for the public proof view

- **NearBlocks:** **API v1 was retired on 2026-11-05; testnet runs v3 only** (live `410`: "API v1 was retired on 2026-11-05. Use /v3"; [migration guide](https://api-testnet.nearblocks.io/api-docs/migration)). The endpoint is `GET https://api-testnet.nearblocks.io/v3/accounts/{account}/txns?limit=…&next=…`. Each row has `outcomes.status` (bool) plus `status_key` (e.g. `FAILURE`); error detail is in the receipt tree at `/v3/txns/{hash}/receipts` (`outcome.status_key`, `result`). Keys are sent as `Authorization: Bearer`. **Measured:** without a key, 6 requests succeeded and the 7th onward returned `429`, so the browser can't call it directly. Call it from the backend with a key and cache the results.
- **FastNEAR tx API (no key needed for light use):** `POST https://tx.test.fastnear.com/v0/account {"account_id", "limit" ≤ 200, "desc", "is_success", "resume_token"}` ([FastNEAR docs /tx/account](https://docs.fastnear.com/tx/account)). **Measured:** it works on testnet and returns `is_success` per tx, but no error text.
- **Full transactions with error text, keyless (used by `packages/proof`):** `POST https://tx.test.fastnear.com/v0/transactions {"tx_hashes": [...]}`, up to 20 hashes per call ([FastNEAR docs /tx/transactions](https://docs.fastnear.com/tx/transactions)). Each entry has the transaction (actions with base64 args) and every receipt's outcome, logs and `status.Failure`. **Measured (2026-11-10):** the T06 ALREADY_PAID refusal's `ExecutionError` reads `Smart contract panicked: ALREADY_PAID: …`; `/v0/account` and `/v0/transactions` answer CORS preflights for any origin, so the browser can call them. `/v0/account` pages end when the answer has no `resume_token`.
- **Esplora paging:** mempool.space returns 50 confirmed txs a page for `/address/{addr}/txs`, Blockstream 25 (measured 2026-11-10); walk `/txs/chain/{last confirmed txid}` until a page is empty.
- **Error text, authoritatively:** NEAR RPC `EXPERIMENTAL_tx_status` (`receipts_outcome[].outcome.status.Failure`). It is free and keyless (the near-api-js README uses `https://test.rpc.fastnear.com`).
- **Bitcoin:** use mempool.space **testnet3 = `/testnet/api`** (testnet4 is `/testnet4`). It has `/block/{hash}/txids`, `/tx/{txid}`, `/tx/{txid}/hex`, `/address/{addr}/utxo` and `/v1/fees/recommended`. Blockstream Esplora (`blockstream.info/testnet/api`) has the same paths. **Measured:** both send `Access-Control-Allow-Origin: *` and both agree with the light client's tip. Neither publishes a rate limit (mempool.space FAQ). Use mempool.space as primary, with Blockstream as fallback behind the same interface.

## 9. Testnet account creation

- **The app account creates `<name>.<app>.testnet`** in one transaction: `CreateAccount + Transfer(amount) + AddKey(device_pk, FullAccess)`. near-api-js `createSubAccount({ accountOrPrefix, publicKey, nearToTransfer })` does this (near-api-js 7.4.0 typings; near-kit equivalent in [docs](https://docs.near.org/tools/near-api)). Only the parent account can create its sub-accounts.
- **Cost:** storage is 10^19 yocto per byte (1e-5 NEAR/byte, live protocol config). **Measured:** a sub-account with one full-access key uses **182 bytes**, and creating it with a **0 NEAR** transfer succeeded in the sandbox. That is NEP-448 zero-balance accounts: accounts with `storage_usage <= 770` (4 full-access plus 2 function-call keys) need no balance ([NEP-448](https://github.com/near/NEPs/blob/master/neps/nep-0448.md), Final).

**Gotchas**
1. A zero-balance account can't pay gas. User actions must go through the sponsor as meta-transactions (NEP-366 `DelegateAction`), or the account needs a small transfer.
2. Adding keys or contract state beyond 770 bytes makes the account need balance for all of its storage (NEP-448).
3. The account's only key is the device key. The app account must never add its own key, so it can't recover the account (ADR 0007/0009).
