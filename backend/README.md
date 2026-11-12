# Backend

The app's hosted functions (spec module 4). It gives each person their own NEAR account, holds pending guardian invites until the jar exists, and runs the keeper.

## What the sponsor key can do

The sponsor is the app account (`SPONSOR_ACCOUNT_ID`). Its key is a full-access key on the app account and nowhere else. The sponsor uses it for one thing: it creates `<id>.<app account>` with `CreateAccount + Transfer(0.25 NEAR) + AddKey(device key, FullAccess)`. The device key is the new account's only key, and NEAR gives a parent account no power over its sub-accounts. So neither the sponsor nor the app can use or recover a person's account, and the sponsor has no role in any jar. `evidence/backend-accounts.json` records accounts made this way, each with exactly one key read from the chain.

The account id comes from the device key alone (the first 20 hex characters of SHA-256 over the key's 32 bytes). This makes retries safe and lets a phone restored from its recovery phrase find its account again. It also catches the same device key on two invite links, but nothing more: two keys held by one person are two accounts.

## What the keeper key can do

The keeper (`KEEPER_ACCOUNT_ID`, testnet: `keeper.sats-jar-app.testnet`) is a sub-account of the app account, made once by `src/keeper-setup.ts`: `CreateAccount + Transfer(1 NEAR) + AddKey(keeper key, FunctionCall on CONTRACT_ACCOUNT_ID, any method)`. It has no full-access key. A function-call key cannot attach a deposit, so it can make no 1-yocto holder or guardian call, no transfer and no key change, and the keeper has no role in any jar. It can only call what anyone may call. Its NEAR pays its gas; anyone can top it up with a plain transfer. Switching to the locked contract needs a new keeper account, since nobody can add a key to this one. `evidence/keeper-run.json` records its key list.

## The keeper

One pass (`src/keeper.ts`), run every hour by `src/server.ts` and on demand by `POST /keeper/run`:

1. Every unfinished payment, whatever its kind: a failed or stalled signing gets `retry_signing`; a signed payment is broadcast (again each run until it is in a block, which costs nothing); a payment 3 deep on the light client gets `confirm_payment`.
2. Every jar: each output at its address or at one of its old addresses that is 3 deep on the light client, at least 1,000 sats, not yet a coin and not a payment's change gets `prove_topup`.
3. Then at most one new payment per jar, the first that `get_jar` shows due, and only while the jar has no unfinished payment. The new payment is broadcast at once. Each is sent at the mempool's minimum fee rate (at least 1 sat/vB) with gas for 10 inputs.
   - `complete_handover`: the handover is confirmed, its delay is over and the jar has unlocked, or it is completing with coins still to move. Called again each pass until every fixed coin has moved; the NFT moves inside the last `confirm_payment`.
   - `accept_transfer` with the stored key: a transfer is accepted with coins still to move. The receiver's own account makes the first call; later batches take no deposit, so the keeper sends them.
   - `rehome_stray`: a coin the jar holds, free, sits at an old address, and no handover is completing and no transfer is accepted.
   - `execute_emergency`: an open proposal's delay has ended (2 approvals) and payouts are not stopped by a handover.
   - `request_allowance`: an allowance is due, with a balance, and payouts are not stopped by a handover.

Calls go one at a time, each waited for to its final outcome. A refused call is remembered and not sent again until what it depends on changes: for `request_allowance` the jar's period, balance, available allowance or the fee rate; for `complete_handover`, `accept_transfer`, `rehome_stray` and `execute_emergency` the handover, transfer, strays or proposal it acts on, the balance or the fee rate, except that a refusal for time not yet passed (`BEFORE_UNLOCK`, `HANDOVER_DELAY_RUNNING`, `DELAY_NOT_PASSED`: the host's clock ahead of block time) is tried again on a later pass; for `retry_signing` the block `SIGNING_IN_PROGRESS` names, or the payment's status; for `prove_topup` and `confirm_payment` the light client's next tip after `NOT_CONFIRMED`, and an hour plus 6 new tips after any other refusal (such as `NOT_IN_CHAIN`). So a pass with nothing new to do sends no transaction. The memory lives in the process; a restart costs at most one more refused call per item.

**Run it at least every few hours.** The light client keeps only a few days of testnet3 headers. A payment whose block leaves that window before `confirm_payment` blocks its jar for good in the locked build, and a top-up proven that late cannot be proven at all. The hourly schedule covers this while the process runs; a host without a long-running process must point a cron at `POST /keeper/run`.

## Interface

JSON over HTTP. A refusal is `{ code, message }`.

