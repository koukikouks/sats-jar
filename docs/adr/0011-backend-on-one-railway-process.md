# The backend runs as one always-on process on Railway

Spec #1 (module 4, "hosted functions") and spec #37 assumed the backend and keeper would run as Vercel functions. Instead the backend runs unchanged as one long-running Node process on Railway, with a persistent volume for the drafts file, one replica and sleeping turned off, while Vercel serves the site and forwards `/api` to it. The process already runs the keeper every hour, which the light client's few-day window needs (backend README), and the file store works only in one process; functions would have needed a new store with compare-and-set and an outside cron, for no gain a person would notice.

## Consequences

- A redeploy briefly stops the backend (a volume rules out zero-downtime deploys); the app shows "Try again shortly" meanwhile, and the backend redeploys only when backend files change.
- Each restart starts the keeper's hour again; `POST /keeper/run` runs a pass at once.
- Both hosts deploy from `main`, so the maintainer's merge is the go-live sign-off.
