import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { topupProof, type TopupProof } from "./merkle.ts";

interface Block {
  block_hash: string;
  merkle_root: string;
  txids: string[];
}

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const odd = fixture("../fixtures/testnet3-block-5303840.json") as Block;
const even = fixture("../fixtures/testnet3-block-5303784.json") as Block;

const internal = (display: string) => hexToBytes(display).reverse();
const display = (bytes: Uint8Array) => bytesToHex(bytes.slice().reverse());
const sha256d = (bytes: Uint8Array) => sha256(sha256(bytes));

/** Walks a proof up from its leaf to the root a Bitcoin header commits to. */
function root(leaf: string, index: number, siblings: string[]): string {
  let node = internal(leaf);
  let position = index;
  for (const sibling of siblings) {
    const pair =
      position % 2 === 1
        ? [...internal(sibling), ...node]
        : [...node, ...internal(sibling)];
    node = sha256d(Uint8Array.from(pair));
    position = Math.floor(position / 2);
  }
  return display(node);
}

describe("a top-up proof", () => {
  for (const block of [odd, even]) {
    it(`leads every transaction of a ${block.txids.length}-transaction block to the header's merkle root`, () => {
      block.txids.forEach((txid, index) => {
        const proof = topupProof(block.block_hash, block.txids, txid);
        expect(proof.tx_index).toBe(index);
        expect(root(txid, index, proof.merkle_proof)).toBe(block.merkle_root);
      });
    });

    it(`proves the coinbase of a ${block.txids.length}-transaction block to the same root`, () => {
      const proof = topupProof(block.block_hash, block.txids, block.txids[1]!);
      expect(proof.coinbase_tx_id).toBe(block.txids[0]);
      expect(proof.coinbase_merkle_proof).toHaveLength(proof.merkle_proof.length);
      expect(root(proof.coinbase_tx_id, 0, proof.coinbase_merkle_proof)).toBe(block.merkle_root);
    });
  }

  it("is the argument the live light client accepted for the last transaction of block 5,303,840", () => {
    const live = fixture("../../contract/tests/fixtures/light_client_live.json") as {
      cases: { name: string; args_hex: string }[];
    };
    const args = hexToBytes(live.cases.find((c) => c.name === "valid")!.args_hex);
    const proof = topupProof(odd.block_hash, odd.txids, odd.txids[28]!);
    expect(bytesToHex(borsh(proof))).toBe(bytesToHex(args));
  });

  it("refuses a transaction the block does not hold", () => {
    expect(() => topupProof(odd.block_hash, odd.txids, "00".repeat(32))).toThrow(
      /not in block/,
    );
  });
});

/** The light client's borsh `TxInclusionProof` (stack notes §5), hashes in internal order. */
function borsh(proof: TopupProof): Uint8Array {
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const hashes = (list: string[]) => [u32(list.length), ...list.map(internal)];
  const parts = [
    internal(proof.tx_id),
    internal(proof.tx_block_blockhash),
    u64(proof.tx_index),
    ...hashes(proof.merkle_proof),
    internal(proof.coinbase_tx_id),
    ...hashes(proof.coinbase_merkle_proof),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
