# Hosting (testnet)

How Sats Jar is hosted until at least 2026-11-25 (spec #45, ADR 0011). Variable names only, never values.

## How a change goes live

- **`main` is production on both hosts.** Merging into `main` (the maintainer's pull request merge) is the go-live sign-off. Merges into `integration/web-app` build only Vercel previews and never touch Railway.
- **Vercel** builds `main` for production. Until #44 merges, `main` has no `app/` folder, so a push to `main` starts a production build that fails; Vercel keeps serving the last good deployment, so this is harmless.
- **Railway** redeploys `main` only when a backend-affecting path changes (watch paths below). A redeploy briefly stops the backend: the app shows "We could not reach the network just now. Try again shortly." meanwhile. Each start restarts the keeper's hour, so run a keeper pass after a deploy (below).

## Railway: the backend

Project `sats-jar-backend` (https://railway.com/project/43fbf8ba-300e-447e-8502-2ffb27c76e21), environment `production`, service `sats-jar`.

| Setting | Value | Why |
|---|---|---|
| Plan | Trial ($5 credit, 30 days from 2026-11-13) | no card on file; usage is about $1–2 a month. Add a card and pick Hobby ($5/month) if the credit runs low |
| Source | GitHub `koukikouks/sats-jar`, branch `main`, auto-deploy | `main` is production |
| Root directory | `/` (none set) | the backend imports workspace packages |
| Builder | Railpack | |
| Build variables | `RAILPACK_PACKAGES` = `node@22.22.2 pnpm@12.8.1`, `RAILPACK_INSTALL_CMD` = `pnpm install --frozen-lockfile`, `RAILPACK_BUILD_CMD` = `cp "$(node -p process.execPath)" ./node-runtime` | the root `Cargo.toml` makes Railpack pick its Rust provider, and only a committed `railpack.json` can force Node. These install Node and pnpm for the build and install the workspace; the Rust image carries no Node at run time, so the build copies the Node binary into the app folder. The backend is TypeScript run by Node directly, so there is nothing else to build |
| Start command | `./node-runtime backend/src/server.ts` | the Node binary copied by the build |
| Watch paths | `/backend/**`, `/packages/**`, `/scripts/**`, `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml` | landing and screen changes don't restart the backend |
| Replicas | 1, US East | the file store works in one process |
| Serverless | off | the keeper runs hourly and the first visitor never waits |
| Restart policy | on failure, up to 10 retries | |
| Healthcheck | none | |
| CDN caching | off | draft polling must see fresh answers |
| Volume | `sats-jar-volume` at `/data` | drafts survive redeploys |
| Public address | `https://sats-jar-production.up.railway.app` | the site forwards `/api` here |

Variables: the build variables above, `RAILPACK_NODE_VERSION` (22.22.2), `SPONSOR_ACCOUNT_ID` (`sats-jar-app.testnet`), `CONTRACT_ACCOUNT_ID` (`sats-jar.testnet`), `KEEPER_ACCOUNT_ID` (`keeper-locked.sats-jar-app.testnet`), `DRAFTS_FILE` (`/data/drafts.json`), and the secrets `SPONSOR_PRIVATE_KEY` and `KEEPER_PRIVATE_KEY`, pasted by the maintainer, sealed in Railway (never shown again in its dashboard or API) and otherwise kept only in near-cli's keychain on the maintainer's machine. To change one, delete the sealed variable and add it again. Railway sets `PORT`.

Settings live in Railway's dashboard. There is no `railway.json`: Railway is retiring config-as-code on 2026-12-01.

## The sponsor and the keeper

- **Sponsor** `sats-jar-app.testnet` pays 0.25 testnet NEAR for each new person's account. Anyone can call `POST /api/accounts`, with no rate limit (backend README, known limits). With about 3 NEAR it covers about 11 new accounts, so top it up before sharing the site widely.
- **Keeper** `keeper-locked.sats-jar-app.testnet` has one function-call key on `sats-jar.testnet` (`evidence/hosting.json`) and 1 NEAR for gas; a keeper call burns about 0.002 NEAR.
- **Check a balance**: `near account view-account-summary <account> network-config testnet now`, or https://testnet.nearblocks.io/address/<account>.
- **Top up**: send testnet NEAR from any testnet account with a plain transfer, e.g. `near tokens <from> send-near <account> '5 NEAR' network-config testnet sign-with-legacy-keychain send`.

## Running and fixing

- **Run a keeper pass now**: `curl -X POST https://sats-jar-production.up.railway.app/keeper/run` (after the site is wired: `https://app.satsjar.app/api/keeper/run`). It answers with a report of each step.
- **Logs**: the service's Deployments tab, View logs. The keeper's hourly report is logged as one JSON line.
- **Roll back**: Deployments tab, an earlier successful deployment, Redeploy. The volume keeps the drafts.
- **Usage**: workspace Settings, Billing shows the credit left.
- **Check it**: `node backend/src/verify-hosting.ts backend <address>`, then after a redeploy `node backend/src/verify-hosting.ts after-redeploy <address>`.
