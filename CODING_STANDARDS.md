# Coding standards

How code in Sats Jar is written. `/code-review` checks every ticket against this file. Exact versions and stack facts live in [docs/agents/stack-notes.md](docs/agents/stack-notes.md); this file says how to use them.

## Scope

- Build exactly what the ticket's acceptance criteria, the spec (#1) and the ADRs require. Each function, option and file traces to one of them.
- Prefer deep modules: a small interface over substantial behaviour (see the `codebase-design` skill). Pure logic (the rule, Bitcoin encoding) stays free of I/O so it can be tested directly.
- Name things in the glossary's words (`GLOSSARY.md`): jar, top-up, allowance, cap, period, fee budget, emergency payment, handover, re-homing, stray, holder. Names fixed by a standard keep their standard spelling (NEP-171's `owner_id`, NEAR's attached deposit).
- Comments explain why, or name a gotcha. One line where one line will do.

## Repository layout

Fixed up front so parallel tickets do not collide.

| Path | What | First ticket |
|---|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | Cargo workspace (root), toolchain pin, release profile | T01 creates them, T02 adds its member |
| `btc/` | Pure Bitcoin crate: parse, build, BIP-143, witness, address, script | T01 |
| `test-support/` | Shared Rust dev crate: the regtest harness every Rust test suite imports | T01 |
| `contract/` | The NEAR jar contract | T02 |
| `contract/tests/` | Seam 1: near-workspaces sandbox and regtest tests, stand-ins | T02, T03, T04 |
| `package.json`, `pnpm-workspace.yaml` | Root pnpm workspace and the TypeScript test runner (vitest) | T07 |
| `packages/device-keys/` | Seam 2: keys, recovery phrase, PIN encryption, guardian code | T07 |
| `packages/proof/` | Proof-view data over public NEAR and Bitcoin APIs | T20 |
| `packages/sdk/` | The typed App SDK the screens call | T18 |
| `backend/` | Sponsor, invites, keeper | T15 |
| `scripts/` | Testnet scripts (dev deploy, live checks, evidence) | T06 |
| `evidence/` | Testnet evidence files (hashes, key counts, code hash) | T06 |
| `app/` | Landing page and web app (the maintainer) | H2, H3 |

TypeScript packages share one pnpm workspace at the root.

## Rust contract

- Toolchain `1.95.0` via `rust-toolchain.toml`; `near-sdk` pinned exactly, `unstable` feature only for `env::ecrecover`. The release profile is the cargo-near template's (`overflow-checks = true`, `panic = "abort"`, `opt-level = "z"`, `lto = true`).
- Bitcoin code in the contract is hand-rolled in `btc/`, hashing with NEAR host functions. The `bitcoin` crate is a dev-dependency only (its secp256k1 C imports break the contract at runtime). It is the test oracle.
- No floats. Amounts are `u64` sats and `u128` yocto in state, `U64`/`U128` in JSON. Arithmetic is checked; an overflow is a refusal, never a wrap.
- State: one `#[near(contract_state)]` struct with `#[init]` and `PanicOnDefault`; each collection keyed by a `BorshStorageKey` enum variant, never reordered or removed. A modified entry is written back with `insert`. The locked build has no upgrade or migrate entry point.
- Storage: `create_jar` is payable and covers the jar's own records, measuring growth with `env::storage_usage()` after the state is flushed, requiring that amount and refunding the rest. Growth after creation (proven coins, payments, stored signatures) is paid from the contract's balance, which the sponsor keeps funded by plain transfer; the dust floor makes each coin cost an attacker more in Bitcoin than it costs the contract in storage. No new refusal is added to the spec's refusal orders for storage.
- Cross-contract calls (signer, light client) follow the `near-contract-audit` skill:
  - State that guards the call is written before the call (inputs reserved, payment marked signing). Other transactions run before the callback; the reservation is what stops them.
  - Every callback is `#[private]`. A single result is read with `#[callback_result] Result<T, PromiseError>`; joined `sign` results are read one by one by index (`env::promise_results_count()`), never with `#[callback_vec]`, which panics if any one failed.
  - A callback that follows a reservation (signing, re-homing) never panics and never unwraps; a failure is recorded as a retryable status. A callback that follows no reservation (`prove_topup` waiting on the light client) may refuse with `env::panic_str`, because there is nothing to roll back; that is how "not confirmed", "not in chain" and a light-client panic become failed transactions.
  - Check `env::prepaid_gas()` covers the call plus the callback before scheduling; callbacks get static gas.
  - Every `Promise` is returned or `.detach()`ed.
  - Callbacks are monotonic: a payment's status only moves forward.
