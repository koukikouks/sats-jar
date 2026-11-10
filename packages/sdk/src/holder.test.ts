import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { base58check } from "./receive-code.ts";
import { BACKEND, CONTRACT, LIVE_SUCCESS_HASH, fixture, liveSuccess, memoryStorage, refusedWith, testNetwork, type Fixture } from "./test-network.ts";

// The holder after handover: the child's phone, restored from BIP-39's published phrase
// (account 572dd… by T15's rule, Bitcoin key 02e7ab… by BIP-84's vector).
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT = "572dd46d19e80993d9c4.sats-jar-app.testnet";
const BTC_KEY = "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319";
const PAYEE = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
const TGAS = 1_000_000_000_000n;

type View = { method: string; args: Record<string, unknown>; result: unknown };

/** Synthetic coins, labelled, shaped as the contract's `CoinView` serializes (snake_case status). */
function coin(value: number, status: "confirmed" | "reserved" | "spent", n: number) {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, value: String(value), status, payment_id: status === "confirmed" ? null : "1" };
}
const coinsView = (page: unknown[], from = 0): View => ({ method: "get_coins", args: { jar_id: "7", from_index: from, limit: 100 }, result: page });

/** Synthetic, labelled: mempool.space is down. */
const mempoolDown: Fixture = {
  recorded_at: "synthetic",
  note: "mempool.space answering 503",
  exchanges: [{ request: { method: "GET", url: "https://mempool.space/testnet/api/v1/fees/recommended", body: null }, response: { status: 503, body: "" } }],
};

async function holder(views: View[], fixtures: Fixture[] = [fixture("part2-live")]) {
  const net = testNetwork({ views, fixtures, sendTx: () => liveSuccess() });
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
  await app.child.restore({ words: PHRASE.split(" "), pin: "771204" });
  return { net, app };
}

