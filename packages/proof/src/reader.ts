import { bitcoinTransactions, type BitcoinTransaction } from "./bitcoin.ts";
import { JarNotFoundError, ProofUnavailableError } from "./errors.ts";
import { getJson } from "./http.ts";
import { contractHistory, indexedTransactions } from "./indexer.ts";
import {
  paymentIds,
  toJarProof,
  type CoinView,
  type HistoryView,
  type JarProof,
  type JarView,
  type PaymentView,
  type TokenView,
} from "./jar.ts";
import { jarRefs, toNearTransaction, type NearTransaction } from "./near-transactions.ts";

const NEAR_RPC = "https://rpc.testnet.fastnear.com";
const VIEW_PAGE = 100; // the contract's maximum for get_coins and get_history

export interface ProofReaderOptions {
  /** The jar contract's account. */
  contract: string;
  fetch?: typeof fetch;
}

/** Public data behind a jar's proof view. No sign-in; testnet only. */
export interface ProofReader {
  /** The jar's contract views: settings, address, balance, coins, payments, history and NFT. */
  jar(jarId: string): Promise<JarProof>;
  /** The contract's transactions for the jar, failed ones included, oldest first. */
  nearTransactions(jarId: string): Promise<NearTransaction[]>;
  /** The Bitcoin transactions at the jar's address, newest first, from a public explorer. */
  bitcoinTransactions(jar: JarProof): Promise<BitcoinTransaction[]>;
}

export function createProofReader(options: ProofReaderOptions): ProofReader {
  const http = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { contract } = options;

  async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const answer = (await getJson(http, "near", NEAR_RPC, {
      jsonrpc: "2.0",
      id: "proof",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    })) as { result?: { result?: number[] } };
    const bytes = answer.result?.result;
    if (!Array.isArray(bytes)) throw new ProofUnavailableError("near");
    try {
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T;
    } catch {
      throw new ProofUnavailableError("near");
    }
  }

  async function paged<T>(method: string, jarId: string): Promise<T[]> {
    const all: T[] = [];
    for (;;) {
      const page = await view<unknown>(method, { jar_id: jarId, from_index: all.length, limit: VIEW_PAGE });
      if (!Array.isArray(page)) throw new ProofUnavailableError("near");
      all.push(...(page as T[]));
      if (page.length < VIEW_PAGE) return all;
    }
  }

  return {
    async jar(jarId) {
      const jar = await view<JarView | null>("get_jar", { jar_id: jarId });
      if (jar === null) throw new JarNotFoundError(jarId);
      const [coins, history, token] = await Promise.all([
        paged<CoinView>("get_coins", jarId),
        paged<HistoryView>("get_history", jarId),
        view<TokenView>("nft_token", { token_id: jarId }),
      ]);
      const payments = await Promise.all(
        paymentIds(history).map(async (id) => {
          const payment = await view<PaymentView | null>("get_payment", { payment_id: id });
          // The history names it, so a missing payment means the answer is wrong, not that it is gone.
          if (payment === null) throw new ProofUnavailableError("near");
          return payment;
        }),
      );
      return toJarProof(jar, coins, payments, history, token);
    },

    // get_jar exposes the current address only; once re-homing keeps old addresses, they join here.
    bitcoinTransactions: (jar) => bitcoinTransactions(http, [jar.address]),

    async nearTransactions(jarId) {
      const rows = await contractHistory(http, contract);
      const txs = await indexedTransactions(http, rows.map((r) => r.transaction_hash));
      // A call naming only a payment (confirm_payment, retry_signing) belongs to that payment's jar.
      const paymentJars = new Map<string, string | null>();
      const result: NearTransaction[] = [];
      for (const row of rows.sort((a, b) => a.tx_block_height - b.tx_block_height || a.tx_index - b.tx_index)) {
        const tx = txs.get(row.transaction_hash);
        if (!tx) throw new ProofUnavailableError("indexer");
        const refs = jarRefs(tx, contract);
        let mine = refs.jarIds.has(jarId);
        for (const paymentId of refs.paymentIds) {
          if (!paymentJars.has(paymentId)) {
            const payment = await view<{ jar_id: string } | null>("get_payment", { payment_id: paymentId });
            paymentJars.set(paymentId, payment?.jar_id ?? null);
          }
          if (paymentJars.get(paymentId) === jarId) mine = true;
        }
        if (mine) result.push(toNearTransaction(row, tx, contract));
      }
      return result;
    },
  };
}