| Call | Answer | Refusals |
|---|---|---|
| `POST /accounts {publicKey}` | `{accountId}`, made or already there | `INVALID_PUBLIC_KEY` |
| `POST /drafts {nickname, invites: 2 or 3}` | `201 {draftId, inviteTokens}` | `BAD_INVITE_COUNT` |
| `GET /drafts/:draftId` | `{nickname, invites: [{joined, accountId}]}` | `DRAFT_NOT_FOUND` |
| `GET /invites/:token` | `{nickname, joined}` | `INVITE_NOT_FOUND` |
| `POST /invites/:token/join {publicKey}` | `{accountId}`, made if new | `INVITE_USED`, `ALREADY_GUARDIAN`, `INVALID_PUBLIC_KEY` |
| `POST /drafts/:draftId/jar {jarId}` | `{}`, the draft and its links are deleted | `JAR_NOT_FOUND`, `GUARDIANS_DIFFER` |
| `POST /keeper/run` | `{startedAt, steps: [{action, jarId?, paymentId?, target?, result, code?, message?, nearTx?}]}` | none: each step's `result` is `done`, `refused`, `waiting` or `failed` |

A body that is not a JSON object gets `BAD_REQUEST`, an unknown endpoint gets `NOT_FOUND`, and a chain or store failure gets `500 INTERNAL`.

The draft id is the giver's link and each invite token is one invitee's. The store keeps only their SHA-256 hashes, account ids and the nickname, never a key. A draft is deleted once `get_jar` on `CONTRACT_ACCOUNT_ID` shows a jar whose guardians all joined through it.

## Running

Settings come from the environment only, read once at startup:

| Name | What |
|---|---|
| `SPONSOR_ACCOUNT_ID` | The app account, parent of every person's account (testnet: `sats-jar-app.testnet`) |
| `SPONSOR_PRIVATE_KEY` | Its key, `ed25519:...` |
| `CONTRACT_ACCOUNT_ID` | The jar contract; switch to the locked contract here |
| `DRAFTS_FILE` | Where the file store keeps pending drafts (needs a persistent disk) |
| `PORT` | HTTP port |
| `KEEPER_ACCOUNT_ID` | The keeper account (testnet: `keeper.sats-jar-app.testnet`) |
| `KEEPER_PRIVATE_KEY` | Its function-call key, `ed25519:...` |

```sh
node --env-file=<env file> backend/src/server.ts
```

Make the keeper account once with `node --env-file=<env file> backend/src/keeper-setup.ts`.

`src/http.ts` is a fetch-standard handler (`Request` in, `Response` out) with no server, file system or timers inside. A functions host can call it directly, given a `Store` adapter over a key-value store with compare-and-set in place of `src/file-store.ts`. Hosting is the maintainer's (H4).

## Checks

- `pnpm test` runs the handler, store, config and keeper tests (the keeper against fakes answering with recordings in `src/fixtures/`).
- `LIVE_TESTNET=1` with `KEEPER_ACCOUNT_ID` and `KEEPER_PRIVATE_KEY` set runs `src/keeper.live.test.ts`: the keeper's NEAR and Esplora adapters read the recorded answers, and a real refusal comes back with its code.
- `node --env-file=<env file> backend/src/verify-keeper.ts <step>` runs the keeper's testnet check (create-jar, topup, press, close) and writes `evidence/keeper-run.json`.
- `node --env-file=<env file> backend/src/verify-handover.ts <step>` runs the keeper's handover check on `sats-jar-dev-2.testnet` with keeper `keeper-2.sats-jar-app.testnet` (accounts, create-jar, emergency, handover, topup-a, press, topup-b, spend, snapshot, close) and writes `evidence/keeper-handover.json`.
- `LIVE_TESTNET=1` with `SPONSOR_ACCOUNT_ID` and `SPONSOR_PRIVATE_KEY` set runs `src/chain.live.test.ts` against testnet.
- `node --env-file=<env file> backend/src/verify-testnet.ts http://localhost:<PORT>` runs the whole flow against a running backend and writes `evidence/backend-accounts.json`.

## Known limits

- Anyone can call `POST /accounts` with fresh keys, and each new account costs the sponsor 0.25 testnet NEAR. There is no rate limit.
- Drafts whose jar is never created are never purged.
- There are no CORS headers: the app and the backend are assumed to share one origin.
- The file store runs in one process. Several instances need a compare-and-set `Store` adapter.
- Anyone can call `POST /keeper/run`. A pass with nothing new to do sends no transaction, so pressing it costs only reads.
- The keeper reads every payment and every jar's coins and outputs each pass, and reads an address's outputs in one Esplora call, which has a size limit. Fine for the demo; a larger deployment needs cursors.
- No fee replacement: a payment sent at too low a rate stays pending (spec; testnet at 1 sat/vB is fine).
