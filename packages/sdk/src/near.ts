// NEAR over plain JSON-RPC: views, signing a function call from the device's key, sending it and
// reading its outcome. near-api-js only builds and signs; every request goes through `fetch`.
import {
  KeyPair,
  KeyPairSigner,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  type KeyPairString,
} from "near-api-js";
import { knownCode, refusal, unavailable } from "./refusals.ts";
import type { SatsJarRefusal } from "./api.ts";

/** Testnet only (CODING_STANDARDS); the endpoint the backend and proof view use. */
export const NEAR_RPC = "https://rpc.testnet.fastnear.com";
export const nearTransactionUrl = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

/** A JSON-RPC error answer: its cause name (INVALID_TRANSACTION, UNKNOWN_TRANSACTION, ...). */
class RpcError extends Error {
  readonly cause: string;
  constructor(cause: string) {
    super(cause);
    this.cause = cause;
  }
}

export interface FunctionCall {
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/** A signed transaction, kept as its bytes so it can be sent again unchanged. */
export interface SignedCall {
  signerId: string;
  hash: string;
  /** base64 */
  signedTx: string;
}

interface Status {
  Failure?: unknown;
  SuccessValue?: string;
}

/** The final outcome of a transaction, as RPC `send_tx` and `tx` give it. */
export interface Outcome {
  status: Status;
  transaction_outcome: { id: string };
  receipts_outcome: { outcome: { executor_id: string; status: Status } }[];
}

/** The transaction was refused before it ran (bad nonce, expired, unknown key, no balance). */
export class Rejected extends Error {}

export function near(http: typeof fetch, contract: string) {
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let answer: { result?: T; error?: { cause?: { name?: string } } };
    try {
      const response = await http(NEAR_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "sdk", method, params }),
      });
      answer = (await response.json()) as typeof answer;
    } catch {
      throw unavailable();
    }
    if (answer.error) throw new RpcError(answer.error.cause?.name ?? "UNKNOWN");
    if (answer.result === undefined) throw unavailable();
    return answer.result;
  }

  async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      const { result } = await rpc<{ result: number[] }>("query", {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      });
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(result))) as T;
    } catch (error) {
      if (error instanceof RpcError || error instanceof SyntaxError) throw unavailable();
      throw error;
    }
  }

  /** A brand-new account's key shows at final a few blocks after the backend made it (T15). */
  async function finalAccessKey(accountId: string, publicKey: string): Promise<{ nonce: number | string }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
      } catch (error) {
        const fresh = error instanceof RpcError && (error.cause === "UNKNOWN_ACCESS_KEY" || error.cause === "UNKNOWN_ACCOUNT");
        if (!fresh || attempt === 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  return {
    view,

    /** Signs a call to the contract with the device's key: next nonce, a final block. */
    async sign(signer: { accountId: string; secretKey: string }, call: FunctionCall): Promise<SignedCall> {
      const key = KeyPair.fromString(signer.secretKey as KeyPairString);
      try {
        const accessKey = await finalAccessKey(signer.accountId, key.getPublicKey().toString());
        const block = await rpc<{ header: { hash: string } }>("block", { finality: "final" });
        const tx = createTransaction(
          signer.accountId,
          key.getPublicKey(),
          contract,
          BigInt(accessKey.nonce) + 1n,
          [actions.functionCall(call.method, call.args, call.gas, call.deposit)],
          baseDecode(block.header.hash),
        );
        const { txHash, signedTransaction } = await new KeyPairSigner(key).signTransaction(tx);
        return {
          signerId: signer.accountId,
          hash: baseEncode(txHash),
          signedTx: btoa(String.fromCharCode(...encodeTransaction(signedTransaction))),
        };
      } catch (error) {
        if (error instanceof RpcError) throw unavailable();
        throw error;
      }
    },

    /** Sends the signed bytes and waits for the final outcome. Throws `Rejected` or UNAVAILABLE. */
    async send(tx: SignedCall): Promise<Outcome> {
      try {
        return await rpc<Outcome>("send_tx", { signed_tx_base64: tx.signedTx, wait_until: "FINAL" });
      } catch (error) {
        if (error instanceof RpcError && error.cause === "INVALID_TRANSACTION") throw new Rejected();
        if (error instanceof RpcError) throw unavailable();
        throw error;
      }
    },

    /** The transaction's final outcome, or null if the chain has never seen it. */
    async outcome(tx: SignedCall): Promise<Outcome | null> {
      const status = (wait: string) =>
        rpc<Outcome>("tx", { tx_hash: tx.hash, sender_account_id: tx.signerId, wait_until: wait });
      try {
        await status("NONE");
        return await status("FINAL");
      } catch (error) {
        if (error instanceof RpcError && error.cause === "UNKNOWN_TRANSACTION") return null;
        if (error instanceof RpcError) throw unavailable();
        throw error;
      }
    },
  };
}

export type Near = ReturnType<typeof near>;

const PANIC = "Smart contract panicked: ";

/**
 * The call's return value, or the refusal it ended in. The contract's refusal is the last
 * `Smart contract panicked: CODE: sentence` from a receipt the contract ran (T20's rule); a
 * panic with no code or an unknown code reads REFUSED, and any other failure TRANSACTION_FAILED.
 */
export function result(outcome: Outcome, contract: string): { value: unknown } | { refusal: SatsJarRefusal } {
  const explorerUrl = nearTransactionUrl(outcome.transaction_outcome.id);
  if (outcome.status.Failure === undefined) {
    const value = outcome.status.SuccessValue ?? "";
    return { value: value === "" ? null : JSON.parse(atob(value)) };
  }
  let panic: string | null = null;
  for (const receipt of outcome.receipts_outcome) {
    const text = executionError(receipt.outcome.status.Failure);
    if (receipt.outcome.executor_id === contract && text?.startsWith(PANIC)) panic = text.slice(PANIC.length);
  }
  if (panic === null) return { refusal: refusal("TRANSACTION_FAILED", explorerUrl) };
  const code = knownCode(/^([A-Z][A-Z0-9_]*): /.exec(panic)?.[1] ?? "");
  return { refusal: refusal(code ?? "REFUSED", explorerUrl) };
}

function executionError(failure: unknown): string | null {
  const text = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } } | undefined)
    ?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof text === "string" ? text : null;
}
