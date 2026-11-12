// A transaction's inclusion proof for the jar contract (`prove_topup`, `confirm_payment`), built
// the way the light client's `merkle_proof_calculator` does (stack notes §5).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** The contract's `TopupProof` JSON: hashes in display hex, as explorers print them. */
export interface TopupProof {
  tx_id: string;
  tx_block_blockhash: string;
  tx_index: number;
  merkle_proof: string[];
  coinbase_tx_id: string;
  coinbase_merkle_proof: string[];
}

/** The proof that `txid` is in the block `blockHash`, whose transactions are `txids` in order. */
export function topupProof(blockHash: string, txids: string[], txid: string): TopupProof {
  const index = txids.indexOf(txid);
  if (index < 0) throw new Error(`transaction ${txid} is not in block ${blockHash}`);
  const leaves = txids.map((t) => hexToBytes(t).reverse());
  return {
    tx_id: txid,
    tx_block_blockhash: blockHash,
    tx_index: index,
    merkle_proof: siblings(leaves, index).map(display),
    coinbase_tx_id: txids[0]!,
    coinbase_merkle_proof: siblings(leaves, 0).map(display),
  };
}

/** The sibling at each level, duplicating the last hash of an odd level (Bitcoin's rule). */
function siblings(leaves: Uint8Array[], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let level = leaves;
  let position = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]!];
    proof.push(level[position ^ 1]!);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(sha256(Uint8Array.from([...level[i]!, ...level[i + 1]!]))));
    }
    level = next;
    position = Math.floor(position / 2);
  }
  return proof;
}

function display(internal: Uint8Array): string {
  return bytesToHex(internal.slice().reverse());
}
