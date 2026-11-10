import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import {
  BACKEND,
  CONTRACT,
  LIVE_SUCCESS_HASH,
  fixture,
  liveRejected,
  liveSuccess,
  lost,
  memoryStorage,
  testNetwork,
  type SendTx,
} from "./test-network.ts";
import type { DeviceStorage } from "./api.ts";

// Part 2's writes, seen through the child's claim (any part-2 write takes the same path).
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const LINK = `https://testnet.nearblocks.io/txns/${LIVE_SUCCESS_HASH}`;
// FastNEAR's live row for T15's create_jar (src/fixtures/part2-live.json).
const indexedRow = (
  fixture("part2-live").exchanges.find((e) => e.request.url.endsWith("/v0/transactions") && JSON.stringify(e.request.body).includes(LIVE_SUCCESS_HASH))
    ?.response.body as { transactions: unknown[] }
).transactions[0] as { transaction: Record<string, unknown> };

async function phone(options: Parameters<typeof testNetwork>[0], storage: DeviceStorage = memoryStorage()) {
  const net = testNetwork(options);
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage }, net.fetch);
  await app.child.restore({ words: PHRASE.split(" "), pin: "771204" });
  return { net, app, storage };
}

describe("part 2's writes", () => {
  test("a second write waits until the first has its answer: one transaction at a time per device", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const sendTx: SendTx = async (_, attempt) => {
      if (attempt === 1) await held;
      return liveSuccess();
    };
    const { net, app } = await phone({ sendTx });

    const first = app.child.claim("7");
    const second = app.child.claim("8");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(net.sent.map((c) => c.args.jar_id)).toEqual(["7"]);
    expect(net.signings()).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(net.sent.map((c) => c.args.jar_id)).toEqual(["7", "8"]);
  });

  test("after a lost answer, the retry resends the very same signed bytes and signs nothing new", async () => {
    const { net, app } = await phone({ sendTx: (_, attempt) => (attempt === 1 ? lost() : liveSuccess()) });

    await expect(app.child.claim("7")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await app.child.claim("7")).toEqual({ explorerUrl: LINK });

    expect(net.sent).toHaveLength(2);
    expect(net.sent[1]?.signedTx).toBe(net.sent[0]?.signedTx);
    expect(net.signings()).toBe(1);
  });

  test("a retry whose first transaction landed takes its outcome and sends nothing, even from a reopened app", async () => {
    let landed = false;
    const { net, storage } = await phone({
      sendTx: () => {
        landed = true;
        return lost();
      },
      txStatus: () => (landed ? liveSuccess() : undefined),
    });
    const first = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage }, net.fetch);
    await first.device.unlock({ pin: "771204" });
    await expect(first.child.claim("7")).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const reopened = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage }, net.fetch);
    await reopened.device.unlock({ pin: "771204" });
    expect(await reopened.child.claim("7")).toEqual({ explorerUrl: LINK });
    expect(net.sent).toHaveLength(1);
  });

  test("bytes the chain now rejects that landed long ago (only the full-history indexer has them) are not signed again", async () => {
    let landed = false;
    let asked = "";
    const { net, app } = await phone({
      sendTx: (_, attempt) => {
        if (attempt === 1) {
          landed = true;
          return lost();
        }
        return liveRejected(); // the nonce is used: it landed, and RPC has since forgotten it
      },
      // Synthetic, labelled: FastNEAR's live row for T15's create_jar, under this transaction's hash.
      indexed: (hash) => {
        asked = hash;
        return landed ? { ...indexedRow, transaction: { ...indexedRow.transaction, hash } } : undefined;
      },
    });

    await expect(app.child.claim("7")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await app.child.claim("7")).toEqual({ explorerUrl: `https://testnet.nearblocks.io/txns/${asked}` });
    expect(asked).not.toBe("");
    expect(net.signings()).toBe(1);
    expect(net.sent).toHaveLength(2);
  });

  test("only bytes no record of the chain or the indexer has ever seen are given up, and then signed afresh once", async () => {
    const { net, app } = await phone({
      sendTx: (_, attempt) => (attempt === 1 ? lost() : attempt === 2 ? liveRejected() : liveSuccess()),
    });

    await expect(app.child.claim("7")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await app.child.claim("7")).toEqual({ explorerUrl: LINK });
    expect(net.signings()).toBe(2);
    expect(net.sent).toHaveLength(3);
  });

  test("no part-2 write leaves a device that is not set up, or is locked", async () => {
    const net = testNetwork({ sendTx: () => liveSuccess() });
    const storage = memoryStorage();
    const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage }, net.fetch);
    const writes = (a: typeof app) => [
      () => a.child.claim("7"),
      () => a.handover.cancel("7"),
      () => a.emergency.propose("7", 2_000),
      () => a.emergency.approve("7", 1),
      () => a.emergency.cancel("7"),
      () => a.holder.cancelTransfer("7"),
      () => a.tryIt.earlySpend("7"),
      () => a.tryIt.outsiderApproval("7"),
    ];
    for (const write of writes(app)) await expect(write()).rejects.toMatchObject({ code: "NO_DEVICE" });

    await app.child.restore({ words: PHRASE.split(" "), pin: "771204" });
    app.device.lock();
    for (const write of writes(app)) await expect(write()).rejects.toMatchObject({ code: "LOCKED" });
    expect(net.sent).toHaveLength(0);
  });

  test("a damaged stored record reads as UNAVAILABLE and nothing is signed", async () => {
    const { net, app, storage } = await phone({ sendTx: () => liveSuccess() });
    await storage.set("sats-jar:sending:claim_handover:7", "{not json");
    await expect(app.child.claim("7")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(net.signings()).toBe(0);
  });
});