describe("the holder's spend", () => {
  test("sends request_spend at the explorer's half-hour fee rate, with gas for the jar's free coins", async () => {
    const { net, app } = await holder([coinsView([coin(60_000, "confirmed", 1), coin(5_000, "reserved", 2), coin(9_000, "spent", 3)])]);
    const sent = await app.holder.spend("7", { to: PAYEE, amount: 50_000 });
    expect(sent.explorerUrl).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\//);
    expect(net.sent[0]).toMatchObject({
      signerId: ACCOUNT,
      method: "request_spend",
      // halfHourFee 1 in the live mempool.space answer (src/fixtures/part2-live.json)
      args: { jar_id: "7", to: PAYEE, amount: "50000", fee_rate: "1" },
      deposit: 1n,
      gas: 65n * TGAS, // signer.rs required_gas(1): 15 + 30 + 20
    });
  });

  test("with mempool.space down, Blockstream's 3-block estimate is used, rounded up", async () => {
    const { net, app } = await holder([coinsView([coin(60_000, "confirmed", 1)])], [mempoolDown, fixture("part2-live")]);
    await app.holder.spend("7", { to: PAYEE, amount: 50_000 });
    expect(net.sent[0]?.args.fee_rate).toBe("6"); // the live answer's "3": 5.531
  });

  test("a changed spend never goes out while an earlier one, its answer lost, may have landed: it says the earlier one went through", async () => {
    let attempt = 0;
    const net = testNetwork({
      views: [coinsView([coin(60_000, "confirmed", 1)])],
      fixtures: [fixture("part2-live")],
      sendTx: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return liveSuccess();
      },
    });
    const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
    await app.child.restore({ words: PHRASE.split(" "), pin: "771204" });

    await expect(app.holder.spend("7", { to: PAYEE, amount: 50_000 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // The stored 50,000-sat spend is sent again as the same bytes and lands: the 20,000 one is not signed.
    await expect(app.holder.spend("7", { to: PAYEE, amount: 20_000 })).rejects.toMatchObject({
      code: "PREVIOUS_SEND_LANDED",
      explorerUrl: `https://testnet.nearblocks.io/txns/${LIVE_SUCCESS_HASH}`,
    });
    expect(net.sent.map((c) => c.args.amount)).toEqual(["50000", "50000"]);
    expect(net.sent[1]?.signedTx).toBe(net.sent[0]?.signedTx);
    expect(net.signings()).toBe(1);

    // Told, the holder decides again: a new spend is signed afresh.
    await app.holder.spend("7", { to: PAYEE, amount: 20_000 });
    expect(net.sent.map((c) => c.args.amount)).toEqual(["50000", "50000", "20000"]);
    expect(net.signings()).toBe(2);
  });

  test("a try-it spend never settles or clears a real spend still waiting for its answer", async () => {
    let attempt = 0;
    const net = testNetwork({
      views: [coinsView([coin(60_000, "confirmed", 1)])],
      fixtures: [fixture("part2-live")],
      sendTx: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return attempt === 2 ? refusedWith("SPEND_BEFORE_HANDOVER: before handover only the allowance and an emergency payment can pay out") : liveSuccess();
      },
    });
    const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
    await app.child.restore({ words: PHRASE.split(" "), pin: "771204" });
    await expect(app.holder.spend("7", { to: PAYEE, amount: 50_000 })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    await app.tryIt.earlySpend("7");
    expect(net.sent.map((c) => c.args.amount)).toEqual(["50000", "1000"]);

    await app.holder.spend("7", { to: PAYEE, amount: 50_000 });
    expect(net.sent[2]?.signedTx).toBe(net.sent[0]?.signedTx); // the real spend's own bytes, resent
  });

  test("a fee rate the holder names is sent as given; gas covers at most 10 inputs over every page of coins", async () => {
    const many = Array.from({ length: 101 }, (_, i) => coin(2_000, "confirmed", i + 1));
    const { net, app } = await holder([coinsView(many.slice(0, 100)), coinsView(many.slice(100), 100)], []);
    await app.holder.spend("7", { to: PAYEE, amount: 50_000, feeRate: 7 });
    expect(net.sent[0]).toMatchObject({ args: { fee_rate: "7" }, gas: 200n * TGAS });
  });
});

describe("transferring the jar", () => {
  test("Base58Check, the receive code's encoding, matches Bitcoin's published address example", async () => {
    // Bitcoin wiki, "Technical background of version 1 Bitcoin addresses": version 00 + HASH160.
    const payload = Uint8Array.from(Buffer.from("00f54a5851e9372b87810a8e60cdd2e7cfd80b6e31", "hex"));
    expect(await base58check.encode(payload)).toBe("1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs");
    expect(await base58check.decode("1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs")).toEqual(payload);
    expect(await base58check.decode("1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAt")).toBeNull();
  });

  test("the receiver's code names their account; the holder starts the transfer to it, and can cancel", async () => {
    const receiverNet = testNetwork({});
    const receiver = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, receiverNet.fetch);
    await receiver.child.restore({ words: PHRASE.split(" "), pin: "771204" });
    const code = await receiver.holder.receiveCode();
    expect(await base58check.decode(code)).toEqual(new TextEncoder().encode(ACCOUNT));

    const { net, app } = await holder([]);
    await app.holder.startTransfer("7", code);
    await app.holder.cancelTransfer("7");
    expect(net.sent.map(({ method, args, deposit }) => ({ method, args, deposit }))).toEqual([
      { method: "start_transfer", args: { jar_id: "7", receiver: ACCOUNT }, deposit: 1n },
      { method: "cancel_transfer", args: { jar_id: "7" }, deposit: 1n },
    ]);
  });

  test("a mistyped receive code is refused before anything is sent; an adult's device has no receive code", async () => {
    const { net, app } = await holder([]);
    const code = await app.holder.receiveCode();
    const typo = code.slice(0, 5) + (code[5] === "x" ? "y" : "x") + code.slice(6);
    await expect(app.holder.startTransfer("7", typo)).rejects.toMatchObject({ code: "BAD_RECEIVE_CODE" });
    await expect(app.holder.startTransfer("7", "0OIl")).rejects.toMatchObject({ code: "BAD_RECEIVE_CODE" });
    expect(net.sent).toHaveLength(0);

    const adult = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
    await adult.device.setUp({ pin: "482913" });
    await expect(adult.holder.receiveCode()).rejects.toMatchObject({ code: "NO_RECOVERY_PHRASE" });
  });
});

describe("accepting a transfer", () => {
  // The real contract's views of two jars with a transfer started (src/fixtures/sandbox-views.json),
  // and its own FEE_TOO_HIGH texts for them: a re-homing of the first may pay 4,993 sats and is
  // 132 vB (132,000 sats at 1,000 sat/vB), so 37 sat/vB is the most it accepts; the small jar's
  // bound is 132 sats, the 1 sat/vB cost, and its rate-2 accept was refused.
  const sandbox = (JSON.parse(readFileSync(new URL("./fixtures/sandbox-views.json", import.meta.url), "utf8")) as { views: Record<string, unknown> }).views;
  /** Synthetic, labelled: mempool.space recommending 50 sat/vB for the next half hour. */
  const busy: Fixture = {
    recorded_at: "synthetic",
    note: "mempool.space at 50 sat/vB",
    exchanges: [{ request: { method: "GET", url: "https://mempool.space/testnet/api/v1/fees/recommended", body: null }, response: { status: 200, body: { halfHourFee: 50 } } }],
  };
  const jarViews = (jar: string, coins: string): View[] => [
    { method: "get_jar", args: { jar_id: "7" }, result: sandbox[jar] },
    coinsView(sandbox[coins] as unknown[]),
  ];

  test("the receiver accepts with their own phrase's Bitcoin key, at the half-hour rate when the re-homing bound allows it", async () => {
    const { net, app } = await holder(jarViews("transfer_started", "transfer_coins"));
    await app.holder.acceptTransfer("7");
    expect(net.sent[0]).toMatchObject({
      signerId: ACCOUNT,
      method: "accept_transfer",
      args: { jar_id: "7", btc_pubkey: BTC_KEY, fee_rate: "1" },
      deposit: 1n,
      gas: 65n * TGAS,
    });
  });

  test("a busy fee market is capped at the highest rate the contract's re-homing bound accepts", async () => {
    const { net, app } = await holder(jarViews("transfer_started", "transfer_coins"), [busy]);
    await app.holder.acceptTransfer("7");
    expect(net.sent[0]?.args.fee_rate).toBe("37");
  });

  test("a small jar's re-homing is accepted only at 1 sat/vB, so that is what is sent", async () => {
    const { net, app } = await holder(jarViews("small_jar", "small_coins"), [busy]);
    await app.holder.acceptTransfer("7");
    expect(net.sent[0]?.args.fee_rate).toBe("1");
  });

  test("an adult's device cannot accept: the key must come from the receiver's own phrase", async () => {
    const net = testNetwork({});
    const adult = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
    await adult.device.setUp({ pin: "482913" });
    await expect(adult.holder.acceptTransfer("7")).rejects.toMatchObject({ code: "NO_RECOVERY_PHRASE" });
    expect(net.sent).toHaveLength(0);
  });
});
