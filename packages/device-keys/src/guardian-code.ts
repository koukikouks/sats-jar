import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

export class InvalidPublicKeyError extends Error {
  readonly code = "INVALID_PUBLIC_KEY";
  constructor() {
    super("INVALID_PUBLIC_KEY: not an ed25519 NEAR public key");
    this.name = "InvalidPublicKeyError";
  }
}

const DOMAIN = new TextEncoder().encode("sats-jar guardian code v1");

// About 66 bits (20 digits): an adult who has seen the child's code cannot grind a key to match it
// (ADR 0009: one honest guardian must stop a swapped-in account). 72 bits mod 10^20 keeps every digit used.
export function guardianCode(nearPublicKey: string): string {
  const key = decodeEd25519(nearPublicKey);
  const digest = sha256(new Uint8Array([...DOMAIN, ...key]));
  let n = 0n;
  for (const byte of digest.subarray(0, 9)) n = (n << 8n) | BigInt(byte);
  const digits = (n % 10n ** 20n).toString().padStart(20, "0");
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function decodeEd25519(nearPublicKey: string): Uint8Array {
  const prefix = "ed25519:";
  if (!nearPublicKey.startsWith(prefix)) throw new InvalidPublicKeyError();
  let key: Uint8Array;
  try {
    key = base58.decode(nearPublicKey.slice(prefix.length));
  } catch {
    throw new InvalidPublicKeyError();
  }
  if (key.length !== 32) throw new InvalidPublicKeyError();
  return key;
}
