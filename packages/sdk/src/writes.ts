// The one way part 2 sends a transaction: from this device's own account, signed with its key,
// one at a time, and never twice by accident.
import type { DeviceStorage } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import type { deviceKeys } from "./device.ts";
import { Rejected, nearTransactionUrl, result, type FunctionCall, type Near, type Outcome, type SignedCall } from "./near.ts";
import { refusal } from "./refusals.ts";

/** Prepaid gas for a call that signs nothing (findings-t15: keep each person's prepaid gas low). */
export const CALL_GAS = 30_000_000_000_000n;
/** The contract's full-access-key check on every handover, emergency and holder call. */
export const ONE_YOCTO = 1n;

const SENDING = "sats-jar:sending:";

export interface Written {
  value: unknown;
  explorerUrl: string;
}

/** A signed transaction whose outcome this device has not seen yet. */
interface Sending extends SignedCall {
  args: Record<string, unknown>;
}

/**
 * Runs one task at a time, in call order: the device's writes never race each other for a nonce,
 * and a double tap waits for the first tap's answer.
 */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

export type Serial = ReturnType<typeof serial>;

/**
 * Sends a call to the contract. Before it is sent, the signed bytes are stored on the device
 * under the method and jar; any later call of that method on that jar first settles them. A
 * landed transaction (its answer lost) is taken as the answer; one never seen is sent again as
 * the same bytes (one nonce, so at most one can land); only bytes the chain now rejects and
 * neither RPC nor the full-history indexer has seen are given up before signing anew.
 */
export function writer(deps: {
  near: Near;
  keys: ReturnType<typeof deviceKeys>;
  backend: BackendClient;
  storage: DeviceStorage;
  contract: string;
  run: Serial;
}) {
  const { near, keys, backend, storage, contract, run } = deps;

  /** The call's outcome as a value and link, or its refusal (with the link) thrown. */
  function answer(outcome: Outcome): Written {
    const read = result(outcome, contract);
    if ("refusal" in read) throw read.refusal;
    return { value: read.value, explorerUrl: nearTransactionUrl(outcome.transaction_outcome.id) };
  }

  /** The stored transaction's outcome, or null once it is sure it never landed and never will. */
  async function settle(stored: Sending): Promise<Outcome | null> {
    const seen = await near.outcome(stored);
    if (seen) return seen;
    try {
      return await near.send(stored);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      // Expired, or its nonce is used because it landed: look again, in full history too.
      return (await near.outcome(stored)) ?? (await near.indexed(stored.hash));
    }
  }

  async function send(call: FunctionCall): Promise<Written> {
    const { near: key } = await keys.keys();
    const slot = `${SENDING}${call.method}:${String(call.args.jar_id)}`;
    const text = await storage.get(slot);
    if (text !== null) {
      const stored = JSON.parse(text) as Sending;
      const outcome = await settle(stored);
      await storage.delete(slot);
      if (outcome && canonical(stored.args) === canonical(call.args)) return answer(outcome);
    }
    const signerId = await keys.ensureAccount(backend);
    const signed = await near.sign({ accountId: signerId, secretKey: key.secretKey }, call);
    await storage.set(slot, JSON.stringify({ ...signed, args: call.args } satisfies Sending));
    let outcome: Outcome;
    try {
      outcome = await near.send(signed);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      // Refused before it ran: these bytes can never land.
      await storage.delete(slot);
      throw refusal("TRANSACTION_FAILED");
    }
    await storage.delete(slot);
    return answer(outcome);
  }

  return (call: FunctionCall): Promise<Written> => run(() => send(call));
}

export type Write = ReturnType<typeof writer>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
