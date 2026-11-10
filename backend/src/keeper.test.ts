import { describe, expect, it } from "vitest";
import { createBackend } from "./http.ts";
import { createKeeper } from "./keeper.ts";
import { fileStore } from "./file-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Output } from "./bitcoin.ts";
import type { PaymentView } from "./chain.ts";
import {
  devJar,
  fixture,
  devJarBeforeProof,
  moneyMoment,
  PAYMENT_HEIGHT,
  PAYMENT_TXID,
  TOPUP_HEIGHT,
  TOPUP_TXID,
} from "./keeper.fakes.ts";

const NOW = 1_794_300_000;

/** The proof args T06 sent and the live contract accepted for each top-up output. */
function acceptedTopupProofs() {
  return moneyMoment()
    .steps.filter((s) => s.sent?.method === "prove_topup")
    .map((s) => s.sent?.args);
}

describe("run now", () => {
  it("proves a top-up confirmed 3 deep on the light client, as the live contract accepted it", async () => {
    const dev = devJarBeforeProof();
    const handle = backendWith(keeperFor(dev));

    const response = await handle(new Request("http://backend.test/keeper/run", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(dev.sent).toEqual(
      acceptedTopupProofs().map((args) => ({ method: "prove_topup", args, tgas: 60 })),
    );
    const report = (await response.json()) as { steps: { action: string; result: string; target: string }[] };
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "prove_topup", jarId: "1", target: `${TOPUP_TXID}:0`, result: "done" }),
      expect.objectContaining({ action: "prove_topup", jarId: "1", target: `${TOPUP_TXID}:1`, result: "done" }),
    ]);
  });
});

describe("one run at a time", () => {
  it("two presses at once share one run: the same report, each call sent once", async () => {
    const dev = devJarBeforeProof();
    const handle = backendWith(keeperFor(dev));
    const press = () => handle(new Request("http://backend.test/keeper/run", { method: "POST" }));

    const [first, second] = await Promise.all([press(), press()]);

    expect(dev.sent.map((c) => c.method)).toEqual(["prove_topup", "prove_topup"]);
    expect(await second.json()).toEqual(await first.json());
  });
});

function backendWith(keeper: ReturnType<typeof createKeeper>) {
  return createBackend({
    chain: { createAccount: async () => "created", jarGuardians: async () => undefined },
    store: fileStore(join(mkdtempSync(join(tmpdir(), "sats-jar-keeper-")), "drafts.json")),
    appAccount: "sats-jar-app.testnet",
    keeper,
  });
}

function keeperFor(dev: ReturnType<typeof devJarBeforeProof>, now = NOW) {
  return createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => now });
}

describe("top-ups", () => {
  it.each([
    ["2 of 3 confirmations on the light client", (dev: Dev) => void (dev.state.tip = TOPUP_HEIGHT + 1)],
    ["not yet in a block", (dev: Dev) => setOutputs(dev, (o) => ({ ...o, status: { confirmed: false } }))],
    ["999 sats, under the dust floor", (dev: Dev) => setOutputs(dev, (o) => ({ ...o, value: 999 }))],
    [
      "already a coin of the jar",
      (dev: Dev) =>
        dev.coins.set("1", [0, 1].map((vout) => ({ txid: TOPUP_TXID, vout, value: "2000", status: "confirmed", payment_id: null }))),
    ],
  ])("no prove_topup for an output %s", async (_case, change) => {
    const dev = devJarBeforeProof();
    change(dev);

    await keeperFor(dev).run();

    expect(dev.sent).toEqual([]);
  });

  it("no prove_topup for a payment's change before confirm_payment makes it a coin", async () => {
    // Recorded jar 1, with payment 1 as it was before confirm_payment (synthetic: signed, and
    // its 1,260-sat change not yet a coin), 3 deep on the light client.
    const dev = devJar();
    dev.payments[0] = { ...dev.payments[0]!, status: "signed" };
    dev.coins.set("1", dev.coins.get("1")!.filter((c) => c.txid !== PAYMENT_TXID));
    dev.state.tip = PAYMENT_HEIGHT + 2;

    await keeperFor(dev).run();

    expect(dev.sent.filter((c) => c.method === "prove_topup")).toEqual([]);
  });
});

type Dev = ReturnType<typeof devJarBeforeProof>;

function setOutputs(dev: Dev, change: (o: Output) => Output) {
  dev.btc.outputs.set(dev.jar.address, dev.btc.outputs.get(dev.jar.address)!.map(change));
}

