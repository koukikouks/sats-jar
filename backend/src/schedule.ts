// When the keeper runs: once at start, so a deploy needs no manual press, then every 2 minutes,
// so a demo-timing jar (10-minute allowances, 3-minute handover delay) is acted on within
// minutes of the chain allowing it (spec #58). Frequent passes are cheap: a pass with nothing
// new to do sends no transaction, and the light client's few-day window is far wider.
import type { Keeper } from "./keeper.ts";

export const KEEPER_INTERVAL = 120_000;

/** Starts the schedule; returns a function that stops it. A pass still running is joined, not doubled (`Keeper.run`). */
export function startKeeper(keeper: Keeper, options: { log: (...line: unknown[]) => void }): () => void {
  const pass = () =>
    keeper.run().then(
      (report) => options.log(JSON.stringify(report)),
      (error: unknown) => options.log("keeper run failed", error),
    );
  void pass();
  const timer = setInterval(() => void pass(), KEEPER_INTERVAL);
  return () => clearInterval(timer);
}
