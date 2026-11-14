# The backend runs as one always-on process on Railway

Spec #1 (module 4, "hosted functions") and spec #37 assumed the backend and keeper would run as Vercel functions. Instead the backend runs unchanged as one long-running Node process on Railway, with a persistent volume for the drafts file, one replica and sleeping turned off, while Vercel serves the site and forwards `/api` to it. The process already runs the keeper every hour, which the light client's few-day window needs (backend README), and the file store works only in one process; functions would have needed a new store with compare-and-set and an outside cron, for no gain a person would notice.

## Consequences

- A redeploy briefly stops the backend (a volume rules out zero-downtime deploys); the app shows "Try again shortly" meanwhile, and the backend redeploys only when backend files change.
- Each start runs a keeper pass at once; `POST /keeper/run` runs one on demand.
- Both hosts deploy from `main`, so the maintainer's merge is the go-live sign-off.

## Update, 2026-11-13

The keeper now runs every 2 minutes instead of every hour, and once at start (spec #58). An hourly pass left demo-timing jars (10-minute allowances, 3-minute handover delay) waiting up to an hour for each step. A pass with nothing new to do sends no transaction, and a payment stuck in a failed signing backs off from 10 minutes to 6 hours, so the shorter interval costs reads, not gas. The decision above, one always-on Railway process, stands.
