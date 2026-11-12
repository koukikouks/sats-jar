import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { Refusal } from "./refusal.ts";

const ED25519 = "ed25519:";

/**
 * The sub-account a device key gets: the first 20 hex chars of SHA-256 over the key's 32 raw
 * bytes, under the app account. One key always maps to one account, so a retry or a restored
 * phone finds the same account. Never shown to anyone (ADR 0003).
 */
export function accountIdFor(publicKey: string, appAccount: string): string {
  return `${bytesToHex(sha256(publicKeyBytes(publicKey))).slice(0, 20)}.${appAccount}`;
}

/** Device keys are ed25519 (T07), written `ed25519:<base58 of 32 bytes>`. */
function publicKeyBytes(publicKey: string): Uint8Array {
  const invalid = new Refusal(
    400,
    "INVALID_PUBLIC_KEY",
    "the device key must be an ed25519 public key",
  );
  if (!publicKey.startsWith(ED25519)) throw invalid;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(publicKey.slice(ED25519.length));
  } catch {
    throw invalid;
  }
  if (bytes.length !== 32) throw invalid;
  return bytes;
}
