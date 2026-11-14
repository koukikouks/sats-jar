import { describe, expect, test } from "vitest";
import { createProofReader, ProofUnavailableError, type JarProof } from "./index.ts";
import { evidence, fixture, replayFetch, type Fixture } from "./test-fetch.ts";

const record = evidence();
const step = (name: string) => record.steps.find((s) => s.step === name);

async function jar1(): Promise<JarProof> {
  return createProofReader({ contract: record.contract, fetch: replayFetch(fixture("near-views")) }).jar("1");
}

/** Recorded exchanges with every request to `host` failing as if the explorer were down. */
function down(host: string, ...fixtures: Fixture[]): typeof fetch {
  const replay = replayFetch(...fixtures);
  return async (input, init) => {
    if (String(input).startsWith(host)) throw new TypeError("fetch failed");
    return replay(input, init);
  };
}

describe("a jar's Bitcoin transactions", () => {
  test("lists the top-up and the allowance payment with amounts, fees, blocks and explorer links", async () => {
    const reader = createProofReader({ contract: record.contract, fetch: replayFetch(fixture("bitcoin-jar1")) });

    const txs = await reader.bitcoinTransactions(await jar1());

    const topup = step("topup confirmed");
    const payment = step("allowance payment confirmed");
    expect(txs).toHaveLength(2);
    expect(txs.find((t) => t.txid === topup?.btc_tx)).toMatchObject({
      received: record.ledger.topup,
      sent: 0,
      fee: record.ledger.topup_fee,
      blockHeight: topup?.block_height,
      explorerUrl: step("topup (broadcast)")?.explorer,
    });
    expect(txs.find((t) => t.txid === payment?.btc_tx)).toMatchObject({
      received: record.ledger.left_in_jar,
      sent: record.ledger.topup,
      fee: record.ledger.allowance_fee_from_jar,
      blockHeight: payment?.block_height,
      explorerUrl: step("allowance payment (broadcast, accepted by testnet3)")?.explorer,
    });
  });

  test("lists the transactions at the jar's old addresses too, newest first, each once", async () => {
    // jar 1 of sats-jar-dev-2.testnet after its handover (evidence/keeper-handover.json): the
    // re-homing moved its 2,000-sat coin to the child's key, then a stray 1,500 sats sent to the
    // old address was swept over, then the child paid 1,000 sats out.
    const current = "tb1qsl5kuaj5rtxl9uje7mp7t5jwgsu8zjw07svh8n43srnfm6ydxe7qslkptf";
    const old = "tb1qkw8a04c09xygyeru6zdjh28e3cwj58e8rnyr8rz99065qa0406gsx3m95q";
    const reader = createProofReader({ contract: record.contract, fetch: replayFetch(fixture("bitcoin-rehomed")) });

    const txs = await reader.bitcoinTransactions({ ...(await jar1()), address: current, oldAddresses: [old] });

    expect(txs.map((t) => [t.txid.slice(0, 8), t.blockHeight, t.received, t.sent, t.fee])).toEqual([
      ["0de8d93e", 5_323_955, 1_996, 3_236, 240], // the child's payment, change back to the jar
      ["de6c9a70", 5_323_947, 1_368, 1_500, 132], // the stray swept to the new address
      ["adf809f2", 5_323_935, 1_868, 2_000, 132], // the handover's re-homing
      ["bf9efae9", 5_323_935, 1_500, 0, 153], // the stray, sent to the old address
      ["f0061d75", 5_323_237, 2_000, 0, 153], // the first top-up
    ]);
  });

  test("puts a transaction not yet in a block first, whichever address it is at", async () => {
    const tx = (txid: string, height: number | null, to: string) => ({
      txid,
      fee: 100,
      status: height === null ? { confirmed: false } : { confirmed: true, block_height: height, block_time: 1_794_000_000 + height },
      vin: [{ prevout: { scriptpubkey_address: "tb1qoutside", value: 10_000 } }],
      vout: [{ scriptpubkey_address: to, value: 5_000 }],
    });
    // Hand-written explorer answers: a recording cannot hold a transaction still in the mempool.
    const pages: Record<string, unknown[]> = {
      "/address/new/txs": [tx("b", 20, "new")],
      "/address/old/txs": [tx("u", null, "old"), tx("c", 30, "old"), tx("a", 10, "old")],
    };
    const http: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname.replace("/testnet/api", "");
      return new Response(JSON.stringify(pages[path] ?? []));
    };
    const reader = createProofReader({ contract: record.contract, fetch: http });

    const txs = await reader.bitcoinTransactions({ ...(await jar1()), address: "new", oldAddresses: ["old"] });

    expect(txs.map((t) => t.txid)).toEqual(["u", "c", "b", "a"]);
  });

  test("falls back to Blockstream when mempool.space is down", async () => {
    const reader = createProofReader({
      contract: record.contract,
      fetch: down("https://mempool.space", fixture("bitcoin-jar1")),
    });

    const txs = await reader.bitcoinTransactions(await jar1());

    expect(txs.map((t) => t.txid).sort()).toEqual([step("topup confirmed")?.btc_tx, step("allowance payment confirmed")?.btc_tx].sort());
  });

  test.each([
    ["mempool.space", "https://mempool.space"],
    ["Blockstream", "https://blockstream.info"],
  ])("walks every history page of a busy address from %s", async (_, primary) => {
    const busy = fixture("bitcoin-busy");
    const address = "tb1qqw3jpcxkgtpgtx2g693xx4jtscwqm7crfcycfc";
    // The explorer's own count for the address, recorded with the pages.
    const stats = busy.exchanges[0]?.response.body as {
      chain_stats: { tx_count: number };
      mempool_stats: { tx_count: number };
    };
    const fetch = primary === "https://mempool.space" ? replayFetch(busy) : down("https://mempool.space", busy);
    const reader = createProofReader({ contract: record.contract, fetch });

    const txs = await reader.bitcoinTransactions({ ...(await jar1()), address });

    expect(new Set(txs.map((t) => t.txid)).size).toBe(stats.chain_stats.tx_count + stats.mempool_stats.tx_count);
  });

  test("says the Bitcoin data is unavailable when both explorers are down", async () => {
    const reader = createProofReader({
      contract: record.contract,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const failure = reader.bitcoinTransactions(await jar1());

    await expect(failure).rejects.toThrow(ProofUnavailableError);
    await expect(failure).rejects.toMatchObject({ source: "bitcoin" });
  });
});
