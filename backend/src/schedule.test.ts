import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Keeper, KeeperReport } from "./keeper.ts";
import { KEEPER_INTERVAL, startKeeper } from "./schedule.ts";

function countingKeeper() {
  const runs: number[] = [];
  const keeper: Keeper = {
    async run(): Promise<KeeperReport> {
      runs.push(Date.now());
      return { startedAt: Math.floor(Date.now() / 1000), steps: [] };
    },
  };
  return { keeper, runs };
}

describe("the keeper's schedule", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("runs a pass as soon as it starts, so a deploy needs no manual press", () => {
    const { keeper, runs } = countingKeeper();
    const stop = startKeeper(keeper, { log: () => {} });
    expect(runs).toHaveLength(1);
    stop();
  });

  it("then runs one pass every 2 minutes", async () => {
    const { keeper, runs } = countingKeeper();
    const stop = startKeeper(keeper, { log: () => {} });
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toHaveLength(7);
    expect(KEEPER_INTERVAL).toBe(120_000);
    stop();
  });

  it("logs each pass's report as one JSON line, and a failed pass without stopping", async () => {
    let fail = false;
    const keeper: Keeper = {
      async run() {
        if (fail) throw new Error("rpc down");
        return { startedAt: 1, steps: [] };
      },
    };
    const lines: unknown[][] = [];
    const stop = startKeeper(keeper, { log: (...line) => void lines.push(line) });
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL);
    fail = false;
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL);
    expect(lines[0]).toEqual([JSON.stringify({ startedAt: 1, steps: [] })]);
    expect(lines[1]?.[0]).toBe("keeper run failed");
    expect(lines[2]).toEqual([JSON.stringify({ startedAt: 1, steps: [] })]);
    stop();
  });
});
