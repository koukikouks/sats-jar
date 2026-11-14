import { afterEach, describe, expect, test, vi } from "vitest";
import { createProofReader, JarNotFoundError, ProofUnavailableError } from "./index.ts";
import { evidence, fixture, replayFetch, type Fixture } from "./test-fetch.ts";

const record = evidence();
const reader = createProofReader({ contract: record.contract, fetch: replayFetch(fixture("near-views")) });

// T06's reading of the jar, its coins and its payment after the allowance was confirmed.
const after = record.steps.find((s) => s.step === "jar after confirm_payment") as unknown as {
  jar: {
    address: string;
    owner_id: string;
    giver: string;
    witness_script: string;
    public_key: string;
    locktime: number;
    create_args: { guardians: string[]; family_account: string; nickname: string; child_address: string };
  };
  coins: { txid: string; vout: number; value: string; status: string; payment_id: string | null }[];
  payment: { payment_id: string; status: string; txid: string; amount: string; fee: string; change: string };
};
const payTx = record.steps.find((s) => s.step.startsWith("allowance payment (broadcast"));

describe("a jar's contract views", () => {
  test("reads the jar after the money moment: address, balance, coins, payment, history and NFT", async () => {
    const jar = await reader.jar("1");

    expect(jar.jarId).toBe("1");
    expect(jar.nickname).toBe(after.jar.create_args.nickname);
    expect(jar.holder).toBe(after.jar.owner_id);
    expect(jar.giver).toBe(after.jar.giver);
    expect(jar.familyAccount).toBe(after.jar.create_args.family_account);
    expect(jar.guardians).toEqual(after.jar.create_args.guardians);
    expect(jar.childAddress).toBe(after.jar.create_args.child_address);
    expect(jar.address).toBe(after.jar.address);
    expect(jar.addressExplorerUrl).toBe(`https://mempool.space/testnet/address/${after.jar.address}`);
    expect(jar.witnessScript).toBe(after.jar.witness_script);
    expect(jar.publicKey).toBe(after.jar.public_key);
    expect(jar.locktime).toBe(after.jar.locktime);
    expect(jar.cap).toBe(2_500);
    expect(jar.period).toBe(86_400);
    expect(jar.demoTiming).toBe(true);
    expect(jar.provenBalance).toBe(record.ledger.left_in_jar);
    expect(jar.handover).toBe("none");

    expect(jar.coins).toEqual(
      after.coins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        value: Number(c.value),
        status: c.status,
        paymentId: c.payment_id,
        explorerUrl: `https://mempool.space/testnet/tx/${c.txid}`,
      })),
    );

    expect(jar.payments).toHaveLength(1);
    expect(jar.payments[0]).toMatchObject({
      paymentId: after.payment.payment_id,
      kind: "allowance",
      status: after.payment.status,
      txid: after.payment.txid,
      amount: Number(after.payment.amount),
      fee: Number(after.payment.fee),
      change: Number(after.payment.change),
      failure: null,
      explorerUrl: payTx?.explorer,
    });

    expect(jar.history.map((h) => h.event)).toEqual([
      "jar_created",
      "topup_proven",
      "topup_proven",
      "allowance_requested",
      "payment_signed",
      "payment_confirmed",
    ]);
    expect(jar.history[1]).toMatchObject({ txid: record.topup?.txid, vout: 0, value: 2_000 });
    expect(jar.history[3]).toMatchObject({ paymentId: "1" });

    expect(jar.nft.title).toBe("Sats Jar #1");
    expect(jar.nft.media.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  test("refuses a jar that does not exist", async () => {
    await expect(reader.jar("99")).rejects.toThrow(JarNotFoundError);
  });

  test("keeps the handover fields of the jar's history", async () => {
    // Synthetic: T08's handover entries appended to the recorded history, in the shape of
    // contract/src/history.rs (Entry flattens the snake_case-tagged Event; U64 as strings).
    const claimed = {
      index: 6,
      at: "1794270000",
      event: "handover_claimed",
      child_account: "child.sats-jar-dev.testnet",
      child_btc_pubkey: "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319",
      lapses_at: "1794270420",
    };
    const confirmed = { index: 7, at: "1794270060", event: "handover_confirmed", guardian: "guardian-a.sats-jar-dev.testnet", delay_ends_at: null };
    const cancelled = { index: 8, at: "1794270120", event: "handover_cancelled", by: "guardian-b.sats-jar-dev.testnet" };
    const lapsed = { index: 9, at: "1794270600", event: "handover_lapsed", lapsed_at: "1794270540" };
    const views = answer(fixture("near-views"), "get_history", (history) => [
      ...(history as unknown[]),
      claimed,
      confirmed,
      cancelled,
      lapsed,
    ]);

    const jar = await createProofReader({ contract: record.contract, fetch: replayFetch(views) }).jar("1");

    expect(jar.history.slice(6)).toEqual([
      {
        index: 6,
        at: 1794270000,
        event: "handover_claimed",
        childAccount: claimed.child_account,
        childBtcPubkey: claimed.child_btc_pubkey,
        lapsesAt: 1794270420,
      },
      { index: 7, at: 1794270060, event: "handover_confirmed", guardian: confirmed.guardian, delayEndsAt: null },
      { index: 8, at: 1794270120, event: "handover_cancelled", by: cancelled.by },
      { index: 9, at: 1794270600, event: "handover_lapsed", lapsedAt: 1794270540 },
    ]);
  });

  test.each([
    ["a view answer that is not JSON", "get_coins", () => "not json"],
    ["a page that is not a list", "get_history", () => ({ unexpected: true })],
    ["a payment the history names but the contract does not know", "get_payment", () => null],
  ])("treats %s as the contract being unreadable", async (_, method, replace) => {
    const views = answer(fixture("near-views"), method, replace);
    const reader = createProofReader({ contract: record.contract, fetch: replayFetch(views) });

    const failure = reader.jar("1");

    await expect(failure).rejects.toThrow(ProofUnavailableError);
    await expect(failure).rejects.toMatchObject({ source: "near" });
  });
});