/** Recorded jar 1 with payment 1 as it was once signed (synthetic: status signed, change not yet a coin). */
function signedPayment() {
  const dev = devJar();
  dev.payments[0] = { ...dev.payments[0]!, status: "signed" };
  dev.coins.set("1", dev.coins.get("1")!.filter((c) => c.txid !== PAYMENT_TXID));
  return dev;
}

describe("signed payments", () => {
  it("a payment 3 deep on the light client is confirmed with the proof the live contract accepted", async () => {
    const dev = signedPayment();
    dev.state.tip = PAYMENT_HEIGHT + 2;
    const accepted = moneyMoment().steps.find((s) => s.sent?.method === "confirm_payment")?.sent?.args;

    const report = await keeperFor(dev).run();

    expect(dev.sent).toEqual([{ method: "confirm_payment", args: accepted, tgas: 60 }]);
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "confirm_payment", paymentId: "1", target: PAYMENT_TXID, result: "done" }),
    ]);
  });

  it("a payment 2 deep waits for its third confirmation", async () => {
    const dev = signedPayment();
    dev.state.tip = PAYMENT_HEIGHT + 1;

    const report = await keeperFor(dev).run();

    expect(dev.sent).toEqual([]);
    expect(dev.btc.broadcasts).toEqual([]);
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "confirm_payment", paymentId: "1", result: "waiting" }),
    ]);
  });

  it("a payment not yet in a block is broadcast as the contract signed it", async () => {
    const dev = signedPayment();
    dev.btc.statuses.set(PAYMENT_TXID, { confirmed: false });

    const report = await keeperFor(dev).run();

    expect(dev.btc.broadcasts).toEqual([dev.payments[0]!.signed_tx]);
    expect(dev.sent).toEqual([]);
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "broadcast", paymentId: "1", target: PAYMENT_TXID, result: "done" }),
    ]);
  });

  it("a payment Bitcoin already holds is not counted as a new broadcast", async () => {
    const dev = signedPayment();
    dev.btc.statuses.set(PAYMENT_TXID, { confirmed: false });
    dev.btc.state.broadcast = "known";

    const report = await keeperFor(dev).run();

    expect(report.steps).toEqual([
      expect.objectContaining({ action: "broadcast", paymentId: "1", result: "waiting" }),
    ]);
  });

  it("a refused broadcast is reported with Bitcoin's reason", async () => {
    const dev = signedPayment();
    dev.btc.statuses.set(PAYMENT_TXID, { confirmed: false });
    // Synthetic: Bitcoin Core's reject reason for spent inputs.
    dev.btc.state.broadcast = { refused: "sendrawtransaction RPC error: bad-txns-inputs-missingorspent" };

    const report = await keeperFor(dev).run();

    expect(report.steps).toEqual([
      expect.objectContaining({
        action: "broadcast",
        paymentId: "1",
        result: "failed",
        message: "sendrawtransaction RPC error: bad-txns-inputs-missingorspent",
      }),
    ]);
  });
});

// The contract's SIGNING_IN_PROGRESS text (contract/src/lib.rs, retry_signing).
const IN_PROGRESS = (block: number) =>
  `a signing request for this payment may still be answered; retry from block ${block}`;

