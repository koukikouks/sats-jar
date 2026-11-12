import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, LIVE_REFUSED_HASH, liveRejected, memoryStorage, refusedWith, testNetwork, type SendTx } from "./test-network.ts";

// The real contract's refusal texts (src/fixtures/sandbox-views.json, recorded in the sandbox).
const sandbox = (JSON.parse(readFileSync(new URL("./fixtures/sandbox-views.json", import.meta.url), "utf8")) as { views: Record<string, string> }).views;
const LINK = `https://testnet.nearblocks.io/txns/${LIVE_REFUSED_HASH}`;
// BIP-84's published test address (the abandon phrase's first receive address).
const TRY_IT_PAYEE = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";

/** A visitor's device: set up, no account yet. */
async function visitor(sendTx: SendTx) {
  const net = testNetwork({ sendTx });
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
  await app.device.setUp({ pin: "482913" });
  return { net, app };
}

describe("try it: the rule says no on chain", () => {
  test("an early spend sends a real request_spend from the caller's own account and returns the refusal with its link", async () => {
    const { net, app } = await visitor(() => refusedWith(sandbox.spend_before_handover_failure ?? ""));
    const tried = await app.tryIt.earlySpend("7");

    expect(tried).toEqual({
      code: "SPEND_BEFORE_HANDOVER",
      message: "Before handover, only the allowance and an emergency payment can pay out, and only to the child's address.",
      explorerUrl: LINK,
    });
    const [account] = [...net.accounts.keys()];
    expect(net.sent).toHaveLength(1);
    // Fee rate 0: even from the holder's own device this spend is refused (FEE_TOO_LOW), never paid.
    expect(net.sent[0]).toMatchObject({
      signerId: account,
      method: "request_spend",
      args: { jar_id: "7", to: TRY_IT_PAYEE, amount: "1000", fee_rate: "0" },
      deposit: 1n,
      gas: 30_000_000_000_000n,
    });
  });

  test("the family account's spend after handover reads 'not the holder'", async () => {
    const { net, app } = await visitor(() => refusedWith(sandbox.spend_not_holder_failure ?? ""));
    expect(await app.tryIt.afterHandover("7")).toMatchObject({ code: "NOT_THE_HOLDER", explorerUrl: LINK });
    expect(net.sent[0]).toMatchObject({ method: "request_spend", args: { fee_rate: "0" } });
  });

  test("an outsider's approval names proposal 0, which no guardian's approval could ever count toward", async () => {
    const { net, app } = await visitor(() => refusedWith(sandbox.approve_by_stranger_failure ?? ""));
    expect(await app.tryIt.outsiderApproval("7")).toMatchObject({ code: "NOT_A_GUARDIAN", explorerUrl: LINK });
    expect(net.sent[0]).toMatchObject({ method: "approve_emergency", args: { jar_id: "7", proposal_id: 0 }, deposit: 1n });
  });

  test("a transaction that fails before the rule answers is not a refusal to show; it throws", async () => {
    const { app } = await visitor(() => liveRejected());
    await expect(app.tryIt.earlySpend("7")).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
  });
});
