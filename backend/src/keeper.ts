// The keeper: one pass over every jar and payment, calling only methods anyone may call.
// No server, file system or timers here; `server.ts` schedules it and `POST /keeper/run` runs it.
import { topupProof } from "@sats-jar/scripts/src/merkle.ts";
import type { Bitcoin, TxStatus } from "./bitcoin.ts";
import type { CallOutcome, CoinView, JarView, KeeperChain, KeeperMethod, PaymentView } from "./chain.ts";

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
/** Refusals that only say the time named in `get_jar` has not yet come by the block's clock. */
const TIME_REFUSALS = new Set(["BEFORE_UNLOCK", "HANDOVER_DELAY_RUNNING", "DELAY_NOT_PASSED"]);
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
        const coins = await chain.coins(jarId);
        const { steps: proofs, atOldAddresses } = await proveTopups(jar, coins, now, paymentTxids);
        steps.push(...proofs);
        // A proven top-up changes the balance new payments are paid from, and may be a stray.
        const proven = proofs.some((s) => s.result === "done");
        const fresh = proven ? await chain.jar(jarId) : jar;
        if (!fresh) return;
        // A stray is a free coin at an old address; a coin in a sweep is reserved, not free.
        const strays = (proven ? await chain.coins(jarId) : coins)
          .map((c) => ({ ...c, outpoint: `${c.txid}:${c.vout}` }))
          .filter((c) => c.status === "confirmed" && atOldAddresses.has(c.outpoint))
          .map((c) => c.outpoint);
        // The clock is read again: a proof just made starts the jar's clock at its block time.
        const at = { ...now, time: deps.now() };
        for (const work of dueWork(fresh, at.time, strays)) {
          // One payment at a time: a jar with a payment in flight starts no other this run.
          if (busy.has(jarId)) return;
          const started = await startPayment(fresh, work, at);
          steps.push(...started.steps);
          if (started.paymentId) busy.add(jarId);
        }
      });
    }
    return report;
  }

  /**
   * Sends one call that starts a payment from the jar, then settles the new payment at once
   * (broadcasts it). A refusal is held until what the call depends on changes.
   */
  async function startPayment(
    jar: JarView,
    work: Work,
    now: Now,
  ): Promise<{ steps: Step[]; paymentId?: string }> {
    const feeRate = Math.max(1, Math.ceil(await bitcoin.minimumFee()));
    const { step, outcome } = await send(
      { key: `${work.method}:${jar.jar_id}`, fingerprint: [...work.depends, feeRate].join("|"), now },
      // A refusal for time not yet passed comes from the host's clock running ahead of block
      // time: try again on a later run. Any other waits for the jar to change.
      (refused) =>
        refused.code !== null && TIME_REFUSALS.has(refused.code)
          ? { tip: 0, time: now.time + 1, block: 0 }
          : { tip: Infinity, time: Infinity, block: Infinity },
      work.method,
      { jar_id: jar.jar_id, ...work.args, fee_rate: String(feeRate) },
      MAX_INPUTS * SIGN_TGAS + CALLBACK_TGAS,
      { jarId: jar.jar_id },
    );
    // null: an empty jar moved in this call, with no payment.
    if (!outcome?.ok || outcome.value === null) return { steps: [step] };
    // The callback has run: the payment is signed (broadcast it now) or its signing failed.
    const paymentId = String(outcome.value);
    const payment = await chain.payment(paymentId);
    return { steps: [step, ...(payment ? await settle(payment, now) : [])], paymentId };
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
      // The call succeeds even when the signing fails again (the callback records it), so the
      // next retry waits for a later run: at most one retry per payment per run.
      const after = await chain.payment(id);
      if (after?.status === "signed") return [step, ...(await settle(after, now))];
      holds.set(`retry_signing:${id}`, {
        fingerprint: after?.status ?? payment.status,
        tip: 0,
        time: 0,
        block: now.block + 1,
        code: null,
        message: "the retried signing did not complete; retrying next run",
      });
      return [step];
    }
    if (payment.status !== "signed") return [];
    const status = await bitcoin.status(payment.txid);
    if (!status.confirmed) {
      if (payment.signed_tx === null) {
        return [{ action: "broadcast", ...about, result: "failed", message: "get_payment shows no signed transaction" }];
      }
      // Sent again every run until it is in a block: costs nothing, and covers a dropped tx.
      const sent = await bitcoin.broadcast(payment.signed_tx);
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

  /** Proves the jar's unproven top-ups; also answers which outputs sit at its old addresses. */
  async function proveTopups(
    jar: JarView,
    coins: CoinView[],
    now: Now,
    paymentTxids: Set<string>,
  ): Promise<{ steps: Step[]; atOldAddresses: Set<string> }> {
    const steps: Step[] = [];
    const jarId = jar.jar_id;
    const known = new Set(coins.map((c) => `${c.txid}:${c.vout}`));
    const current = await bitcoin.outputs(jar.address);
    // A top-up to an address the jar moved away from (a stray) is proven like any other.
    const old = [];
    for (const address of jar.old_addresses) old.push(...(await bitcoin.outputs(address)));
    const atOldAddresses = new Set(old.map((o) => `${o.txid}:${o.vout}`));
    for (const output of [...current, ...old]) {
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
    return { steps, atOldAddresses };
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
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ action: "check", ...about, result: "failed", message });
  }
}

