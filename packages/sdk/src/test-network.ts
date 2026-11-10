// Test-only: the network the SDK sees in tests. The backend is T15's real handler (fake chain,
// real file store); NEAR RPC and the Bitcoin explorers answer with live responses recorded in
// src/fixtures (an unrecorded request throws). Signed transactions are decoded and kept so a
// test can read exactly what the SDK sent.
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSignedTransaction } from "near-api-js";
// The backend has no package exports and T16 owns backend/ now, so tests reach its handler by path.
import { createBackend } from "../../../backend/src/http.ts";
import { fileStore } from "../../../backend/src/file-store.ts";
import type { Chain as BackendChain } from "../../../backend/src/chain.ts";
import type { DeviceStorage } from "./api.ts";

export const APP = "sats-jar-app.testnet";
export const CONTRACT = "sats-jar-dev.testnet";
export const BACKEND = "https://backend.test";
const NEAR_RPC = "https://rpc.testnet.fastnear.com";

export interface Exchange {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}
export interface Fixture {
  recorded_at: string;
  note: string;
  exchanges: Exchange[];
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

/** A recorded JSON-RPC answer body, found by its request. */
export function recorded(name: string, match: (body: RpcBody) => boolean): unknown {
  const hit = fixture(name).exchanges.find((e) => match(e.request.body as RpcBody));
  if (!hit) throw new Error(`no recording in ${name}`);
  return hit.response.body;
}

export interface RpcBody {
  method: string;
  params: Record<string, unknown>;
}

/** One function call the SDK signed and sent, decoded from the signed transaction's bytes. */
export interface SentCall {
  signerId: string;
  publicKey: string;
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
  signedTx: string;
}

/** What the fake RPC answers to send_tx: a JSON-RPC body, or a thrown error (a lost response). */
export type SendTx = (call: SentCall, attempt: number) => unknown;

export interface TestNetwork {
  fetch: typeof fetch;
  /** Every send_tx, in order (a rebroadcast of the same bytes counts again). */
  sent: SentCall[];
  /** Accounts the backend's sponsor made. */
  accounts: Map<string, string>;
  /** Jar guardians as the backend's chain reads them (filled from create_jar calls that succeed). */
  jars: Map<string, string[]>;
  /** Make the backend's next answers fail with 500 (a chain hiccup). */
  breakBackend(times: number): void;
  storage(): DeviceStorage;
}

export function testNetwork(options: {
  fixtures?: Fixture[];
  /** Synthetic views (labelled in the test) answered before the recordings. */
  views?: { method: string; args: Record<string, unknown>; result: unknown }[];
  sendTx?: SendTx;
  /** tx status answers by hash; unknown hashes get the recorded UNKNOWN_TRANSACTION. */
  txStatus?: (hash: string) => unknown | undefined;
}): TestNetwork {
  const accounts = new Map<string, string>();
  const jars = new Map<string, string[]>();
  let broken = 0;
  const chain: BackendChain = {
    async createAccount(accountId, publicKey) {
      if (broken > 0) {
        broken -= 1;
        throw new Error("chain hiccup");
      }
      if (accounts.has(accountId)) return "exists";
      accounts.set(accountId, publicKey);
      return "created";
    },
    async jarGuardians(jarId) {
      if (broken > 0) {
        broken -= 1;
        throw new Error("chain hiccup");
      }
      return jars.get(jarId);
    },
  };
  const store = fileStore(join(mkdtempSync(join(tmpdir(), "sats-jar-sdk-")), "drafts.json"));
  const backend = createBackend({ chain, store, appAccount: APP });
  const exchanges = [...(options.fixtures ?? []), fixture("near")].flatMap((f) => f.exchanges);
  const sent: SentCall[] = [];
  const near = fixture("near");

  async function rpc(body: RpcBody): Promise<unknown> {
    const { method, params } = body;
    if (method === "send_tx") {
      const call = decode(params.signed_tx_base64 as string);
      sent.push(call);
      if (!options.sendTx) throw new Error("this test sends no transactions");
      return options.sendTx(call, sent.length);
    }
    if (method === "tx") {
      const answer = options.txStatus?.(params.tx_hash as string);
      if (answer !== undefined) return answer;
      return recordedIn(near, (b) => b.method === "tx" && b.params.wait_until === "NONE");
    }
    if (method === "block" || params.request_type === "view_access_key") {
      // Signing needs a nonce and a recent block; any recorded one serves.
      return recordedIn(near, (b) => b.method === method && b.params.request_type === params.request_type);
    }
    if (params.request_type === "call_function") {
      const args = JSON.parse(atob(params.args_base64 as string)) as Record<string, unknown>;
      const synthetic = options.views?.find(
        (v) => v.method === params.method_name && canonical(v.args) === canonical(args),
      );
      if (synthetic) return { jsonrpc: "2.0", id: "sdk", result: { result: [...new TextEncoder().encode(JSON.stringify(synthetic.result))] } };
      const hit = exchanges.find((e) => {
        const b = e.request.body as RpcBody;
        return (
          e.request.url === NEAR_RPC &&
          b.params?.request_type === "call_function" &&
          b.params.method_name === params.method_name &&
          canonical(JSON.parse(atob(b.params.args_base64 as string))) === canonical(args)
        );
      });
      if (!hit) throw new Error(`unrecorded view ${String(params.method_name)} ${JSON.stringify(args)}`);
      return hit.response.body;
    }
    throw new Error(`unrecorded RPC ${method}`);
  }

  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(BACKEND)) {
      return backend(new Request(url.replace(BACKEND, "http://backend.test"), init));
    }
    if (url === NEAR_RPC) {
      const body = JSON.parse(String(init?.body)) as RpcBody;
      const answer = await rpc(body);
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    const hit = exchanges.find((e) => e.request.method === (init?.method ?? "GET") && e.request.url === url);
    if (!hit) throw new Error(`unrecorded request: ${url}`);
    const text = typeof hit.response.body === "string" ? hit.response.body : JSON.stringify(hit.response.body);
    return new Response(text, { status: hit.response.status });
  };

  return {
    fetch: http,
    sent,
    accounts,
    jars,
    breakBackend(times) {
      broken = times;
    },
    storage: memoryStorage,
  };
}

export function memoryStorage(): DeviceStorage {
  const memory = new Map<string, string>();
  return {
    get: async (key) => memory.get(key) ?? null,
    set: async (key, value) => void memory.set(key, value),
    delete: async (key) => void memory.delete(key),
  };
}

function recordedIn(f: Fixture, match: (body: RpcBody) => boolean): unknown {
  const hit = f.exchanges.find((e) => match(e.request.body as RpcBody));
  if (!hit) throw new Error("no such recording");
  return hit.response.body;
}

function decode(base64: string): SentCall {
  const signed = decodeSignedTransaction(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  const tx = signed.transaction;
  const action = tx.actions[0]?.functionCall;
  if (!action) throw new Error("not a function call");
  return {
    signerId: tx.signerId,
    publicKey: tx.publicKey.toString(),
    receiverId: tx.receiverId,
    method: action.methodName,
    args: JSON.parse(new TextDecoder().decode(Uint8Array.from(action.args))) as Record<string, unknown>,
    gas: BigInt(action.gas),
    deposit: BigInt(action.deposit),
    signedTx: base64,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
