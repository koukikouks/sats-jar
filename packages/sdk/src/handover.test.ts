import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, liveSuccess, memoryStorage, refusedWith, testNetwork, type TestNetwork } from "./test-network.ts";

// Oracles: T07's guardian-code vectors and Python formula; T15's account rule (first 20 hex of
// SHA-256 over the key's raw bytes, then the app account), checked in Python and by the live
// backend's own account 116192b8… for key 5UmPYo… (src/fixtures/part2-live.json).
const CHILD = "572dd46d19e80993d9c4.sats-jar-app.testnet";
const CHILD_KEY = "ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25";
const CHILD_CODE = "3754 9810 2217 9825 4110";
const OTHER_KEY = "ed25519:5shPrRr1NRJL7aTdCMqSSKxfUHvacCTEjCkCEpd26RmJ";
const OTHER_ACCOUNT = "d3205c171247a1a77656.sats-jar-app.testnet";
const OTHER_CODE = "6542 3197 7482 5746 3230";
const LIVE_ACCOUNT = "116192b82fcb34a34a31.sats-jar-app.testnet";
const LIVE_CODE = "3848 5088 2204 7746 7519";

const fullAccess = (publicKey: string) => ({ public_key: publicKey, access_key: { nonce: 1, permission: "FullAccess" } });
const functionCall = (publicKey: string) => ({
  public_key: publicKey,
  access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: CONTRACT, method_names: [] } } },
});

/** Synthetic get_jar, labelled: only the handover, shaped as the contract's `HandoverView` serializes. */
function claimedBy(childAccount: string, state: "claimed" | "confirmed" = "claimed") {
  const claim = { child_account: childAccount, child_btc_pubkey: "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319", claimed_at: "1794271800", confirmed_by: [] };
  return state === "claimed"
    ? { handover: { claimed: { ...claim, lapses_at: "1794272220" } } }
    : { handover: { confirmed: { ...claim, delay_ends_at: "1794272000" } } };
}

/** A guardian's device: set up and joined through an invite, so it has its own app-made account. */
async function guardian(options: Parameters<typeof testNetwork>[0]) {
  const net = testNetwork(options);
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
  await app.device.setUp({ pin: "482913" });
  const draft = await app.invites.start({ nickname: "Sunny's jar", guardians: 2 });
  await app.invites.join(draft.inviteTokens[0] ?? "");
  return { net, app };
}

function views(jar: unknown) {
  return [{ method: "get_jar", args: { jar_id: "7" }, result: jar }];
}

describe("the guardian's code check", () => {
  test("the code comes from the claimed account's only key as read on chain", async () => {
    const { app } = await guardian({ views: views(claimedBy(CHILD)), accessKeys: () => [fullAccess(CHILD_KEY)] });
    const check = await app.handover.check("7");
    expect(check).toMatchObject({ code: CHILD_CODE, claimedAt: 1794271800 });
  });

  test("the code follows the chain's key, never what the claimer's phone shows", async () => {
    const { app } = await guardian({ views: views(claimedBy(OTHER_ACCOUNT, "confirmed")), accessKeys: () => [fullAccess(OTHER_KEY)] });
    expect((await app.handover.check("7")).code).toBe(OTHER_CODE);
  });

  test("the live backend's own account passes the name rule and gives its key's code", async () => {
    const { app } = await guardian({ views: views(claimedBy(LIVE_ACCOUNT)) });
    expect((await app.handover.check("7")).code).toBe(LIVE_CODE);
  });

  test.each([
    ["an account of another name holding only the child's key", "adult.sats-jar-app.testnet", [fullAccess(CHILD_KEY)]],
    ["the child's name under another app account", "572dd46d19e80993d9c4.other-app.testnet", [fullAccess(CHILD_KEY)]],
    ["the child's name holding another single key", CHILD, [fullAccess(OTHER_KEY)]],
    ["the child's account with a second key", CHILD, [fullAccess(CHILD_KEY), fullAccess(OTHER_KEY)]],
    ["the child's account whose only key is a function-call key", CHILD, [functionCall(CHILD_KEY)]],
    ["an account with no keys", CHILD, []],
  ])("%s is refused: its code would prove nothing", async (_, account, keys) => {
    const { app, net } = await guardian({ views: views(claimedBy(account)), accessKeys: () => keys });
    await expect(app.handover.check("7")).rejects.toMatchObject({ code: "CLAIM_ACCOUNT_HAS_OTHER_KEYS" });
    expect(net.sent).toHaveLength(0);
  });

  test("with no open claim there is nothing to check", async () => {
    const { app } = await guardian({ views: views({ handover: "none" }) });
    await expect(app.handover.check("7")).rejects.toMatchObject({ code: "NO_OPEN_CLAIM" });
  });
});

describe("confirming and cancelling the claim", () => {
  async function checked(keysNow: () => unknown[], sendTx = () => liveSuccess()) {
    let keys = () => [fullAccess(CHILD_KEY)] as unknown[];
    const setup = await guardian({ views: views(claimedBy(CHILD)), accessKeys: () => keys(), sendTx });
    const check = await setup.app.handover.check("7");
    keys = keysNow;
    return { ...setup, check };
  }

  test("confirming sends the checked account with 1 yocto from the guardian's own account", async () => {
    const { app, net, check } = await checked(() => [fullAccess(CHILD_KEY)]);
    const sent = await app.handover.confirm("7", check);
    expect(sent.explorerUrl).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\//);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toMatchObject({
      method: "confirm_handover",
      args: { jar_id: "7", child_account: CHILD },
      deposit: 1n,
      gas: 30_000_000_000_000n,
      signerId: guardianAccount(net),
    });
  });

  test.each([
    ["a key added", () => [fullAccess(CHILD_KEY), fullAccess(OTHER_KEY)]],
    ["the key replaced by another single key", () => [fullAccess(OTHER_KEY)]],
  ])("with %s since the check, confirming is refused and nothing is sent", async (_, keysNow) => {
    const { app, net, check } = await checked(keysNow);
    await expect(app.handover.confirm("7", check)).rejects.toMatchObject({ code: "CLAIM_ACCOUNT_HAS_OTHER_KEYS" });
    expect(net.sent).toHaveLength(0);
  });

  test("a check made for another jar, or not by this app, cannot confirm", async () => {
    const { app, net, check } = await checked(() => [fullAccess(CHILD_KEY)]);
    await expect(app.handover.confirm("8", check)).rejects.toMatchObject({ code: "CLAIM_CHANGED" });
    await expect(app.handover.confirm("7", { ...check })).rejects.toMatchObject({ code: "CLAIM_CHANGED" });
    expect(net.sent).toHaveLength(0);
  });

  test("the contract's refusal of a confirmation comes back typed", async () => {
    const { app, check } = await checked(
      () => [fullAccess(CHILD_KEY)],
      () => refusedWith("CLAIM_ALREADY_CONFIRMED: grandma.testnet already confirmed this claim"),
    );
    await expect(app.handover.confirm("7", check)).rejects.toMatchObject({ code: "CLAIM_ALREADY_CONFIRMED" });
  });

  test("cancelling sends cancel_handover with 1 yocto", async () => {
    const { app, net } = await checked(() => [fullAccess(CHILD_KEY)]);
    await app.handover.cancel("7");
    expect(net.sent[0]).toMatchObject({ method: "cancel_handover", args: { jar_id: "7" }, deposit: 1n });
  });
});

function guardianAccount(net: TestNetwork): string {
  return [...net.accounts.keys()][0] ?? "";
}
