// The keeper after the allowance (T17): handover completion, strays, emergency payments and
// transfer batches. Jar views are the ones recorded live from sats-jar-dev-2.testnet
// (backend/src/fixtures/dev2-*); changes to them are synthetic and say so.
import { describe, expect, it } from "vitest";
import type { CoinView, JarView, PaymentView } from "./chain.ts";
import { createKeeper } from "./keeper.ts";
import { fakeBitcoin, fakeChain, fixture } from "./keeper.fakes.ts";

/** Top-up A of the live run (evidence/keeper-handover.json): 2,000 sats at the jar, output 0. */
const TOPUP_A = "f0061d75026ad2f275a6b696c28a15b24465d35d1b115d696060bb54625a2699";

function dev2(name: string) {
  const chain = fakeChain();
  const btc = fakeBitcoin();
  const jar = fixture<JarView>(`dev2-get-jar-${name}.json`);
  chain.jars.set("1", jar);
  chain.state.tip = 5_330_000;
  chain.state.block = 277_100_000;
  return { ...chain, btc, jar };
}
type Dev = ReturnType<typeof dev2>;

function setJar(dev: Dev, change: Partial<JarView>) {
  dev.jars.set("1", { ...dev.jars.get("1")!, ...change });
}

/** A payment the contract answers with (synthetic: signed, not yet on Bitcoin). */
function newPayment(dev: Dev, kind: string, id = String(dev.payments.length + 1)): PaymentView {
  const payment: PaymentView = {
    payment_id: id,
    jar_id: "1",
    kind,
    status: "signed",
    txid: `${id}`.padStart(64, "c"),
    inputs: [{ txid: TOPUP_A, vout: 0, value: "2000" }],
    signed_tx: `02000000signed-${kind}-${id}`,
  };
  return payment;
}

/** The contract answers `method` with a new signed payment of `kind`. */
function answerWithPayment(dev: Dev, method: string, kind: string) {
  dev.answers.push((call) => {
    if (call.method !== method) return undefined;
    const payment = newPayment(dev, kind);
    dev.payments.push(payment);
    return { ok: true, hash: `${method}-tx`, value: payment.payment_id };
  });
}

/**
 * The live jar after both confirmations (dev2-get-jar-confirmed), with top-up A proven
 * (synthetic: its coin and balance), at a time past the handover delay and the unlock date.
 */
function handoverDue() {
  const dev = dev2("confirmed");
  setJar(dev, { proven_balance: "2000" });
  const coin: CoinView = { txid: TOPUP_A, vout: 0, value: "2000", status: "confirmed", payment_id: null };
  dev.coins.set("1", [coin]);
  const handover = dev.jar.handover as { confirmed: { delay_ends_at: string } };
  const now = Math.max(Number(handover.confirmed.delay_ends_at), Number(dev.jar.create_args.unlock_at)) + 60;
  return { dev, now };
}

function keeperFor(dev: Dev, now: number) {
  return createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => now });
}

describe("handover", () => {
  it("a due handover is completed at the mempool's fee rate with gas for 10 inputs, then broadcast", async () => {
    const { dev, now } = handoverDue();
    answerWithPayment(dev, "complete_handover", "rehoming");

    const report = await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([
      { method: "complete_handover", args: { jar_id: "1", fee_rate: "1" }, tgas: 10 * 15 + 50 },
    ]);
    expect(dev.btc.broadcasts).toEqual(["02000000signed-rehoming-1"]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["complete_handover", "done"],
      ["broadcast", "done"],
    ]);
  });
});

