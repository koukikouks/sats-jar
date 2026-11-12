// FastNEAR's keyless tx API: the contract's whole history, then each transaction with its receipts.
import { ProofUnavailableError } from "./errors.ts";
import { getJson } from "./http.ts";
import type { AccountTx, IndexedTx } from "./near-transactions.ts";

const INDEXER = "https://tx.test.fastnear.com";
const INDEXER_PAGE = 200; // FastNEAR's maximum page
const INDEXER_BATCH = 20; // FastNEAR's documented maximum for /v0/transactions

export async function contractHistory(http: typeof fetch, contract: string, pageSize = INDEXER_PAGE): Promise<AccountTx[]> {
  const rows: AccountTx[] = [];
  let resumeToken: string | undefined;
  do {
    const page = (await getJson(http, "indexer", `${INDEXER}/v0/account`, {
      account_id: contract,
      limit: pageSize,
      desc: false,
      ...(resumeToken === undefined ? {} : { resume_token: resumeToken }),
    })) as { account_txs?: AccountTx[]; resume_token?: string };
    if (!Array.isArray(page.account_txs)) throw new ProofUnavailableError("indexer");
    rows.push(...page.account_txs);
    resumeToken = page.resume_token;
  } while (resumeToken !== undefined);
  return rows;
}

export async function indexedTransactions(http: typeof fetch, hashes: string[]): Promise<Map<string, IndexedTx>> {
  const found = new Map<string, IndexedTx>();
  for (let i = 0; i < hashes.length; i += INDEXER_BATCH) {
    const batch = (await getJson(http, "indexer", `${INDEXER}/v0/transactions`, {
      tx_hashes: hashes.slice(i, i + INDEXER_BATCH),
    })) as { transactions?: IndexedTx[] };
    if (!Array.isArray(batch.transactions)) throw new ProofUnavailableError("indexer");
    for (const tx of batch.transactions) found.set(tx.transaction.hash, tx);
  }
  return found;
}
