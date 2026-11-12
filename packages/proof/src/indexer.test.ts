import { expect, test } from "vitest";
import { contractHistory } from "./indexer.ts";
import { evidence, fixture, replayFetch } from "./test-fetch.ts";

test("walks the indexer's pages until it stops giving a resume token", async () => {
  const record = evidence();
  // Recorded live: the contract's whole history in one page of 200, and again in pages of 3.
  const whole = fixture("indexer").exchanges[0]?.response.body as { account_txs: { transaction_hash: string }[] };

  const rows = await contractHistory(replayFetch(fixture("indexer")), record.contract, 3);

  expect(rows.map((r) => r.transaction_hash)).toEqual(whole.account_txs.map((t) => t.transaction_hash));
  expect(rows).toHaveLength(8);
});
