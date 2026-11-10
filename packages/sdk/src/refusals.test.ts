import { describe, expect, test } from "vitest";
import { result, type Outcome } from "./near.ts";
import { recorded } from "./test-network.ts";

const CONTRACT = "sats-jar-dev.testnet";
// T06's live ALREADY_PAID refusal (src/fixtures/near.json).
const live = (recorded("near", (b) => b.params.tx_hash === "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP") as { result: Outcome }).result;

/** Synthetic, labelled: the live refusal's outcome with another panic text in the contract's receipt. */
function refusedWith(panic: string): Outcome {
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } };
  return {
    ...live,
    status: { Failure: failure },
    receipts_outcome: live.receipts_outcome.map((r, i) =>
      i === 0 ? { ...r, outcome: { ...r.outcome, status: { Failure: failure } } } : r,
    ),
  };
}

// create_jar's refusals as the contract words them (contract/src/jar.rs, lib.rs).
const CREATE_REFUSALS = [
  "INVALID_CHILD_ADDRESS: the child's address is not a valid native segwit Bitcoin address",
  "CHILD_ADDRESS_WRONG_NETWORK: the child's address belongs to another Bitcoin network",
  "CHILD_ADDRESS_NOT_P2WPKH: the child's address must be a native segwit key address (bc1q or tb1q)",
  "CAP_TOO_SMALL: a cap under 1630 sats cannot pay a payment's fee from its 10% fee budget",
  "UNLOCK_IN_PAST: the unlock date must be in the future",
  "TOO_FEW_GUARDIANS: a jar needs at least 2 guardians",
  "TOO_MANY_GUARDIANS: a jar has at most 3 guardians",
  "DUPLICATE_GUARDIAN: 55545d01cfa4662eb358.sats-jar-app.testnet is listed as a guardian twice",
  "PERIOD_TOO_SHORT: a period must be at least 60 seconds",
  "LOCKTIME_OUT_OF_RANGE: the exit date after this unlock date is past what Bitcoin can lock to (2106)",
  "STORAGE_DEPOSIT_TOO_LOW: attach at least 8890000000000000000000 yoctoNEAR for the jar's storage",
];

describe("refusals", () => {
  test("the live refusal reads as its code with the SDK's message and the transaction's link", () => {
    expect(result(live, CONTRACT)).toEqual({
      refusal: expect.objectContaining({
        code: "ALREADY_PAID",
        explorerUrl: "https://testnet.nearblocks.io/txns/HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP",
      }),
    });
  });

  test.each(CREATE_REFUSALS)("create refusal %s comes back typed, without account names, NEAR or gas", (panic) => {
    const answer = result(refusedWith(panic), CONTRACT);
    if (!("refusal" in answer)) throw new Error("not refused");
    expect(answer.refusal.code).toBe(panic.split(":")[0]);
    expect(answer.refusal.message).not.toMatch(/\.testnet|NEAR|gas|yocto|account/i);
    expect(answer.refusal.message.length).toBeGreaterThan(10);
  });

  test("a panic with no code, or a code this SDK does not know, reads REFUSED and never shows the raw text", () => {
    for (const panic of [
      "Failed to deserialize input from JSON.",
      "Requires attached deposit of exactly 1 yoctoNEAR",
      "SPEND_UNAVAILABLE: spends after handover come in T12",
    ]) {
      const answer = result(refusedWith(panic), CONTRACT);
      expect(answer).toEqual({ refusal: expect.objectContaining({ code: "REFUSED", message: "The jar's rule did not allow that." }) });
    }
  });

  test("a failure no contract receipt panicked with is TRANSACTION_FAILED", () => {
    const outOfGas = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } };
    const outcome = { ...live, status: { Failure: outOfGas }, receipts_outcome: [{ ...live.receipts_outcome[0], outcome: { ...live.receipts_outcome[0]!.outcome, status: { Failure: outOfGas } } }] } as Outcome;
    expect(result(outcome, CONTRACT)).toEqual({ refusal: expect.objectContaining({ code: "TRANSACTION_FAILED" }) });
  });

  test("a success returns the call's value (T15's live create_jar returned jar 3)", () => {
    const created = (recorded("near", (b) => b.params.tx_hash === "EzMfNipDDPKfNm4cEtuGyQhF2TysNFhxL9rVeXPY55f9") as { result: Outcome }).result;
    expect(result(created, CONTRACT)).toEqual({ value: "3" });
  });
});
