import { describe, expect, it } from "vitest";
import { esplora } from "./bitcoin.ts";
import { fixture } from "./keeper.fakes.ts";

/** A fetch that answers each URL from a table, and records what was sent. */
function fakeFetch(table: Record<string, { status: number; body: string } | "down">) {
  const sent: { url: string; method: string; body?: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const answer = table[`${init?.method ?? "GET"} ${url}`];
    if (!answer || answer === "down") throw new TypeError("fetch failed");
    return new Response(answer.body, { status: answer.status });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const MEMPOOL = "https://mempool.space/testnet/api";
const BLOCKSTREAM = "https://blockstream.info/testnet/api";
const ADDRESS = "tb1q5vkrawlraeg8r4h5efs96z85sgv48qk4r5d9kd5eusj2zmtc9puqc3ezza";

describe("Esplora", () => {
  it("reads an address's outputs from mempool.space", async () => {
    const body = JSON.stringify(fixture("esplora-utxo-jar-1.json"));
    const { fetch } = fakeFetch({ [`GET ${MEMPOOL}/address/${ADDRESS}/utxo`]: { status: 200, body } });

    expect(await esplora({ fetch }).outputs(ADDRESS)).toEqual(fixture("esplora-utxo-jar-1.json"));
  });

  it("falls back to Blockstream when mempool.space is down", async () => {
    const body = JSON.stringify(fixture("esplora-txids-payment-block.json"));
    const hash = "0000000000000b45dc1b7eff00e7296691854f9477c451a67f8eb6ce16364517";
    const { fetch } = fakeFetch({
      [`GET ${MEMPOOL}/block/${hash}/txids`]: "down",
      [`GET ${BLOCKSTREAM}/block/${hash}/txids`]: { status: 200, body },
    });

    expect(await esplora({ fetch }).blockTxids(hash)).toEqual(fixture("esplora-txids-payment-block.json"));
  });

  it("a broadcast Bitcoin takes is sent", async () => {
    const { fetch, sent } = fakeFetch({ [`POST ${MEMPOOL}/tx`]: { status: 200, body: "ab".repeat(32) } });

    expect(await esplora({ fetch }).broadcast("0200")).toBe("sent");
    expect(sent).toEqual([{ url: `${MEMPOOL}/tx`, method: "POST", body: "0200" }]);
  });

  it.each([
    // Recorded 2026-11-10: T06's confirmed allowance payment broadcast again.
    ["mempool.space, already confirmed", 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}'],
    ["Blockstream, already confirmed", "sendrawtransaction RPC error -27: Transaction outputs already in utxo set"],
    // Bitcoin Core's reject reason for a transaction already in its mempool (validation.cpp).
    ["already in the mempool", 'sendrawtransaction RPC error: {"code":-26,"message":"txn-already-in-mempool"}'],
  ])("a broadcast Bitcoin already holds is known (%s)", async (_case, body) => {
    const { fetch } = fakeFetch({ [`POST ${MEMPOOL}/tx`]: { status: 400, body } });

    expect(await esplora({ fetch }).broadcast("0200")).toBe("known");
  });

  it("a broadcast Bitcoin refuses is refused with its reason, not tried elsewhere", async () => {
    // Recorded 2026-11-10: mempool.space's answer to the bytes 00.
    const body = 'sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed. Make sure the tx has at least one input."}';
    const { fetch, sent } = fakeFetch({ [`POST ${MEMPOOL}/tx`]: { status: 400, body } });

    expect(await esplora({ fetch }).broadcast("00")).toEqual({ refused: body });
    expect(sent.length).toBe(1);
  });

  it("reads the minimum fee rate", async () => {
    const body = JSON.stringify(fixture("mempool-fees.json"));
    const { fetch } = fakeFetch({ [`GET ${MEMPOOL}/v1/fees/recommended`]: { status: 200, body } });

    expect(await esplora({ fetch }).minimumFee()).toBe(1);
  });
});
