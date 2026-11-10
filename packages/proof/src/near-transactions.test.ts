import { describe, expect, test } from "vitest";
import { createProofReader } from "./index.ts";
import { FAILED_BEFORE_RULE } from "./near-transactions.ts";
import { evidence, fixture, replayFetch, type Fixture } from "./test-fetch.ts";

const record = evidence();
const reader = createProofReader({
  contract: record.contract,
  fetch: replayFetch(fixture("indexer"), fixture("near-views")),
});

// The NEAR steps of T06's live run, each with its outcome.
const outcomes = record.steps.filter((s) => s.step.endsWith("(outcome)"));

describe("the contract's NEAR transactions for a jar", () => {
  test("lists every transaction of the money moment for jar 1, in order, with its explorer link", async () => {
    const txs = await reader.nearTransactions("1");

    const sent = record.steps.filter((s) => s.near_tx && !s.step.endsWith("(outcome)")).map((s) => s.near_tx);
    expect(txs.map((t) => t.hash)).toEqual(sent);
    for (const outcome of outcomes) {
      expect(txs.find((t) => t.hash === outcome.near_tx)?.explorerUrl).toBe(outcome.explorer);
    }
    const deploys = record.deploy.account_transactions.map((t) => t.near_tx);
    expect(txs.some((t) => deploys.includes(t.hash))).toBe(false);
  });

  test("shows the refused second allowance as a failed transaction with the contract's reason", async () => {
    const txs = await reader.nearTransactions("1");

    for (const outcome of outcomes) {
      const tx = txs.find((t) => t.hash === outcome.near_tx);
      expect(tx?.ok).toBe(outcome.ok);
      if (outcome.ok) {
        expect(tx?.refusal).toBeNull();
      } else {
        const [code, ...sentence] = (outcome.error ?? "").split(": ");
        expect(tx?.refusal).toEqual({ code, reason: sentence.join(": ") });
      }
    }
    expect(outcomes.filter((o) => !o.ok).map((o) => o.error)).toEqual([
      "ALREADY_PAID: the allowance for this period was already paid; next one in 23h 59m",
    ]);
  });

  test("finds a payment's transaction through the payment's jar when it names no jar", async () => {
    // Synthetic variant of the recorded confirm_payment: its event logs removed, as on a refusal.
    const confirm = "HdercU3awYUhcUg9872nkuooeuL34RUDkZiU1oB49UJ";
    const withoutLogs = edit(fixture("indexer"), (tx) => {
      if (tx.transaction.hash !== confirm) return;
      for (const receipt of tx.receipts) receipt.execution_outcome.outcome.logs = [];
    });
    const quiet = createProofReader({ contract: record.contract, fetch: replayFetch(withoutLogs, fixture("near-views")) });

    expect((await quiet.nearTransactions("1")).map((t) => t.hash)).toContain(confirm);
    expect(await quiet.nearTransactions("2")).toEqual([]);
  });

  test("keeps a call that names no jar when the contract's own event names the jar", async () => {
    // Synthetic variant of the recorded request_allowance: its args no longer name the jar.
    const request = "GT7NZh8kRdF1zphS8WmV8mFYs3j7JLvxdY2ai2jxAZdW";
    const noArgs = edit(fixture("indexer"), (tx) => {
      if (tx.transaction.hash === request) tx.transaction.actions = [{ FunctionCall: { method_name: "request_allowance", args: btoa("{}") } }];
    });
    const byEvent = createProofReader({ contract: record.contract, fetch: replayFetch(noArgs, fixture("near-views")) });
    expect((await byEvent.nearTransactions("1")).map((t) => t.hash)).toContain(request);

    // The same event written by another account does not count.
    const forged = edit(noArgs, (tx) => {
      if (tx.transaction.hash !== request) return;
      for (const receipt of tx.receipts) receipt.execution_outcome.outcome.executor_id = "someone-else.testnet";
    });
    const byForgery = createProofReader({ contract: record.contract, fetch: replayFetch(forged, fixture("near-views")) });
    expect((await byForgery.nearTransactions("1")).map((t) => t.hash)).not.toContain(request);
  });

  test.each([
    ["running out of gas", "Exceeded the prepaid gas."],
    ["a panic without a refusal code", "Smart contract panicked: panicked at contract/src/lib.rs:12:5"],
  ])("replaces %s with a fixed sentence and drops the chain's text", async (_, raw) => {
    // Synthetic variant of the recorded ALREADY_PAID refusal with another failure in its place.
    const refused = "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP";
    const failed = edit(fixture("indexer"), (tx) => {
      if (tx.transaction.hash !== refused) return;
      for (const receipt of tx.receipts) {
        const outcome = receipt.execution_outcome.outcome;
        if ("Failure" in outcome.status) {
          outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: raw } } } } };
        }
      }
    });
    const reader = createProofReader({ contract: record.contract, fetch: replayFetch(failed, fixture("near-views")) });

    const txs = await reader.nearTransactions("1");

    expect(txs.find((t) => t.hash === refused)?.refusal).toEqual({ code: null, reason: FAILED_BEFORE_RULE });
    expect(JSON.stringify(txs)).not.toContain(raw);
  });
});

interface EditableTx {
  transaction: { hash: string; actions: unknown[] };
  receipts: { execution_outcome: { outcome: { logs: string[]; executor_id: string; status: Record<string, unknown> } } }[];
}

/** A copy of a recorded fixture with each indexed transaction passed through `change`. */
function edit(source: Fixture, change: (tx: EditableTx) => void): Fixture {
  const copy = structuredClone(source);
  for (const exchange of copy.exchanges) {
    const body = exchange.response.body as { transactions?: EditableTx[] };
    body.transactions?.forEach(change);
  }
  return copy;
}
