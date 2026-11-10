import { keysFromRecoveryPhrase } from "@sats-jar/device-keys";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import {
  BACKEND,
  CONTRACT,
  LIVE_REFUSED_HASH,
  LIVE_SUCCESS_HASH,
  liveSuccess,
  memoryStorage,
  refusedWith,
  testNetwork,
} from "./test-network.ts";

// Published vectors (findings-t07, T15): BIP-39's "abandon x11 about" gives NEAR key
// ed25519:6j4b… (SLIP-10, cross-checked with near-api-js), whose guardian code is
// "3754 9810 2217 9825 4110" (T07's Python oracle) and whose sponsored account is
// 572dd46d19e80993d9c4.<app> (T15's pinned vector).
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NEAR_KEY = "ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25";
const ACCOUNT = "572dd46d19e80993d9c4.sats-jar-app.testnet";
const CODE = "3754 9810 2217 9825 4110";
// BIP-84's published vector for the same phrase: m/84'/1'/0'/0/0, compressed (findings-t07).
const BTC_KEY = "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319";

const config = (storage = memoryStorage()) => ({ contract: CONTRACT, backendUrl: BACKEND, storage });

describe("the child's phone", () => {
  test("restoring from the recovery phrase brings back the same account, with the phone's key as its only key", async () => {
    const net = testNetwork({});
    const storage = memoryStorage();
    const phone = createApp(config(storage), net.fetch);

    await phone.child.restore({ words: PHRASE.split(" "), pin: "771204" });

    expect(await phone.device.state()).toBe("unlocked");
    expect([...net.accounts]).toEqual([[ACCOUNT, NEAR_KEY]]);
    expect(await phone.child.guardianCode()).toBe(CODE);

    const reopened = createApp(config(storage), net.fetch);
    expect(await reopened.device.state()).toBe("locked");
    await reopened.device.unlock({ pin: "771204" });
    expect(await reopened.child.guardianCode()).toBe(CODE);
  });

  test("setting up makes a 12-word phrase, checks the words typed back, then makes an account whose only key is the phrase's", async () => {
    const net = testNetwork({});
    const phone = createApp(config(), net.fetch);

    const { words, check } = await phone.child.startSetUp();
    expect(words).toHaveLength(12);
    expect(new Set(check).size).toBe(3);
    expect(check.every((i) => Number.isInteger(i) && i >= 0 && i < 12)).toBe(true);

    const typed = check.map((index) => ({ index, word: words[index] ?? "" }));
    const wrong = typed.map((t, n) => (n === 0 ? { ...t, word: t.word === "zoo" ? "abandon" : "zoo" } : t));
    await expect(phone.child.finishSetUp({ words: wrong, pin: "771204" })).rejects.toMatchObject({ code: "WRONG_RECOVERY_WORDS" });
    expect(await phone.device.state()).toBe("new");
    expect(net.accounts.size).toBe(0);

    await phone.child.finishSetUp({ words: typed, pin: "771204" });
    expect(await phone.device.state()).toBe("unlocked");
    // Oracle: seam 2's own derivation, checked there against published BIP-39/SLIP-10 vectors.
    const key = keysFromRecoveryPhrase(words.join(" ")).near.publicKey;
    expect([...net.accounts.values()]).toEqual([key]);
  });

  test("only the asked positions count, a finish without a start is refused, and a set-up phone is never set up again", async () => {
    const net = testNetwork({});
    const phone = createApp(config(), net.fetch);
    await expect(phone.child.finishSetUp({ words: [], pin: "771204" })).rejects.toMatchObject({ code: "NO_RECOVERY_PHRASE" });

    const { words, check } = await phone.child.startSetUp();
    const other = [...Array(12).keys()].find((i) => !check.includes(i)) ?? 0;
    const shifted = [...check.slice(1), other].map((index) => ({ index, word: words[index] ?? "" }));
    await expect(phone.child.finishSetUp({ words: shifted, pin: "771204" })).rejects.toMatchObject({ code: "WRONG_RECOVERY_WORDS" });

    await phone.child.finishSetUp({ words: check.map((index) => ({ index, word: ` ${(words[index] ?? "").toUpperCase()} ` })), pin: "771204" });
    await expect(phone.child.startSetUp()).rejects.toMatchObject({ code: "ALREADY_SET_UP" });
    await expect(phone.child.restore({ words: PHRASE.split(" "), pin: "1" })).rejects.toMatchObject({ code: "ALREADY_SET_UP" });
  });

  test("a claim is sent from the phone's own account with the phrase's Bitcoin key and 1 yocto", async () => {
    const net = testNetwork({ sendTx: () => liveSuccess() });
    const phone = createApp(config(), net.fetch);
    await phone.child.restore({ words: PHRASE.split(" "), pin: "771204" });

    const sent = await phone.child.claim("7");

    expect(sent).toEqual({ explorerUrl: `https://testnet.nearblocks.io/txns/${LIVE_SUCCESS_HASH}` });
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toMatchObject({
      signerId: ACCOUNT,
      publicKey: NEAR_KEY,
      receiverId: CONTRACT,
      method: "claim_handover",
      args: { jar_id: "7", child_account: ACCOUNT, child_btc_pubkey: BTC_KEY },
      gas: 30_000_000_000_000n,
      deposit: 1n,
    });
  });

  test("a refused claim comes back typed with its link; an adult's device cannot claim and sends nothing", async () => {
    const net = testNetwork({ sendTx: () => refusedWith("CLAIM_OPEN: jar 7 already has an open claim by someone.testnet") });
    const phone = createApp(config(), net.fetch);
    await phone.child.restore({ words: PHRASE.split(" "), pin: "771204" });
    await expect(phone.child.claim("7")).rejects.toMatchObject({
      code: "CLAIM_OPEN",
      explorerUrl: `https://testnet.nearblocks.io/txns/${LIVE_REFUSED_HASH}`,
    });

    const adult = createApp(config(), net.fetch);
    await adult.device.setUp({ pin: "482913" });
    await expect(adult.child.claim("7")).rejects.toMatchObject({ code: "NO_RECOVERY_PHRASE" });
    await expect(adult.child.guardianCode()).rejects.toMatchObject({ code: "NO_RECOVERY_PHRASE" });
    expect(net.sent).toHaveLength(1);
  });
});
