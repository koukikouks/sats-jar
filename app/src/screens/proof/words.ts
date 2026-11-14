// How the public record words the chain: a request's sender by role, never by account (spec
// #37), and the contract's methods in plain words.
import type { JarProof } from "@sats-jar/proof";
import { config } from "../../config.ts";

/** The jar's handover has completed: its history records `handover_completed`. */
export const handoverDone = (jar: JarProof): boolean => jar.history.some((event) => event.event === "handover_completed");

/**
 * Who sent a request, by the part they had in the jar when they sent it (`at`, unix seconds): the
 * child claims before holding the jar, so a claim reads "the child" even once the child holds it.
 */
export function senderRole(jar: JarProof, signer: string, at?: number): string {
  if (signer === jar.giver) return "the giver";
  if (signer === jar.familyAccount) return "the family account";
  if (jar.guardians.includes(signer)) return "a guardian";
  const claimants = jar.history.flatMap((event) => (event.event === "handover_claimed" && event.childAccount ? [event.childAccount] : []));
  const handedOverAt = jar.history.find((event) => event.event === "handover_completed")?.at;
  const beforeHandover = at !== undefined && (handedOverAt === undefined || at < handedOverAt);
  if (claimants.includes(signer) && beforeHandover) return "the child";
  if (signer === jar.holder && jar.holder !== jar.familyAccount) return "the holder";
  if (claimants.includes(signer)) return "the child";
  if (signer === config.keeperAccount) return "Sats Jar's keeper";
  return "someone else";
}

// A NEAR account: named (dot-separated, ending .testnet or .near) or implicit (64 hex characters).
const ACCOUNT = /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)\b|\b[0-9a-f]{64}\b/g;

/** A refusal's reason with every account in it replaced by that account's role. */
export const withoutAccounts = (jar: JarProof, reason: string): string =>
  reason
    .replace(ACCOUNT, (account) => senderRole(jar, account))
    // "only the giver, <account>, can cancel" would read "only the giver, the giver, can cancel".
    .replace(/\b(the giver|a guardian|the holder|the child|Sats Jar's keeper|someone else), \1,/g, "$1");

// The contract's change methods (contract/src: lib, spend, emergency, handover, transfer,
// rehoming, nft). Anything else (the dev-only escape, a method a later contract adds) reads
// "A request", so a method name never reaches the page.
const ACTIONS: Record<string, string> = {
  create_jar: "Create the jar",
  prove_topup: "Prove a top-up",
  request_allowance: "Pay the allowance",
  retry_signing: "Sign a payment again",
  confirm_payment: "Confirm a payment on Bitcoin",
  request_spend: "Spend from the jar",
  propose_emergency: "Propose an emergency payment",
  approve_emergency: "Approve the emergency payment",
  cancel_emergency: "Cancel the emergency payment",
  execute_emergency: "Send the emergency payment",
  claim_handover: "Claim the jar",
  confirm_handover: "Confirm the handover",
  cancel_handover: "Cancel the handover",
  complete_handover: "Complete the handover",
  rehome_stray: "Move a stray top-up",
  start_transfer: "Start a transfer",
  cancel_transfer: "Cancel the transfer",
  accept_transfer: "Accept the transfer",
  nft_transfer: "Move the jar",
};

/** A request's method in plain words. */
export const action = (method: string): string => ACTIONS[method] ?? "A request";