describe("handover, continued", () => {
  const completing = (coins_to_move: number) => ({
    handover: { completing: { delay_ends_at: "1794289306", coins_to_move, coins_left: 2 } },
  });

  it.each([
    ["while the delay runs", (dev: Dev) => void dev, -120],
    [
      "before the jar unlocks",
      (dev: Dev) => setJar(dev, { create_args: { ...dev.jar.create_args, unlock_at: String(2 ** 31) } }),
      0,
    ],
    ["once every fixed coin is in a payment", (dev: Dev) => setJar(dev, completing(0)), 0],
    ["once the handover is done", (dev: Dev) => setJar(dev, { handover: { done: { completed_at: "1" } } }), 0],
    [
      "while a payment of the jar is unfinished",
      (dev: Dev) => dev.payments.push({ ...newPayment(dev, "spend"), status: "signing", signed_tx: null }),
      0,
    ],
  ])("no complete_handover %s", async (_case, change, shift) => {
    const { dev, now } = handoverDue();
    change(dev);
    dev.answers.push((c) => (c.method === "retry_signing" ? { ok: false, hash: "r", code: "SIGNING_IN_PROGRESS", message: "retry from block 1" } : undefined));
    // The delay ends 60 s before `now`; -120 is a minute before it ends.
    await keeperFor(dev, now + shift).run();

    expect(dev.sent.filter((c) => c.method === "complete_handover")).toEqual([]);
  });

  it("a completing handover with coins left to move sends its next batch", async () => {
    const { dev, now } = handoverDue();
    setJar(dev, completing(1));
    answerWithPayment(dev, "complete_handover", "rehoming");

    await keeperFor(dev, now).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["complete_handover"]);
  });

  it("a batch confirmed earlier in the run frees the jar for the next one", async () => {
    const { dev, now } = handoverDue();
    setJar(dev, completing(1));
    // Synthetic: the first batch, signed and 3 deep on the light client.
    const first = newPayment(dev, "rehoming");
    dev.payments.push(first);
    const block = "00".repeat(32);
    dev.btc.statuses.set(first.txid, { confirmed: true, block_height: dev.state.tip - 2, block_hash: block });
    dev.btc.blocks.set(block, [first.txid]);
    dev.answers.push((c) => {
      if (c.method !== "confirm_payment") return undefined;
      dev.payments[0] = { ...first, status: "confirmed" };
      return undefined;
    });
    answerWithPayment(dev, "complete_handover", "rehoming");

    await keeperFor(dev, now).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["confirm_payment", "complete_handover"]);
  });
});

/** The jar after its handover (synthetic: done, moved away from the live address). */
function handedOver() {
  const dev = dev2("confirmed");
  const old = dev.jar.address;
  setJar(dev, {
    address: "tb1qnewaddressaftertherehoming",
    old_addresses: [old],
    handover: { done: { completed_at: "1794290000" } },
    proven_balance: "1860",
  });
  return { dev, old, now: 1_794_300_000 };
}

/** An output of `value` sats at `address`, 3 deep on the light client (synthetic). */
function deepOutput(dev: Dev, address: string, txid: string, value: number) {
  const block = "11".repeat(32);
  const status = { confirmed: true, block_height: dev.state.tip - 2, block_hash: block };
  dev.btc.outputs.set(address, [...(dev.btc.outputs.get(address) ?? []), { txid, vout: 0, value, status }]);
  dev.btc.statuses.set(txid, status);
  dev.btc.hexes.set(txid, `02000000hex-${txid.slice(0, 4)}`);
  dev.btc.blocks.set(block, [txid]);
}

describe("strays", () => {
  it("a top-up sent to an old address is proven", async () => {
    const { dev, old, now } = handedOver();
    const stray = "b".repeat(64);
    deepOutput(dev, old, stray, 1_500);

    await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([
      expect.objectContaining({
        method: "prove_topup",
        args: expect.objectContaining({ jar_id: "1", tx: "02000000hex-bbbb", vout: 0 }),
      }),
    ]);
  });
});

describe("stray sweep", () => {
  const STRAY = "b".repeat(64);

  /** A done jar whose stray at the old address is proven: a coin the contract holds, free. */
  function strayProven() {
    const { dev, old, now } = handedOver();
    deepOutput(dev, old, STRAY, 1_500);
    dev.coins.set("1", [{ txid: STRAY, vout: 0, value: "1500", status: "confirmed", payment_id: null }]);
    return { dev, old, now };
  }

  it("a proven stray is swept to the current address, then broadcast", async () => {
    const { dev, now } = strayProven();
    answerWithPayment(dev, "rehome_stray", "rehoming");

    const report = await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([{ method: "rehome_stray", args: { jar_id: "1", fee_rate: "1" }, tgas: 200 }]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["rehome_stray", "done"],
      ["broadcast", "done"],
    ]);
  });

  it.each([
    [
      "while its coin is in a sweep",
      (dev: Dev) => dev.coins.set("1", [{ ...dev.coins.get("1")![0]!, status: "reserved", payment_id: "9" }]),
    ],
    [
      "for a coin at the current address",
      (dev: Dev) => {
        const jar = dev.jars.get("1")!;
        dev.btc.outputs.set(jar.address, dev.btc.outputs.get(jar.old_addresses[0]!)!);
        dev.btc.outputs.set(jar.old_addresses[0]!, []);
      },
    ],
    [
      "while the handover completes",
      (dev: Dev) =>
        setJar(dev, { handover: { completing: { delay_ends_at: "1", coins_to_move: 0, coins_left: 1 } } }),
    ],
    [
      "while a transfer is accepted",
      (dev: Dev) =>
        setJar(dev, {
          transfer: { accepted: { btc_pubkey: "02".padEnd(66, "a"), coins_to_move: 0, coins_left: 1 } },
        }),
    ],
  ])("no rehome_stray %s", async (_case, change) => {
    const { dev, now } = strayProven();
    change(dev);

    await keeperFor(dev, now).run();

    expect(dev.sent.filter((c) => c.method === "rehome_stray")).toEqual([]);
  });
});

