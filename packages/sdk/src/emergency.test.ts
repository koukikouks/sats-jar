import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, liveSuccess, memoryStorage, refusedWith, succeededWith, testNetwork, type SendTx } from "./test-network.ts";

/** An adult's device with its own account (it joined an invite, as a guardian does). */
async function adult(sendTx: SendTx) {
  const net = testNetwork({ sendTx });
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
  await app.device.setUp({ pin: "482913" });
  const draft = await app.invites.start({ nickname: "Sunny's jar", guardians: 2 });
  await app.invites.join(draft.inviteTokens[0] ?? "");
  return { net, app, account: [...net.accounts.keys()][0] ?? "" };
}

describe("the emergency payment", () => {
  test("a guardian proposes an amount and gets the proposal's id back from the contract", async () => {
    // Synthetic, labelled: the live success with propose_emergency's u32 result (the sandbox returns 1 for a jar's first).
    const { net, app, account } = await adult(() => succeededWith(1));
    const proposed = await app.emergency.propose("7", 40_000);
    expect(proposed).toEqual({ proposalId: 1, explorerUrl: expect.stringMatching(/^https:\/\/testnet\.nearblocks\.io\/txns\//) });
    expect(net.sent[0]).toMatchObject({
      signerId: account,
      method: "propose_emergency",
      args: { jar_id: "7", amount: "40000" },
      deposit: 1n,
      gas: 30_000_000_000_000n,
    });
  });

  test("a guardian approves that exact proposal, and the giver can cancel", async () => {
    const { net, app } = await adult(() => liveSuccess());
    await app.emergency.approve("7", 1);
    await app.emergency.cancel("7");
    expect(net.sent.map(({ method, args, deposit }) => ({ method, args, deposit }))).toEqual([
      { method: "approve_emergency", args: { jar_id: "7", proposal_id: 1 }, deposit: 1n },
      { method: "cancel_emergency", args: { jar_id: "7" }, deposit: 1n },
    ]);
  });

  test("the contract's refusal comes back typed, without naming the giver's account", async () => {
    const { app } = await adult(() => refusedWith("NOT_THE_GIVER: only giver.test.near, the giver, can cancel an emergency payment"));
    const refusal = await app.emergency.cancel("7").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "NOT_THE_GIVER" });
    expect((refusal as Error).message).not.toMatch(/near|giver\.test/);
  });
});
