// The keeper: one pass over every jar and payment, calling only methods anyone may call.
// No server, file system or timers here; `server.ts` schedules it and `POST /keeper/run` runs it.
import { topupProof } from "@sats-jar/scripts/src/merkle.ts";
import type { Bitcoin, TxStatus } from "./bitcoin.ts";
import type { CallOutcome, JarView, KeeperChain, KeeperMethod, PaymentView } from "./chain.ts";

/** Confirmations the contract counts on testnet (findings T03), on the light client's tip. */
const CONFIRMATIONS = 3;
/** The contract's dust floor: smaller outputs are refused as BELOW_DUST. */
const DUST_FLOOR = 1_000;
/** The contract's documented gas floors (findings T03, T04). */
const PROOF_TGAS = 60;
/** Per signature, and for the signing callback plus the call's own work: k x 15 + 30 + 20. */
const SIGN_TGAS = 15;
const CALLBACK_TGAS = 50;
/** The most inputs a payment takes (spec); the keeper cannot know how many the rule will pick. */
const MAX_INPUTS = 10;
/**
 * After a proof refused for anything but too few confirmations (NOT_IN_CHAIN: the block may
 * have left the light client's window), wait this long and this many new tips, so neither a
 * testnet3 block storm nor repeated "run now" presses resend it at every tip.
 */
const PROOF_HOLD_SECONDS = 3_600;
const PROOF_HOLD_TIPS = 6;

export type Step = {
  /** "check": reading NEAR or Bitcoin failed. */
  action: KeeperMethod | "broadcast" | "check";
  jarId?: string;
  paymentId?: string;
  /** The output (`txid:vout`) or Bitcoin transaction the step is about. */
  target?: string;
  /** "waiting": nothing sent this run (too early, or a refusal whose cause has not changed). */
  result: "done" | "refused" | "waiting" | "failed";
  code?: string | null;
  message?: string;
  nearTx?: string;
};

export type KeeperReport = { startedAt: number; steps: Step[] };

export type Keeper = { run(): Promise<KeeperReport> };

/** Where the chains stood when a run began. */
type Now = { tip: number; block: number; time: number };

/**
 * A refused call is held back while `fingerprint` (the state it depends on) is unchanged and
 * the tip, the clock or the NEAR block is still short of these.
 */
type Hold = {
  fingerprint: string;
  tip: number;
  time: number;
  block: number;
  code: string | null;
  message: string;
};

