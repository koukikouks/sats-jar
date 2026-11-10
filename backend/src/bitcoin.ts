/** Where a transaction stands on Bitcoin, as Esplora's `/tx/:txid/status` shows it. */
export type TxStatus = { confirmed: boolean; block_height?: number; block_hash?: string };

/** An unspent output at an address, as Esplora's `/address/:address/utxo` lists it. */
export type Output = { txid: string; vout: number; value: number; status: TxStatus };

/** "known": Bitcoin already has it (in the mempool or a block). */
export type Broadcast = "sent" | "known" | { refused: string };

/** What the keeper needs from Bitcoin testnet3. The live adapter is `esplora`; tests use a fake. */
export interface Bitcoin {
  outputs(address: string): Promise<Output[]>;
  status(txid: string): Promise<TxStatus>;
  txHex(txid: string): Promise<string>;
  blockTxids(blockHash: string): Promise<string[]>;
  broadcast(txHex: string): Promise<Broadcast>;
  /** The lowest fee rate the mempool takes now, sat/vB. */
  minimumFee(): Promise<number>;
}

/** Testnet3 Esplora APIs: mempool.space first, Blockstream (same paths) if it is down (stack notes §8). */
const BASES = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];

/** Bitcoin Core's answers for a transaction it already has, in a block or in its mempool. */
const ALREADY_HELD = /already in (?:block chain|utxo set)|txn-already-(?:in-mempool|known)/;

export function esplora(options: { fetch?: typeof fetch } = {}): Bitcoin {
  const fetchFn = options.fetch ?? fetch;

  /** The first answer that is not an outage; Bitcoin's own refusals (4xx) are answers. */
  async function request(path: string, init?: RequestInit): Promise<Response> {
    for (const base of BASES) {
      try {
        const response = await fetchFn(`${base}${path}`, init);
        if (response.status < 500 && response.status !== 429) return response;
      } catch {
        // Unreachable: try the next API.
      }
    }
    throw new Error(`Esplora ${path}: no API answered`);
  }

  async function json<T>(path: string): Promise<T> {
    const response = await request(path);
    if (!response.ok) throw new Error(`Esplora ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  return {
    outputs: (address) => json<Output[]>(`/address/${address}/utxo`),
    status: (txid) => json<TxStatus>(`/tx/${txid}/status`),
    async txHex(txid) {
      const response = await request(`/tx/${txid}/hex`);
      if (!response.ok) throw new Error(`Esplora /tx/${txid}/hex: ${response.status}`);
      return (await response.text()).trim();
    },
    blockTxids: (blockHash) => json<string[]>(`/block/${blockHash}/txids`),
    async broadcast(txHex) {
      const response = await request("/tx", { method: "POST", body: txHex });
      if (response.ok) return "sent";
      const reason = await response.text();
      return ALREADY_HELD.test(reason) ? "known" : { refused: reason };
    },
    // mempool.space only: Blockstream has no such endpoint, so its 404 fails the call.
    async minimumFee() {
      return (await json<{ minimumFee: number }>("/v1/fees/recommended")).minimumFee;
    },
  };
}
