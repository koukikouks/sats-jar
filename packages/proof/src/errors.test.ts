import { expect, test } from "vitest";
import { createProofReader, ProofUnavailableError } from "./index.ts";
import { evidence, fixture, replayFetch } from "./test-fetch.ts";

test("an RPC error reading the contract becomes a readable error without the RPC's text", async () => {
  // Recorded live: get_jar on an account that has no contract.
  const reader = createProofReader({ contract: "no-such-jar-contract.testnet", fetch: replayFetch(fixture("near-views")) });

  const failure = reader.jar("1");

  await expect(failure).rejects.toThrow(ProofUnavailableError);
  await expect(failure).rejects.toMatchObject({ source: "near" });
  await expect(failure).rejects.not.toThrow(/HANDLER_ERROR|UNKNOWN_ACCOUNT|does not exist/);
});

test("an indexer refusal becomes a readable error without the indexer's text", async () => {
  // Recorded live: the indexer's 400 answer, given here to every indexer request.
  const refused = fixture("indexer-refused").exchanges[0]?.response;
  const reader = createProofReader({
    contract: evidence().contract,
    fetch: async () => new Response(String(refused?.body), { status: refused?.status }),
  });

  const failure = reader.nearTransactions("1");

  await expect(failure).rejects.toThrow(ProofUnavailableError);
  await expect(failure).rejects.toMatchObject({ source: "indexer" });
  await expect(failure).rejects.not.toThrow(/deserialize/);
});
