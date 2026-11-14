// The jar's Bitcoin history from a public Esplora API: mempool.space first, Blockstream if it
// fails (same paths and shape). Paging differs (50 vs 25 a page), so a walk stops at an empty page.
import { ProofUnavailableError } from "./errors.ts";
import { bitcoinTransactionUrl } from "./explorer.ts";
import { getJson } from "./http.ts";

const EXPLORERS = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];

interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

export interface BitcoinTransaction {
  txid: string;
  explorerUrl: string;
  /** null while unconfirmed. */
  blockHeight: number | null;
  /** Unix seconds of the block; null while unconfirmed. */
  time: number | null;
  /** Sats paid to the jar's address(es). */
  received: number;
  /** Sats spent from the jar's address(es). */
  sent: number;
  fee: number;
}

export async function bitcoinTransactions(http: typeof fetch, addresses: string[]): Promise<BitcoinTransaction[]> {
  const seen = new Map<string, EsploraTx>();
  for (const address of addresses) {
    for (const tx of await addressHistory(http, address)) seen.set(tx.txid, tx);
  }
  // Not yet in a block first, then highest block first; a stable sort keeps the explorer's order within a block.
  const height = (tx: EsploraTx) => (tx.status.confirmed ? (tx.status.block_height ?? 0) : Number.MAX_SAFE_INTEGER);
  return [...seen.values()].sort((a, b) => height(b) - height(a)).map((tx) => toBitcoinTransaction(tx, new Set(addresses)));
}

async function addressHistory(http: typeof fetch, address: string): Promise<EsploraTx[]> {
  for (const base of EXPLORERS) {
    try {
      return await walk(http, base, address);
    } catch (error) {
      if (!(error instanceof ProofUnavailableError)) throw error;
    }
  }
  throw new ProofUnavailableError("bitcoin");
}

async function walk(http: typeof fetch, base: string, address: string): Promise<EsploraTx[]> {
  const all: EsploraTx[] = [];
  let page = await esplora(http, `${base}/address/${address}/txs`);
  for (;;) {
    all.push(...page);
    const confirmed = page.filter((tx) => tx.status.confirmed);
    const last = confirmed.at(-1);
    if (last === undefined) return all;
    page = await esplora(http, `${base}/address/${address}/txs/chain/${last.txid}`);
  }
}

async function esplora(http: typeof fetch, url: string): Promise<EsploraTx[]> {
  const page = await getJson(http, "bitcoin", url);
  if (!Array.isArray(page)) throw new ProofUnavailableError("bitcoin");
  return page as EsploraTx[];
}

function toBitcoinTransaction(tx: EsploraTx, jar: Set<string>): BitcoinTransaction {
  const ours = (address: string | undefined) => address !== undefined && jar.has(address);
  return {
    txid: tx.txid,
    explorerUrl: bitcoinTransactionUrl(tx.txid),
    blockHeight: tx.status.confirmed ? (tx.status.block_height ?? null) : null,
    time: tx.status.confirmed ? (tx.status.block_time ?? null) : null,
    received: tx.vout.filter((o) => ours(o.scriptpubkey_address)).reduce((sum, o) => sum + o.value, 0),
    sent: tx.vin.reduce((sum, i) => sum + (i.prevout && ours(i.prevout.scriptpubkey_address) ? i.prevout.value : 0), 0),
    fee: tx.fee,
  };
}
