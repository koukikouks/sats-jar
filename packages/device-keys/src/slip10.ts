import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

const HARDENED = 0x80000000;

// SLIP-10 for ed25519: every step is hardened, so only the private chain is needed.
export function slip10Ed25519(seed: Uint8Array, path: readonly number[]): Uint8Array {
  let node = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(node.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0);
    node = hmac(sha512, node.subarray(32), data);
  }
  return node.slice(0, 32);
}