describe("failed signings", () => {
  it("a failed signing is retried with gas for each input and the callback, then broadcast", async () => {
    // Synthetic: payment 1 as a failed first signing (it signed first time in T06).
    const dev = signedPayment();
    const signed = dev.payments[0]!;
    dev.payments[0] = { ...signed, status: "signing_failed", signed_tx: null };
    dev.btc.statuses.set(PAYMENT_TXID, { confirmed: false });
    dev.answers.push((call) => {
      if (call.method === "retry_signing") dev.payments[0] = signed;
      return undefined;
    });

    const report = await keeperFor(dev).run();

    expect(dev.sent).toEqual([{ method: "retry_signing", args: { payment_id: "1" }, tgas: 2 * 15 + 50 }]);
    expect(dev.btc.broadcasts).toEqual([signed.signed_tx]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["retry_signing", "done"],
      ["broadcast", "done"],
    ]);
  });

  it("a retry whose signing fails again is sent once per run, not again in the same run", async () => {
    // on_payment_signed returns the payment id even when it records SigningFailed (T04), so the
    // retry call itself succeeds while the payment stays signing_failed.
    const dev = signedPayment();
    dev.payments[0] = { ...dev.payments[0]!, status: "signing_failed", signed_tx: null };
    const keeper = keeperFor(dev);

    const report = await keeper.run();
    expect(dev.sent.map((c) => c.method)).toEqual(["retry_signing"]);
    expect(dev.btc.broadcasts).toEqual([]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([["retry_signing", "done"]]);

    await keeper.run();
    expect(dev.sent.length).toBe(1);

    dev.state.block += 1;
    await keeper.run();
    expect(dev.sent.map((c) => c.method)).toEqual(["retry_signing", "retry_signing"]);
  });

  it("a request whose signing fails is retried once in the same run", async () => {
    const { dev, now } = allowanceDue();
    // Synthetic: the contract answers with payment 2, whose signing failed.
    const failed = { ...dev.payments[0]!, payment_id: "2", status: "signing_failed" as const, signed_tx: null };
    dev.answers.push((call) => {
      if (call.method !== "request_allowance") return undefined;
      dev.payments.push(failed);
      return { ok: true, hash: "requested", value: "2" };
    });

    await keeperFor(dev, now).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["request_allowance", "retry_signing"]);
  });

  it("a signed payment without its transaction is not broadcast", async () => {
    const dev = signedPayment();
    dev.payments[0] = { ...dev.payments[0]!, signed_tx: null };
    dev.btc.statuses.set(PAYMENT_TXID, { confirmed: false });

    const report = await keeperFor(dev).run();

    expect(dev.btc.broadcasts).toEqual([]);
    expect(report.steps).toEqual([expect.objectContaining({ action: "broadcast", paymentId: "1", result: "failed" })]);
  });

  it("a signing still in flight waits for the block the contract names", async () => {
    const dev = signedPayment();
    dev.payments[0] = { ...dev.payments[0]!, status: "signing", signed_tx: null };
    dev.answers.push((call) =>
      call.method === "retry_signing"
        ? { ok: false, hash: "refused", code: "SIGNING_IN_PROGRESS", message: IN_PROGRESS(277_000_250) }
        : undefined,
    );

    const report = await keeperFor(dev).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["retry_signing"]);
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "retry_signing", paymentId: "1", result: "waiting", code: "SIGNING_IN_PROGRESS" }),
    ]);
  });
});

/** Recorded jar 1 at the start of its second period (synthetic: the 2,500-sat allowance available). */
function allowanceDue() {
  const dev = devJar();
  const dueAt = Number(dev.jar.next_allowance_at);
  dev.jars.set("1", { ...dev.jar, available_allowance: "2500" });
  return { dev, now: dueAt + 60 };
}