function finished(payment: PaymentView): boolean {
  return payment.status === "confirmed" || payment.status === "cancelled";
}

/** A call that starts a payment from a jar, and the jar state its refusal depends on. */
type Work = {
  method: "complete_handover" | "accept_transfer" | "rehome_stray" | "execute_emergency" | "request_allowance";
  args: Record<string, unknown>;
  depends: unknown[];
};

/**
 * The payments due from a jar at `now` (unix s) as far as `get_jar` shows, in the order they
 * are tried. The contract's own checks are finer (fee budget, dust, size); a refusal it gives
 * is reported and held.
 */
function dueWork(jar: JarView, now: number, strays: string[]): Work[] {
  const work: Work[] = [];
  const { handover, transfer } = jar;
  if (typeof handover === "object") {
    // The first call needs the delay over and the jar unlocked; later ones, a fixed coin left.
    const first =
      "confirmed" in handover &&
      Number(handover.confirmed.delay_ends_at) <= now &&
      Number(jar.create_args.unlock_at) <= now;
    const next = "completing" in handover && handover.completing.coins_to_move > 0;
    if (first || next) {
      const { coins_to_move: toMove, coins_left: left } = next ? handover.completing : { coins_to_move: 0, coins_left: 0 };
      work.push({
        method: "complete_handover",
        args: {},
        depends: [first ? "confirmed" : "completing", toMove, left, jar.proven_balance],
      });
    }
  }
  if (typeof transfer === "object" && "accepted" in transfer && transfer.accepted.coins_to_move > 0) {
    // Once accepted, anyone sends the next batch with the stored key, and no deposit.
    const { btc_pubkey: key, coins_to_move: toMove, coins_left: left } = transfer.accepted;
    work.push({ method: "accept_transfer", args: { btc_pubkey: key }, depends: ["accepted", toMove, left, jar.proven_balance] });
  }
  // While a handover completes or a transfer is accepted, its own batches move every coin.
  const rehoming =
    (typeof handover === "object" && "completing" in handover) || (typeof transfer === "object" && "accepted" in transfer);
  if (strays.length > 0 && !rehoming) {
    work.push({ method: "rehome_stray", args: {}, depends: [...strays].sort() });
  }
  const { emergency } = jar;
  if (typeof emergency === "object" && "open" in emergency && !payoutsStopped(jar, now)) {
    const { proposal_id: id, amount, delay_ends_at: ends } = emergency.open;
    if (ends !== null && Number(ends) <= now) {
      work.push({ method: "execute_emergency", args: {}, depends: [id, amount, ends, jar.proven_balance] });
    }
  }
  if (allowanceDue(jar, now)) {
    const period = Math.floor((now - Number(jar.clock.started_at)) / Number(jar.create_args.period));
    work.push({
      method: "request_allowance",
      args: {},
      depends: [period, jar.next_allowance_at, jar.proven_balance, jar.available_allowance],
    });
  }
  return work;
}

function allowanceDue(jar: JarView, now: number): boolean {
  if (jar.next_allowance_at === null || Number(jar.next_allowance_at) > now) return false;
  if (Number(jar.available_allowance) === 0 || Number(jar.proven_balance) === 0) return false;
  return !payoutsStopped(jar, now);
}

/** From the end of a confirmed handover's delay, no allowance or emergency payment runs. */
function payoutsStopped(jar: JarView, now: number): boolean {
  const { handover } = jar;
  if (handover === "none" || "claimed" in handover) return false;
  return !("confirmed" in handover && Number(handover.confirmed.delay_ends_at) > now);
}