/** A copy of recorded view answers with `method`'s result replaced (a string is sent as raw bytes). */
function answer(source: Fixture, method: string, replace: (result: unknown) => unknown): Fixture {
  const copy = structuredClone(source);
  for (const exchange of copy.exchanges) {
    const request = exchange.request.body as { params?: { method_name?: string } };
    const body = exchange.response.body as { result?: { result?: number[] } };
    if (request.params?.method_name !== method || !body.result?.result) continue;
    const old: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
    const next = replace(old);
    const text = typeof next === "string" ? next : JSON.stringify(next);
    body.result.result = [...new TextEncoder().encode(text)];
  }
  return copy;
}

/** Counts each NEAR view method the reader calls, over a replay. */
function counting(replay: typeof fetch) {
  const calls: string[] = [];
  const http: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { params?: { method_name?: string } };
      if (body.params?.method_name) calls.push(body.params.method_name);
    }
    return replay(input, init);
  };
  return { http, calls };
}

describe("reading a jar again", () => {
  test("a payment that has finished is not read again", async () => {
    const { http, calls } = counting(replayFetch(fixture("near-views")));
    const again = createProofReader({ contract: record.contract, fetch: http });

    const first = await again.jar("1");
    const second = await again.jar("1");

    // jar 1's allowance payment is confirmed: final on chain, so one read serves every later one.
    expect(first.payments[0]?.status).toBe("confirmed");
    expect(second.payments).toEqual(first.payments);
    expect(calls.filter((m) => m === "get_payment")).toHaveLength(1);
    expect(calls.filter((m) => m === "get_jar")).toHaveLength(2);
  });

  test("returns the contract's emergency and transfer records with the jar", async () => {
    const jar = await reader.jar("1");
    // The T06 dev contract predates both records; a newer build returns null when there is none.
    expect(jar.emergency).toBeNull();
    expect(jar.transfer).toBeNull();
  });
});

describe("a rate-limited NEAR answer", () => {
  afterEach(() => void vi.useRealTimers());

  function limited(times: number) {
    const replay = replayFetch(fixture("near-views"));
    let left = times;
    const http: typeof fetch = async (input, init) => {
      if (left > 0) {
        left -= 1;
        return new Response("Too Many Requests", { status: 429 });
      }
      return replay(input, init);
    };
    return createProofReader({ contract: record.contract, fetch: http });
  }

  test("is asked once more after a second", async () => {
    vi.useFakeTimers();
    const read = limited(1).jar("1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await read).jarId).toBe("1");
  });

  test("is unavailable when the second answer is rate-limited too", async () => {
    vi.useFakeTimers();
    const read = limited(2).jar("1");
    const outcome = read.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(ProofUnavailableError);
  });
});
