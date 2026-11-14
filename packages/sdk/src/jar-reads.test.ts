// How often a jar page reads the chain (spec #58): one shared read of the jar per poll, kept
// through a brief network failure, and read afresh after this device writes.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SatsJarRefusal } from "./api.ts";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, fixture, memoryStorage, succeededWith, testNetwork } from "./test-network.ts";

const recordings = [fixture("proof-near-views"), fixture("proof-bitcoin-jar1"), fixture("bitcoin-tip")];
const T0 = new Date("2026-11-13T15:00:00Z");

/**
 * jar 1 over the recordings, with the NEAR views it reads counted, a switch that makes NEAR
 * unreachable, and (synthetic, labelled) a different balance once `balance` is set.
 */
function jarNetwork() {
  const net = testNetwork({ fixtures: recordings, sendTx: () => succeededWith(1) });
  const calls: string[] = [];
  const state = { down: false, balance: null as string | null, hold: null as Promise<void> | null };
  const http: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { params?: { method_name?: string } }) : null;
    const method = body?.params?.method_name;
    if (method) {
      if (state.down) throw new TypeError("fetch failed");
      calls.push(method);
      if (method === "get_jar" && state.hold) await state.hold;
    }
    const response = await net.fetch(input, init);
    if (method !== "get_jar" || state.balance === null) return response;
    const answer = (await response.json()) as { result: { result: number[] } };
    const view = JSON.parse(new TextDecoder().decode(Uint8Array.from(answer.result.result))) as Record<string, unknown>;
    const changed = new TextEncoder().encode(JSON.stringify({ ...view, proven_balance: state.balance }));
    return new Response(JSON.stringify({ ...answer, result: { ...answer.result, result: [...changed] } }));
  };
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, http);
  const count = (method: string) => calls.filter((m) => m === method).length;
  return { app, calls, count, state };
}

/** What one poll of the jar page asks for: its status, top-ups and allowances. */
const poll = (app: ReturnType<typeof jarNetwork>["app"]) =>
  Promise.all([app.jars.status("1"), app.jars.topUps("1"), app.jars.allowances("1")]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => void vi.useRealTimers());

const later = (seconds: number) => vi.setSystemTime(T0.getTime() + seconds * 1_000);

describe("one poll of the jar page", () => {
  test("reads the jar once for all three sections", async () => {
    const { app, count } = jarNetwork();
    await poll(app);
    expect([count("get_jar"), count("get_coins"), count("get_history"), count("nft_token")]).toEqual([1, 1, 1, 1]);
    // jar 1's one payment, read once.
    expect(count("get_payment")).toBe(1);
  });

  test("the next poll reads the jar again but not the payment it already saw finish", async () => {
    const { app, count } = jarNetwork();
    await poll(app);
    later(10);
    await poll(app);
    expect(count("get_jar")).toBe(2);
    expect(count("get_payment")).toBe(1);
  });

  test("a section asking a moment after the others shares their read", async () => {
    const { app, count } = jarNetwork();
    await app.jars.status("1");
    later(3);
    await app.jars.allowances("1");
    expect(count("get_jar")).toBe(1);
  });
});

describe("a brief network failure", () => {
  test("shows the last good read for up to a minute", async () => {
    const { app, state } = jarNetwork();
    const good = await app.jars.status("1");
    state.down = true;
    later(59);
    expect(await app.jars.status("1")).toEqual(good);
  });

  test("after a minute without a good read, says the network can't be reached", async () => {
    const { app, state } = jarNetwork();
    await app.jars.status("1");
    state.down = true;
    later(61);
    await expect(app.jars.status("1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("with no good read yet, says so at once", async () => {
    const { app, state } = jarNetwork();
    state.down = true;
    const outcome = await app.jars.status("1").catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SatsJarRefusal);
    expect(outcome).toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("after this device writes", () => {
  async function withAccount(app: ReturnType<typeof jarNetwork>["app"]) {
    await app.device.setUp({ pin: "482913" });
    const draft = await app.invites.start({ nickname: "x", guardians: 2 });
    await app.invites.join(draft.inviteTokens[0] ?? "");
  }

  test("the next read is fresh and shows the change", async () => {
    const { app, count, state } = jarNetwork();
    await withAccount(app);
    expect((await app.jars.status("1")).balance).toBe(1_260);
    await app.emergency.propose("1", 3_000);
    state.balance = "5000"; // synthetic: the chain's answer after the write
    const after = await app.jars.status("1");
    expect(count("get_jar")).toBe(2);
    expect(after.balance).toBe(5_000);
  });

  test("a read that then fails says so, rather than show the jar from before the write", async () => {
    const { app, state } = jarNetwork();
    await withAccount(app);
    await app.jars.status("1");
    await app.emergency.propose("1", 3_000);
    state.down = true;
    await expect(app.jars.status("1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("a read still on its way when the write lands is not kept as the last good one", async () => {
    const { app, state } = jarNetwork();
    await withAccount(app);
    let release = () => {};
    state.hold = new Promise((resolve) => (release = resolve));
    const before = app.jars.status("1");
    await app.emergency.propose("1", 3_000);
    state.hold = null;
    release();
    await before;
    state.down = true;
    await expect(app.jars.status("1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
