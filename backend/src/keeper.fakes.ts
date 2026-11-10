// Test fakes for the keeper's ports, answering with live recordings (backend/src/fixtures,
// recorded from sats-jar-dev.testnet, btc-client-v4.testnet and mempool.space testnet3 with
// curl on 2026-11-10). Tests that change a recording say so next to the change.
import { readFileSync } from "node:fs";
import type { Bitcoin, Broadcast, Output, TxStatus } from "./bitcoin.ts";
import type { CallOutcome, CoinView, JarView, KeeperChain, KeeperMethod, PaymentView } from "./chain.ts";

export function fixture<T>(name: string): T {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return (name.endsWith(".json") ? JSON.parse(text) : text.trim()) as T;
}

/** The T06 money moment as the dev contract recorded it (evidence/dev-money-moment.json). */
export function moneyMoment(): { steps: { step: string; sent?: { method: string; args: Record<string, unknown> } }[] } {
  return JSON.parse(readFileSync(new URL("../../evidence/dev-money-moment.json", import.meta.url), "utf8"));
}

export const TOPUP_TXID = "2edba4ef7d19b83c9d4eae99329abda471f029e99b93376c1881953a2ac0a9ea";
export const PAYMENT_TXID = "4016901c16ce105d6c6b44531406ac8e4942cb9177698c4b3be7aa939b00e69c";
export const TOPUP_HEIGHT = 5_322_873;
export const PAYMENT_HEIGHT = 5_322_884;

export type SentCall = { method: KeeperMethod; args: Record<string, unknown>; tgas: number };

export function fakeChain() {
  const jars = new Map<string, JarView>();
  const coins = new Map<string, CoinView[]>();
  const payments: PaymentView[] = [];
  const sent: SentCall[] = [];
  const answers: ((call: SentCall) => CallOutcome | undefined)[] = [];
  const state = { tip: 0, block: 0 };
  const chain: KeeperChain = {
    async jarCount() {
      return jars.size;
    },
    async jar(jarId) {
      return jars.get(jarId);
    },
    async coins(jarId) {
      return coins.get(jarId) ?? [];
    },
    async payment(paymentId) {
      return payments.find((p) => p.payment_id === paymentId);
    },
    async lightClientTip() {
      return state.tip;
    },
    async blockHeight() {
      return state.block;
    },
    async call(method, args, tgas) {
      const call = { method, args, tgas };
      sent.push(call);
      for (const answer of answers) {
        const outcome = answer(call);
        if (outcome) return outcome;
      }
      return { ok: true, hash: `near-tx-${sent.length}`, value: null };
    },
  };
  return { chain, jars, coins, payments, sent, answers, state };
}

export function fakeBitcoin() {
  const outputs = new Map<string, Output[]>();
  const statuses = new Map<string, TxStatus>();
  const hexes = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  const broadcasts: string[] = [];
  const failing = new Set<string>();
  const state = { minimumFee: 1, broadcast: "sent" as Broadcast };
  const bitcoin: Bitcoin = {
    async outputs(address) {
      if (failing.has(address)) throw new Error("esplora unreachable");
      return outputs.get(address) ?? [];
    },
    async status(txid) {
      if (failing.has(txid)) throw new Error("esplora unreachable");
      return statuses.get(txid) ?? { confirmed: false };
    },
    async txHex(txid) {
      const hex = hexes.get(txid);
      if (!hex) throw new Error(`no hex for ${txid}`);
      return hex;
    },
    async blockTxids(hash) {
      const txids = blocks.get(hash);
      if (!txids) throw new Error(`no block ${hash}`);
      return txids;
    },
    async broadcast(hex) {
      broadcasts.push(hex);
      return state.broadcast;
    },
    async minimumFee() {
      return state.minimumFee;
    },
  };
  return { bitcoin, outputs, statuses, hexes, blocks, broadcasts, failing, state };
}

/** Jar 1 as recorded, and the Bitcoin data of T06's top-up and allowance payment. */
export function devJar() {
  const chain = fakeChain();
  const btc = fakeBitcoin();
  const jar = fixture<JarView>("near-get-jar-1.json");
  chain.jars.set("1", jar);
  chain.coins.set("1", fixture<CoinView[]>("near-get-coins-1.json"));
  chain.payments.push(fixture<PaymentView>("near-get-payment-1.json"));
  const topupStatus = fixture<TxStatus>("esplora-status-topup.json");
  const paymentStatus = fixture<TxStatus>("esplora-status-payment.json");
  btc.outputs.set(jar.address, fixture<Output[]>("esplora-utxo-jar-1.json"));
  btc.statuses.set(TOPUP_TXID, topupStatus);
  btc.statuses.set(PAYMENT_TXID, paymentStatus);
  btc.hexes.set(TOPUP_TXID, fixture<string>("esplora-hex-topup.txt"));
  btc.blocks.set(topupStatus.block_hash ?? "", fixture<string[]>("esplora-txids-topup-block.json"));
  btc.blocks.set(paymentStatus.block_hash ?? "", fixture<string[]>("esplora-txids-payment-block.json"));
  chain.state.tip = 5_323_140; // the light client's tip when the fixtures were recorded
  chain.state.block = 277_000_000;
  return { ...chain, btc, jar, topupStatus, paymentStatus };
}

/**
 * Jar 1 just after T06's top-up confirmed and before it was proven (synthetic: the recorded
 * jar with no coins, payments or clock; the top-up's two 2,000-sat outputs unspent at the jar).
 */
export function devJarBeforeProof() {
  const dev = devJar();
  dev.jars.set("1", {
    ...dev.jar,
    clock: { started_at: null },
    proven_balance: "0",
    available_allowance: "0",
    next_allowance_at: null,
  });
  dev.coins.set("1", []);
  dev.payments.length = 0;
  dev.btc.outputs.set(dev.jar.address, [
    { txid: TOPUP_TXID, vout: 0, value: 2000, status: dev.topupStatus },
    { txid: TOPUP_TXID, vout: 1, value: 2000, status: dev.topupStatus },
  ]);
  dev.state.tip = TOPUP_HEIGHT + 2;
  return dev;
}
