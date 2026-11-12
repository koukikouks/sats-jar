import { nearTransactionUrl } from "./explorer.ts";

/** One row of FastNEAR's `/v0/account` history. */
export interface AccountTx {
  transaction_hash: string;
  tx_block_height: number;
  tx_block_timestamp: string;
  tx_index: number;
  is_success: boolean;
}

interface Outcome {
  logs: string[];
  executor_id: string;
  status: Record<string, unknown>;
}

/** One entry of FastNEAR's `/v0/transactions`: the transaction and every receipt's outcome. */
export interface IndexedTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  receipts: { execution_outcome: { outcome: Outcome } }[];
}

export interface Refusal {
  /** The contract's refusal code, or null when the transaction failed before the rule answered. */
  code: string | null;
  reason: string;
}

export interface NearTransaction {
  hash: string;
  explorerUrl: string;
  blockHeight: number;
  /** Unix seconds. */
  time: number;
  signer: string;
  method: string;
  ok: boolean;
  refusal: Refusal | null;
}

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** What a transaction says about which jar it concerns, before payments are resolved. */
export interface JarRefs {
  jarIds: Set<string>;
  paymentIds: Set<string>;
}

export function calls(tx: IndexedTx, contract: string): Call[] {
  if (tx.transaction.receiver_id !== contract) return [];
  return tx.transaction.actions.flatMap((action) => {
    const call = (action as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
    return call ? [{ method: call.method_name, args: decodeArgs(call.args) }] : [];
  });
}

export function jarRefs(tx: IndexedTx, contract: string): JarRefs {
  const refs: JarRefs = { jarIds: new Set(), paymentIds: new Set() };
  for (const { args } of calls(tx, contract)) {
    if (typeof args.jar_id === "string") refs.jarIds.add(args.jar_id);
    if (typeof args.token_id === "string") refs.jarIds.add(args.token_id);
    if (typeof args.payment_id === "string") refs.paymentIds.add(args.payment_id);
  }
  for (const jarId of eventJarIds(tx, contract)) refs.jarIds.add(jarId);
  return refs;
}

export function toNearTransaction(row: AccountTx, tx: IndexedTx, contract: string): NearTransaction {
  return {
    hash: row.transaction_hash,
    explorerUrl: nearTransactionUrl(row.transaction_hash),
    blockHeight: row.tx_block_height,
    time: Number(BigInt(row.tx_block_timestamp) / 1_000_000_000n),
    signer: tx.transaction.signer_id,
    method: calls(tx, contract)[0]?.method ?? "",
    ok: row.is_success,
    refusal: row.is_success ? null : refusal(tx, contract),
  };
}

/** Shown when a transaction failed for any reason other than the contract's own refusal. */
export const FAILED_BEFORE_RULE = "The transaction failed before the jar's rule could answer.";

const PANIC_PREFIX = "Smart contract panicked: ";
const CODE_SENTENCE = /^([A-Z][A-Z0-9_]*): (.+)$/s;

// The last failure the contract itself raised: a light-client panic is followed by our own
// NOT_IN_CHAIN, and ours is the reason. Anything but a `CODE: sentence` panic (gas, bad args,
// a Rust panic location) is replaced by a fixed sentence, never passed on.
function refusal(tx: IndexedTx, contract: string): Refusal {
  const failures = tx.receipts
    .map(({ execution_outcome: { outcome } }) => outcome)
    .filter((outcome) => outcome.executor_id === contract && "Failure" in outcome.status);
  const last = failures.at(-1);
  const error = (last?.status as { Failure?: { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } } } | undefined)
    ?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof error === "string" && error.startsWith(PANIC_PREFIX)) {
    const match = CODE_SENTENCE.exec(error.slice(PANIC_PREFIX.length));
    if (match?.[1] && match[2]) return { code: match[1], reason: match[2] };
  }
  return { code: null, reason: FAILED_BEFORE_RULE };
}

// `satsjar` NEP-297 events name their jar; only logs the contract itself wrote count.
function eventJarIds(tx: IndexedTx, contract: string): string[] {
  return tx.receipts.flatMap(({ execution_outcome: { outcome } }) =>
    outcome.executor_id !== contract
      ? []
      : outcome.logs.flatMap((log) => {
          if (!log.startsWith("EVENT_JSON:")) return [];
          const event = parseJson(log.slice("EVENT_JSON:".length)) as { standard?: unknown; data?: { jar_id?: unknown } } | null;
          const jarId = event?.standard === "satsjar" ? event.data?.jar_id : undefined;
          return typeof jarId === "string" ? [jarId] : [];
        }),
  );
}

function decodeArgs(base64: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
