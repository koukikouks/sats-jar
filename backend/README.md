# Backend

The app's hosted functions (spec module 4). It gives each person their own NEAR account and holds pending guardian invites until the jar exists. The keeper (T16, T17) will live here too.

## What the sponsor key can do

The sponsor is the app account (`SPONSOR_ACCOUNT_ID`). Its key is a full-access key on the app account and nowhere else. The sponsor uses it for one thing: it creates `<id>.<app account>` with `CreateAccount + Transfer(0.25 NEAR) + AddKey(device key, FullAccess)`. The device key is the new account's only key, and NEAR gives a parent account no power over its sub-accounts. So neither the sponsor nor the app can use or recover a person's account, and the sponsor has no role in any jar. `evidence/backend-accounts.json` records accounts made this way, each with exactly one key read from the chain.

The account id comes from the device key alone (the first 20 hex characters of SHA-256 over the key's 32 bytes). This makes retries safe and lets a phone restored from its recovery phrase find its account again. It also catches the same device key on two invite links, but nothing more: two keys held by one person are two accounts.

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

```sh
node --env-file=<env file> backend/src/server.ts
```

`src/http.ts` is a fetch-standard handler (`Request` in, `Response` out) with no server, file system or timers inside. A functions host can call it directly, given a `Store` adapter over a key-value store with compare-and-set in place of `src/file-store.ts`. Hosting is the maintainer's (H4).

## Checks

- `pnpm test` runs the handler, store and config tests.
- `LIVE_TESTNET=1` with `SPONSOR_ACCOUNT_ID` and `SPONSOR_PRIVATE_KEY` set runs `src/chain.live.test.ts` against testnet.
- `node --env-file=<env file> backend/src/verify-testnet.ts http://localhost:<PORT>` runs the whole flow against a running backend and writes `evidence/backend-accounts.json`.

## Known limits

- Anyone can call `POST /accounts` with fresh keys, and each new account costs the sponsor 0.25 testnet NEAR. There is no rate limit.
- Drafts whose jar is never created are never purged.
- There are no CORS headers: the app and the backend are assumed to share one origin.
- The file store runs in one process. Several instances need a compare-and-set `Store` adapter.