describe("allowance", () => {
  it("a due allowance is requested at the mempool's fee rate with gas for 10 inputs, then broadcast", async () => {
    const { dev, now } = allowanceDue();
    dev.btc.state.minimumFee = 2;
    // Synthetic: the contract answers with payment 2, signed and not yet on Bitcoin.
    const second = { ...dev.payments[0]!, payment_id: "2", status: "signed" as const, txid: "ab".repeat(32) };
    dev.answers.push((call) => {
      if (call.method !== "request_allowance") return undefined;
      dev.payments.push(second);
      return { ok: true, hash: "requested", value: "2" };
    });

    const report = await keeperFor(dev, now).run();

    expect(dev.sent).toEqual([
      { method: "request_allowance", args: { jar_id: "1", fee_rate: "2" }, tgas: 10 * 15 + 50 },
    ]);
    expect(dev.btc.broadcasts).toEqual([second.signed_tx]);
    expect(report.steps.map((s) => [s.action, s.result])).toEqual([
      ["request_allowance", "done"],
      ["broadcast", "done"],
    ]);
  });

  it("a jar's first top-up, proven in this run, gets its first allowance in the same run", async () => {
    // As on testnet: the proof starts the jar's clock at its block time, after the run began.
    const dev = devJarBeforeProof();
    const clock = { now: NOW };
    const keeper = createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => (clock.now += 2) });
    dev.answers.push((call) => {
      if (call.method !== "prove_topup") return undefined;
      const startedAt = String(clock.now + 1);
      dev.jars.set("1", {
        ...dev.jars.get("1")!,
        clock: { started_at: startedAt },
        proven_balance: "4000",
        available_allowance: "2500",
        next_allowance_at: startedAt,
      });
      return undefined;
    });

    await keeper.run();

    expect(dev.sent.map((c) => c.method)).toEqual(["prove_topup", "prove_topup", "request_allowance"]);
  });

  it("the fee rate is never under 1 sat/vB", async () => {
    const { dev, now } = allowanceDue();
    dev.btc.state.minimumFee = 0;

    await keeperFor(dev, now).run();

    expect(dev.sent[0]?.args).toEqual({ jar_id: "1", fee_rate: "1" });
  });

  it.each([
    ["before the period starts", (dev: Dev) => void dev, -120],
    ["with nothing available", (dev: Dev) => dev.jars.set("1", { ...dev.jars.get("1")!, available_allowance: "0" }), 0],
    ["with no proven balance", (dev: Dev) => dev.jars.set("1", { ...dev.jars.get("1")!, proven_balance: "0" }), 0],
    [
      "before the first top-up",
      (dev: Dev) => dev.jars.set("1", { ...dev.jars.get("1")!, next_allowance_at: null }),
      0,
    ],
    [
      "while one of its payments is unfinished",
      (dev: Dev) => {
        dev.payments[0] = { ...dev.payments[0]!, status: "signing" };
        dev.answers.push((c) =>
          c.method === "retry_signing" ? { ok: false, hash: "r", code: "SIGNING_IN_PROGRESS", message: IN_PROGRESS(1) } : undefined,
        );
      },
      0,
    ],
    [
      "once the handover delay has ended",
      (dev: Dev) =>
        dev.jars.set("1", {
          ...dev.jars.get("1")!,
          handover: { confirmed: { delay_ends_at: String(Number(dev.jar.next_allowance_at)) } },
        }),
      0,
    ],
    [
      "while its handover completes (contract/src/handover.rs HandoverView)",
      (dev: Dev) =>
        dev.jars.set("1", {
          ...dev.jars.get("1")!,
          handover: { completing: { delay_ends_at: "1", coins_to_move: 1, coins_left: 1 } },
        }),
      0,
    ],
    [
      "once its handover is done",
      (dev: Dev) => dev.jars.set("1", { ...dev.jars.get("1")!, handover: { done: { completed_at: "1" } } }),
      0,
    ],
  ])("no request_allowance %s", async (_case, change, shift) => {
    const { dev, now } = allowanceDue();
    change(dev);

    await keeperFor(dev, now + shift).run();

    expect(dev.sent.filter((c) => c.method === "request_allowance")).toEqual([]);
  });
});

describe("one jar's trouble", () => {
  it("a refusal is reported with its code and the next jar still gets its allowance", async () => {
    const { dev, now } = allowanceDue();
    dev.jars.set("2", { ...dev.jars.get("1")!, jar_id: "2", address: "tb1q-jar-2-synthetic" });
    // T06's recorded refusal (evidence/dev-money-moment.json), given to jar 1's request.
    dev.answers.push((call) =>
      call.method === "request_allowance" && call.args.jar_id === "1"
        ? {
            ok: false,
            hash: "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP",
            code: "ALREADY_PAID",
            message: "the allowance for this period was already paid; next one in 23h 59m",
          }
        : undefined,
    );

    const report = await keeperFor(dev, now).run();

    expect(dev.sent.map((c) => c.args.jar_id)).toEqual(["1", "2"]);
    expect(report.steps[0]).toEqual(
      expect.objectContaining({ action: "request_allowance", jarId: "1", result: "refused", code: "ALREADY_PAID" }),
    );
  });

  it("a Bitcoin API failure for one jar is reported and the next jar's top-up is still proven", async () => {
    const dev = devJarBeforeProof();
    dev.jars.set("2", { ...dev.jars.get("1")!, jar_id: "2" });
    dev.jars.set("1", { ...dev.jars.get("1")!, address: "tb1q-unreachable-synthetic" });
    dev.btc.failing.add("tb1q-unreachable-synthetic");

    const report = await keeperFor(dev).run();

    expect(dev.sent.map((c) => [c.method, c.args.jar_id])).toEqual([
      ["prove_topup", "2"],
      ["prove_topup", "2"],
    ]);
    expect(report.steps[0]).toEqual(
      expect.objectContaining({ action: "check", jarId: "1", result: "failed", message: "esplora unreachable" }),
    );
  });

  it("a Bitcoin API failure for one payment is reported and the jars are still served", async () => {
    const dev = devJarBeforeProof();
    // Synthetic: an unfinished payment of another jar whose transaction Esplora cannot answer for.
    dev.payments.push({ ...fixture<PaymentView>("near-get-payment-1.json"), jar_id: "9", status: "signed" });
    dev.btc.failing.add(PAYMENT_TXID);

    const report = await keeperFor(dev).run();

    expect(dev.sent.map((c) => c.method)).toEqual(["prove_topup", "prove_topup"]);
    expect(report.steps[0]).toEqual(
      expect.objectContaining({ action: "check", paymentId: "1", result: "failed", message: "esplora unreachable" }),
    );
  });
});