describe("emergency", () => {
  /** The live jar after the second approval (dev2-get-jar-emergency-approved), with a balance. */
  function emergencyApproved() {
    const dev = dev2("emergency-approved");
    setJar(dev, { proven_balance: "5000" }); // synthetic: proven top-ups
    const open = (dev.jar.emergency as { open: { delay_ends_at: string } }).open;
    return { dev, now: Number(open.delay_ends_at) + 60 };
  }

  it("an approved emergency past its delay is executed, then broadcast", async () => {
    const { dev, now } = emergencyApproved();
    answerWithPayment(dev, "execute_emergency", "emergency");

    const report = await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([{ method: "execute_emergency", args: { jar_id: "1", fee_rate: "1" }, tgas: 200 }]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["execute_emergency", "done"],
      ["broadcast", "done"],
    ]);
  });

  it.each([
    ["with one approval (no delay yet)", (dev: Dev) => setJar(dev, { emergency: fixture<JarView>("dev2-get-jar-emergency-proposed.json").emergency }), 0],
    ["while its delay runs", (dev: Dev) => void dev, -120],
    [
      "once the handover delay has ended",
      (dev: Dev) => setJar(dev, { handover: { confirmed: { delay_ends_at: "1" } } }),
      0,
    ],
    [
      "while an emergency payment of the jar is unfinished",
      (dev: Dev) => dev.payments.push({ ...newPayment(dev, "emergency"), status: "signing", signed_tx: null }),
      0,
    ],
  ])("no execute_emergency %s", async (_case, change, shift) => {
    const { dev, now } = emergencyApproved();
    change(dev);
    dev.answers.push((c) =>
      c.method === "retry_signing" ? { ok: false, hash: "r", code: "SIGNING_IN_PROGRESS", message: "retry from block 1" } : undefined,
    );

    await keeperFor(dev, now + shift).run();

    expect(dev.sent.filter((c) => c.method === "execute_emergency")).toEqual([]);
  });
});

describe("transfer", () => {
  // The receiver's key as get_jar shows it (contract/tests/transfer.rs asserts this shape).
  const KEY = "03".padEnd(66, "b");
  const accepted = (coins_to_move: number) => ({
    transfer: { accepted: { btc_pubkey: KEY, coins_to_move, coins_left: 11 } },
  });

  it("an accepted transfer with coins left to move sends its next batch with the stored key", async () => {
    const { dev, now } = handedOver();
    setJar(dev, accepted(1));
    answerWithPayment(dev, "accept_transfer", "rehoming");

    const report = await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([
      { method: "accept_transfer", args: { jar_id: "1", btc_pubkey: KEY, fee_rate: "1" }, tgas: 200 },
    ]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["accept_transfer", "done"],
      ["broadcast", "done"],
    ]);
  });

  it.each([
    ["before the receiver accepts", (dev: Dev) => setJar(dev, { transfer: { started: {} } })],
    ["once every fixed coin is in a payment", (dev: Dev) => setJar(dev, accepted(0))],
    [
      "while a payment of the jar is unfinished",
      (dev: Dev) => {
        setJar(dev, accepted(1));
        dev.payments.push({ ...newPayment(dev, "rehoming"), status: "signing", signed_tx: null });
      },
    ],
  ])("no accept_transfer %s", async (_case, change) => {
    const { dev, now } = handedOver();
    change(dev);
    dev.answers.push((c) =>
      c.method === "retry_signing" ? { ok: false, hash: "r", code: "SIGNING_IN_PROGRESS", message: "retry from block 1" } : undefined,
    );

    await keeperFor(dev, now).run();

    expect(dev.sent.filter((c) => c.method === "accept_transfer")).toEqual([]);
  });
});

describe("one new payment per jar per run", () => {
  it("an emergency and an allowance due together: the emergency only, the allowance next run", async () => {
    const dev = dev2("emergency-approved");
    const ends = Number((dev.jar.emergency as { open: { delay_ends_at: string } }).open.delay_ends_at);
    // Synthetic: proven top-ups, and the period's allowance due as well.
    setJar(dev, {
      proven_balance: "5000",
      available_allowance: "2000",
      clock: { started_at: String(ends - 3_600) },
      next_allowance_at: String(ends - 3_600),
    });
    answerWithPayment(dev, "execute_emergency", "emergency");

    await keeperFor(dev, ends + 60).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["execute_emergency"]);
  });
});

