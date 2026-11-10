// Live check against testnet: PROOF_LIVE=1 pnpm vitest run packages/proof/src/live.test.ts
// Off by default so the suite stays offline. A subset check, since later tickets add transactions.
import { describe, expect, test } from "vitest";
import { createProofReader } from "./index.ts";
import { evidence } from "./test-fetch.ts";

const record = evidence();

describe.runIf(process.env.PROOF_LIVE === "1")("live proof data for jar 1 on the dev contract", () => {
  const reader = createProofReader({ contract: record.contract });

  test("every NEAR transaction of the money moment is listed, the refusal with its reason", async () => {
    const txs = await reader.nearTransactions("1");
    const listed = new Map(txs.map((t) => [t.hash, t]));

    for (const step of record.steps.filter((s) => s.step.endsWith("(outcome)"))) {
      const tx = listed.get(step.near_tx ?? "");
      expect(tx, step.step).toBeDefined();
      expect(tx?.ok).toBe(step.ok);
      expect(tx?.explorerUrl).toBe(step.explorer);
      if (step.error) expect(`${tx?.refusal?.code}: ${tx?.refusal?.reason}`).toBe(step.error);
    }
    console.log(txs.map((t) => `${t.hash} ${t.method} ${t.ok ? "ok" : `refused ${t.refusal?.code}`}`).join("\n"));
  }, 60_000);

  test("the jar's views and every Bitcoin transaction of the money moment are there", async () => {
    const jar = await reader.jar("1");
    expect(jar.address).toBe((record.jar.view as { address: string }).address);

    const txs = await reader.bitcoinTransactions(jar);
    const txids = txs.map((t) => t.txid);
    for (const step of record.steps.filter((s) => s.btc_tx)) expect(txids).toContain(step.btc_tx);
    console.log(txs.map((t) => `${t.txid} +${t.received} -${t.sent} fee ${t.fee} block ${t.blockHeight}`).join("\n"));
  }, 60_000);
});