describe("a refused call is not sent again until what it depends on changes", () => {
  function refuse(dev: Dev, method: string, code: string, message = "refused") {
    dev.answers.unshift((call) => (call.method === method ? { ok: false, hash: "refused", code, message } : undefined));
  }

  it("request_allowance waits for a change of balance, allowance, period or fee rate", async () => {
    const { dev, now } = allowanceDue();
    const clock = { now };
    const keeper = createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => clock.now });
    refuse(dev, "request_allowance", "PAYMENT_TOO_SMALL");

    await keeper.run();
    clock.now += 600;
    const second = await keeper.run();
    expect(dev.sent.length).toBe(1);
    expect(second.steps).toEqual([
      expect.objectContaining({ action: "request_allowance", jarId: "1", result: "waiting", code: "PAYMENT_TOO_SMALL" }),
    ]);

    dev.btc.state.minimumFee = 2;
    await keeper.run();
    expect(dev.sent.length).toBe(2);
    dev.jars.set("1", { ...dev.jars.get("1")!, proven_balance: "4260" });
    await keeper.run();
    expect(dev.sent.length).toBe(3);
    clock.now += Number(dev.jar.create_args.period);
    await keeper.run();
    expect(dev.sent.length).toBe(4);
  });

  it.each([
    ["prove_topup", devJarBeforeProof, TOPUP_HEIGHT, 2],
    ["confirm_payment", signedPayment, PAYMENT_HEIGHT, 1],
  ] as const)("%s refused NOT_IN_CHAIN waits an hour and 6 new light-client tips", async (method, setup, height, calls) => {
    const dev = setup();
    dev.state.tip = height + 2;
    const clock = { now: NOW };
    const keeper = createKeeper({ chain: dev.chain, bitcoin: dev.btc.bitcoin, now: () => clock.now });
    refuse(dev, method, "NOT_IN_CHAIN");

    await keeper.run();
    expect(dev.sent.length).toBe(calls);
    dev.state.tip += 6; // a block storm: 6 new tips within the hour
    clock.now += 600;
    await keeper.run();
    dev.state.tip -= 1; // an hour on, but 5 new tips only
    clock.now += 3_600;
    await keeper.run();
    expect(dev.sent.length).toBe(calls);

    dev.state.tip += 1;
    await keeper.run();
    expect(dev.sent.length).toBe(2 * calls);
  });

  it.each([
    ["prove_topup", devJarBeforeProof, TOPUP_HEIGHT, 2],
    ["confirm_payment", signedPayment, PAYMENT_HEIGHT, 1],
  ] as const)("%s refused NOT_CONFIRMED waits for the light client's next tip", async (method, setup, height, calls) => {
    const dev = setup();
    dev.state.tip = height + 2;
    const keeper = keeperFor(dev);
    refuse(dev, method, "NOT_CONFIRMED", "2 of 3 confirmations; wait for more");

    await keeper.run();
    await keeper.run();
    expect(dev.sent.length).toBe(calls);

    dev.state.tip += 1;
    await keeper.run();
    expect(dev.sent.length).toBe(2 * calls);
  });

  it("retry_signing refused SIGNING_IN_PROGRESS waits for the block it names", async () => {
    const dev = signedPayment();
    dev.payments[0] = { ...dev.payments[0]!, status: "signing", signed_tx: null };
    dev.state.block = 277_000_000;
    const keeper = keeperFor(dev);
    refuse(dev, "retry_signing", "SIGNING_IN_PROGRESS", IN_PROGRESS(277_000_250));

    await keeper.run();
    dev.state.block = 277_000_249;
    await keeper.run();
    expect(dev.sent.length).toBe(1);

    dev.state.block = 277_000_250;
    await keeper.run();
    expect(dev.sent.length).toBe(2);
  });

  it("retry_signing refused otherwise waits for the payment's status to change", async () => {
    const dev = signedPayment();
    dev.payments[0] = { ...dev.payments[0]!, status: "signing_failed", signed_tx: null };
    const keeper = keeperFor(dev);
    refuse(dev, "retry_signing", "NOT_ENOUGH_GAS");

    await keeper.run();
    dev.state.block += 1_000;
    await keeper.run();
    expect(dev.sent.length).toBe(1);

    dev.payments[0] = { ...dev.payments[0]!, status: "signing" };
    await keeper.run();
    expect(dev.sent.length).toBe(2);
  });
});