describe("settling covers every kind of payment", () => {
  it.each(["rehoming", "spend", "emergency"])("a signed %s payment is broadcast, and confirmed 3 deep", async (kind) => {
    const { dev, now } = handedOver();
    const payment = newPayment(dev, kind);
    dev.payments.push(payment);

    await keeperFor(dev, now).run();
    expect(dev.btc.broadcasts).toEqual([payment.signed_tx]);

    const block = "22".repeat(32);
    dev.btc.statuses.set(payment.txid, { confirmed: true, block_height: dev.state.tip - 2, block_hash: block });
    dev.btc.blocks.set(block, [payment.txid]);
    await keeperFor(dev, now).run();
    expect(dev.sent).toEqual([
      expect.objectContaining({ method: "confirm_payment", args: expect.objectContaining({ payment_id: "1" }), tgas: 60 }),
    ]);
  });
});

describe("a refused call is not sent again until what it depends on changes", () => {
  function refuse(dev: Dev, method: string, code: string) {
    dev.answers.unshift((call) => (call.method === method ? { ok: false, hash: "refused", code, message: "refused" } : undefined));
  }

  it.each([
    [
      "complete_handover refused OUTPUT_BELOW_DUST",
      "complete_handover",
      "OUTPUT_BELOW_DUST",
      () => handoverDue(),
      (dev: Dev) => setJar(dev, { proven_balance: "3000" }),
    ],
    [
      "accept_transfer refused PAYMENT_PENDING",
      "accept_transfer",
      "PAYMENT_PENDING",
      () => {
        const due = handedOver();
        setJar(due.dev, { transfer: { accepted: { btc_pubkey: "03".padEnd(66, "b"), coins_to_move: 2, coins_left: 2 } } });
        return due;
      },
      (dev: Dev) =>
        setJar(dev, { transfer: { accepted: { btc_pubkey: "03".padEnd(66, "b"), coins_to_move: 1, coins_left: 2 } } }),
    ],
    [
      "rehome_stray refused NO_STRAYS",
      "rehome_stray",
      "NO_STRAYS",
      () => {
        const due = handedOver();
        deepOutput(due.dev, due.old, "b".repeat(64), 1_500);
        due.dev.coins.set("1", [{ txid: "b".repeat(64), vout: 0, value: "1500", status: "confirmed", payment_id: null }]);
        return due;
      },
      (dev: Dev) => {
        deepOutput(dev, dev.jars.get("1")!.old_addresses[0]!, "d".repeat(64), 1_200);
        dev.coins.get("1")!.push({ txid: "d".repeat(64), vout: 0, value: "1200", status: "confirmed", payment_id: null });
      },
    ],
    [
      "execute_emergency refused INSUFFICIENT_BALANCE",
      "execute_emergency",
      "INSUFFICIENT_BALANCE",
      () => {
        const dev = dev2("emergency-approved");
        setJar(dev, { proven_balance: "1000" });
        return { dev, now: Number((dev.jar.emergency as { open: { delay_ends_at: string } }).open.delay_ends_at) + 60 };
      },
      (dev: Dev) => setJar(dev, { proven_balance: "5000" }),
    ],
  ])("%s waits for a change", async (_case, method, code, setup, change) => {
    const { dev, now } = setup();
    const clock = { now };
    const keeper = createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => clock.now });
    refuse(dev, method, code);

    await keeper.run();
    clock.now += 3_600;
    const second = await keeper.run();
    expect(dev.sent.filter((c) => c.method === method).length).toBe(1);
    expect(second.steps).toContainEqual(expect.objectContaining({ action: method, result: "waiting", code }));

    change(dev);
    await keeper.run();
    expect(dev.sent.filter((c) => c.method === method).length).toBe(2);
  });

  it.each([
    ["complete_handover", "BEFORE_UNLOCK", () => handoverDue()],
    ["complete_handover", "HANDOVER_DELAY_RUNNING", () => handoverDue()],
    [
      "execute_emergency",
      "DELAY_NOT_PASSED",
      () => {
        const dev = dev2("emergency-approved");
        setJar(dev, { proven_balance: "5000" });
        return { dev, now: Number((dev.jar.emergency as { open: { delay_ends_at: string } }).open.delay_ends_at) + 1 };
      },
    ],
  ])("%s refused %s (the host's clock ahead of block time) is sent again on a later run", async (method, code, setup) => {
    const { dev, now } = setup();
    const clock = { now };
    const keeper = createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => clock.now });
    refuse(dev, method, code);

    await keeper.run();
    await keeper.run();
    expect(dev.sent.filter((c) => c.method === method).length).toBe(1);

    clock.now += 60;
    await keeper.run();
    expect(dev.sent.filter((c) => c.method === method).length).toBe(2);
  });
});