export function createKeeper(deps: { chain: KeeperChain; bitcoin: Bitcoin; now: () => number }): Keeper {
  const { chain, bitcoin } = deps;
  // In memory only: a restart costs at most one more refused call per item.
  const holds = new Map<string, Hold>();
  let running: Promise<KeeperReport> | undefined;

  async function pass(): Promise<KeeperReport> {
    const steps: Step[] = [];
    const report: KeeperReport = { startedAt: deps.now(), steps };
    const now: Now = {
      tip: await chain.lightClientTip(),
      block: await chain.blockHeight(),
      time: deps.now(),
    };
    const payments = await allPayments();

    // Jars with a payment still in flight after settling: no new allowance for them yet.
    const busy = new Set<string>();
    for (const payment of payments) {
      if (finished(payment)) continue;
      busy.add(payment.jar_id);
      await guarded(steps, { paymentId: payment.payment_id }, async () => {
        steps.push(...(await settle(payment, now)));
        const after = await chain.payment(payment.payment_id);
        if (after && finished(after)) busy.delete(payment.jar_id);
      });
    }

    // A payment's own outputs (its change) become coins through confirm_payment, not prove_topup.
    const paymentTxids = new Set(payments.map((p) => p.txid));
    const jars = await chain.jarCount();
    for (let id = 1; id <= jars; id++) {
      const jarId = String(id);
      await guarded(steps, { jarId }, async () => {
        const jar = await chain.jar(jarId);
        if (!jar) return;
        const proofs = await proveTopups(jar, now, paymentTxids);
        steps.push(...proofs);
        if (busy.has(jarId)) return;
        // A proven top-up changes the balance the allowance is paid from.
        const fresh = proofs.some((s) => s.result === "done") ? await chain.jar(jarId) : jar;
        // The clock is read again: a proof just made starts the jar's clock at its block time.
        const at = { ...now, time: deps.now() };
        if (fresh && allowanceDue(fresh, at.time)) steps.push(...(await requestAllowance(fresh, at)));
      });
    }
    return report;
  }

  async function requestAllowance(jar: JarView, now: Now): Promise<Step[]> {
    const feeRate = Math.max(1, Math.ceil(await bitcoin.minimumFee()));
    const period = Math.floor((now.time - Number(jar.clock.started_at)) / Number(jar.create_args.period));
    const depends = [period, jar.next_allowance_at, jar.proven_balance, jar.available_allowance, feeRate];
    const { step, outcome } = await send(
      { key: `request_allowance:${jar.jar_id}`, fingerprint: depends.join("|"), now },
      () => ({ tip: Infinity, time: Infinity, block: Infinity }),
      "request_allowance",
      { jar_id: jar.jar_id, fee_rate: String(feeRate) },
      MAX_INPUTS * SIGN_TGAS + CALLBACK_TGAS,
      { jarId: jar.jar_id },
    );
    if (!outcome?.ok) return [step];
    // The callback has run: the payment is signed (broadcast it now) or its signing failed.
    const payment = await chain.payment(String(outcome.value));
    return [step, ...(payment ? await settle(payment, now) : [])];
  }

  /**
   * Moves a payment of any kind one step on: retries a failed or stalled signing, broadcasts a
   * signed payment, and confirms it once it is 3 deep on the light client.
   */
  async function settle(payment: PaymentView, now: Now): Promise<Step[]> {
    const id = payment.payment_id;
    const about = { paymentId: id, target: payment.txid };
    if (payment.status === "signing" || payment.status === "signing_failed") {
      const { step, outcome } = await send(
        { key: `retry_signing:${id}`, fingerprint: payment.status, now },
        (refused) => {
          // An answer may still come; the contract names the block from which to retry.
          const from = /retry from block (\d+)/.exec(refused.message)?.[1];
          return { tip: 0, time: 0, block: from ? Number(from) : Infinity };
        },
        "retry_signing",
        { payment_id: id },
        payment.inputs.length * SIGN_TGAS + CALLBACK_TGAS,
        about,
      );
      if (step.code === "SIGNING_IN_PROGRESS") step.result = "waiting";
      if (!outcome?.ok) return [step];
      const after = await chain.payment(id);
      return [step, ...(after ? await settle(after, now) : [])];
    }
    if (payment.status !== "signed") return [];
    const status = await bitcoin.status(payment.txid);
    if (!status.confirmed) {
      // Sent again every run until it is in a block: costs nothing, and covers a dropped tx.
      const sent = await bitcoin.broadcast(payment.signed_tx ?? "");
      if (sent === "sent") return [{ action: "broadcast", ...about, result: "done" }];
      if (sent === "known") {
        return [{ action: "broadcast", ...about, result: "waiting", message: "Bitcoin already has it" }];
      }
      return [{ action: "broadcast", ...about, result: "failed", message: sent.refused }];
    }
    const proof = await deepProof(payment.txid, status, now.tip);
    if (typeof proof === "string") return [{ action: "confirm_payment", ...about, result: "waiting", message: proof }];
    const { step } = await send(
      { key: `confirm_payment:${id}`, fingerprint: "", now },
      proofHold(now),
      "confirm_payment",
      { payment_id: id, proof },
      PROOF_TGAS,
      about,
    );
    return [step];
  }

  async function proveTopups(jar: JarView, now: Now, paymentTxids: Set<string>): Promise<Step[]> {
    const steps: Step[] = [];
    const jarId = jar.jar_id;
    const known = new Set((await chain.coins(jarId)).map((c) => `${c.txid}:${c.vout}`));
    for (const output of await bitcoin.outputs(jar.address)) {
      const target = `${output.txid}:${output.vout}`;
      if (known.has(target) || paymentTxids.has(output.txid) || output.value < DUST_FLOOR) continue;
      const proof = await deepProof(output.txid, output.status, now.tip);
      if (typeof proof === "string") continue;
      const tx = await bitcoin.txHex(output.txid);
      const { step } = await send(
        { key: `prove_topup:${jarId}:${target}`, fingerprint: "", now },
        proofHold(now),
        "prove_topup",
        { jar_id: jarId, tx, vout: output.vout, proof },
        PROOF_TGAS,
        { jarId, target },
      );
      steps.push(step);
    }
    return steps;
  }

  /**
   * Sends one call unless an earlier refusal of it still holds; remembers a refusal with what
   * it waits for (`hold`), so idle runs send nothing.
   */
  async function send(
    memory: { key: string; fingerprint: string; now: Now },
    hold: (refused: { code: string | null; message: string }) => Pick<Hold, "tip" | "time" | "block">,
    method: KeeperMethod,
    args: Record<string, unknown>,
    tgas: number,
    about: Pick<Step, "jarId" | "paymentId" | "target">,
  ): Promise<{ step: Step; outcome?: CallOutcome }> {
    const { key, fingerprint, now } = memory;
    const held = holds.get(key);
    if (
      held &&
      held.fingerprint === fingerprint &&
      (now.tip < held.tip || now.time < held.time || now.block < held.block)
    ) {
      const step: Step = { action: method, ...about, result: "waiting", code: held.code, message: held.message };
      return { step };
    }
    const outcome = await chain.call(method, args, tgas);
    if (outcome.ok) {
      holds.delete(key);
      return { step: { action: method, ...about, result: "done", nearTx: outcome.hash }, outcome };
    }
    holds.set(key, { fingerprint, code: outcome.code, message: outcome.message, ...hold(outcome) });
    const step: Step = {
      action: method,
      ...about,
      result: "refused",
      code: outcome.code,
      message: outcome.message,
      nearTx: outcome.hash,
    };
    return { step, outcome };
  }

  /** The inclusion proof of `txid` once 3 deep on the light client, else why not yet. */
  async function deepProof(txid: string, status: TxStatus, tip: number) {
    const { confirmed, block_height: height, block_hash: blockHash } = status;
    if (!confirmed || height === undefined || blockHash === undefined) return "not yet in a block";
    const depth = tip - height + 1;
    if (depth < CONFIRMATIONS) return `${Math.max(depth, 0)} of ${CONFIRMATIONS} confirmations on the light client`;
    return topupProof(blockHash, await bitcoin.blockTxids(blockHash), txid);
  }

  /** Every payment; ids run from 1 and are never removed. */
  async function allPayments(): Promise<PaymentView[]> {
    const payments: PaymentView[] = [];
    for (let id = 1; ; id++) {
      const payment = await chain.payment(String(id));
      if (!payment) return payments;
      payments.push(payment);
    }
  }

  return {
    // One pass at a time: a run asked for while one is going gets that run's report.
    run() {
      running ??= pass().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

/** NOT_CONFIRMED waits for the next tip; any other proof refusal waits an hour and 6 tips. */
function proofHold(now: Now) {
  return (refused: { code: string | null }) =>
    refused.code === "NOT_CONFIRMED"
      ? { tip: now.tip + 1, time: 0, block: 0 }
      : { tip: now.tip + PROOF_HOLD_TIPS, time: now.time + PROOF_HOLD_SECONDS, block: 0 };
}

/**
 * Runs one payment's or jar's work; an RPC or Bitcoin API failure is reported and the run moves
 * on to the next. A payment whose state is unknown keeps its jar from a new allowance.
 */
async function guarded(
  steps: Step[],
  about: Pick<Step, "jarId" | "paymentId">,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    steps.push({ action: "check", ...about, result: "failed", message: (error as Error).message });
  }
}

function finished(payment: PaymentView): boolean {
  return payment.status === "confirmed" || payment.status === "cancelled";
}

/**
 * Whether an allowance is due at `now` (unix s) as far as `get_jar` shows. The contract's own
 * checks are finer (fee budget, dust, size); a refusal it gives is reported and held.
 */
function allowanceDue(jar: JarView, now: number): boolean {
  if (jar.next_allowance_at === null || Number(jar.next_allowance_at) > now) return false;
  if (Number(jar.available_allowance) === 0 || Number(jar.proven_balance) === 0) return false;
  // From the end of a confirmed handover's delay, no allowance runs (Handover::payouts_stopped).
  const { handover } = jar;
  if (handover === "none" || "claimed" in handover) return true;
  return "confirmed" in handover && Number(handover.confirmed.delay_ends_at) > now;
}