- Light-client results are trusted for inclusion only. The contract computes the txid from the raw transaction itself and counts confirmations itself (tip − height + 1). A light-client panic (unknown block, paused) surfaces as a readable refusal.
- Refusals: `env::panic_str` with a stable `CODE: sentence` message, for example `ALREADY_PAID: the allowance for this period was already paid; next one in 3d 4h`. Codes are SCREAMING_SNAKE, documented once in the contract's error module, and are what the SDK maps to user messages. Sensitive holder calls (transfers, approvals, spends) require at least 1 yoctoNEAR attached (`assert_one_yocto()` where no other deposit is taken), so they need a full-access key.
- Every state change emits one NEP-297 event (`standard: "satsjar"`, plus the NFT standard events where NEP-171 requires them).
- Loops over collections are bounded or paginated (at most 10 inputs per payment, as the spec sets).
- The dev-only escape lives behind a cargo feature the reproducible build never enables; a test proves the locked build lacks it.

## TypeScript

- `strict` TypeScript, no `any`, ES modules, Node ≥ 22.22.2. Dependencies pinned exactly (no `^`), from the stack notes: `near-api-js`, `@scure/*`, `@noble/*`.
- Keys are made and kept on the device. Nothing server-side stores a key, a phrase or an encrypted blob. PIN unlock always works; Face ID (WebAuthn PRF) is optional on top.
- Secrets (sponsor and keeper keys) come from environment variables, loaded once at startup; `.env` stays gitignored. Testnet RPC endpoints only.
- The SDK returns typed results and typed refusals (the contract's codes), never raw RPC errors. The UI never sees an account name, gas or a signing prompt.
- The backend and keeper call only methods anyone may call, plus account creation. They can never move coins outside the rule.

## Tests

- Follow the `tdd` skill: red before green, one behaviour per cycle, tests only at the agreed seams (spec, Testing Decisions):
  1. the contract's public interface in the sandbox, built with the locked build's features, joined with regtest `testmempoolaccept` on the contract's own signed transactions;
  1b. beneath it, the `btc` crate's public interface against the official BIP-143 vectors and Bitcoin Core regtest (the spec's cheap cross-check that pinpoints a sighash bug);
  2. device keys against published vectors.
- Expected values come from an independent source: BIP-143, BIP-39 and BIP-84 vectors, the live `derived_public_key` view, recorded testnet receipts, Bitcoin Core accepting the transaction. Our own output is never the oracle.
- Stand-ins for the MPC signer and the light client copy live behaviour: the live request rules (1 yoctoNEAR, 15 Tgas floor), the live response JSON, and the live panics.
- Time-based rules are tested with short demo-timing settings, not by fast-forwarding days of blocks.
- Test names read as behaviour in glossary words: `second_allowance_in_a_period_is_refused_as_already_paid`.
- `cargo test` from the root runs the Rust suites; `pnpm test` runs the TypeScript ones (vitest).

## Git, commits and review

- Nothing is committed or pushed to `main` directly. Each ticket is built on its own branch (`t04-pay-allowance`) and merged into the integration branch (`integration/spec-1`) after its review passes; both may be pushed. `main` changes only through a pull request the maintainer merges. A project hook (`.claude/hooks/block-dangerous-git.sh`) blocks pushes to `main`, force pushes, merging pull requests and destructive resets; it matches on command text, so describe those commands in files rather than in shell strings.
- Commit messages follow the `commit` skill: `area: summary`, a short why, `Closes #N`, no attribution trailers. Pull request bodies follow the `pr` skill, also with no attribution footer.
- A ticket lands as one or a few commits, each a coherent step that builds and passes its tests. No secrets, no `project-brief.md`, nothing from `docs/plans/`.
- Before committing: `cargo fmt`, `cargo clippy -- -D warnings`, the TypeScript type check, and the full test suite pass.
- Each ticket closes with `/code-review` (see `CLAUDE.md`). Contract tickets also run the `near-contract-audit` skill's checklist over their diff.
- Deploying the locked contract, hosting the site, making anything public and the submission wait for the maintainer's sign-off. Testnet transactions do not.
