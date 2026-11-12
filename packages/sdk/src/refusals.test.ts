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

// Part 2's refusals as the contract words them (contract/src/*.rs), each naming an account,
// a key or an amount the SDK's message must not repeat.
const PART_TWO_REFUSALS = [
  "NO_STRAYS: jar 7 has no coins at an old address to re-home",
  "REHOMING_IN_PROGRESS: jar 7's coins are moving to a new key; try again after",
  "INVALID_ADDRESS: tb1pxyz is not a native segwit v0 address on this network",
  "AMOUNT_BELOW_DUST: a spend must send at least 1000 sats (the jar's dust floor)",
  "TOO_MANY_APPROVALS: jar 7 already has 10 approved accounts",
  "TRANSFER_BEFORE_HANDOVER: jar 7 cannot be transferred before handover",
  "TRANSFER_OPEN: a transfer of this jar is open; cancel it before spending",
  "NO_OPEN_TRANSFER: no transfer of this jar is open",
  "TRANSFER_ACCEPTED: buyer.testnet accepted this transfer; it can no longer be cancelled",
  "NOT_THE_RECEIVER: only buyer.testnet can accept this transfer",
  "INVALID_BTC_KEY: the receiver's Bitcoin key is not a compressed secp256k1 key",
  "KEY_CHANGED: this transfer was accepted with another Bitcoin key",
];

describe("refusals", () => {
  test.each(PART_TWO_REFUSALS)("part 2 refusal %s comes back typed, without account names, NEAR or gas", (panic) => {
    const answer = result(refusedWith(panic), CONTRACT);
    if (!("refusal" in answer)) throw new Error("not refused");
    expect(answer.refusal.code).toBe(panic.split(":")[0]);
    expect(answer.refusal.message).not.toMatch(/\.testnet|NEAR|gas|yocto|account/i);
  });

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
      "BAD_MPC_ROOT_KEY: the MPC root key must be a secp256k1 key",
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
