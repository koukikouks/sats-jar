// When the keeper runs: at start, then every 2 minutes, so demo-timing jars are acted on within minutes (spec #58).
import type { Keeper } from "./keeper.ts";

export const KEEPER_INTERVAL_MS = 120_000;

/** Starts the schedule; returns a function that stops it. A pass still running is joined, not doubled (`Keeper.run`). */
export function startKeeper(
  keeper: Keeper,
  options: { log: (line: string) => void; error: (...line: unknown[]) => void },
): () => void {
  const pass = () =>
    keeper.run().then(
      (report) => options.log(JSON.stringify(report)),
      (error: unknown) => options.error("keeper run failed", error),
    );
  void pass();
  const timer = setInterval(() => void pass(), KEEPER_INTERVAL_MS);
  return () => clearInterval(timer);
}
