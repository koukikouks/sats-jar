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
