import { base58, base64 } from "@scure/base";
import { type DeviceKeys, type NearKeyPair, keysFromRecoveryPhrase, nearKeyPair } from "./recovery-phrase.ts";

// The child's blob holds the phrase, the adult's the device key (ADR 0009).
export type DeviceSecret = { kind: "device-key"; near: NearKeyPair } | { kind: "recovery-phrase"; phrase: string };
// Face ID (WebAuthn PRF) would be a second variant here.
export type UnlockMethod = { kind: "pin"; pin: string };
// Plain JSON for the device's own storage; base64 fields.
export type LockedKeys = { v: 1; method: "pin"; iterations: number; salt: string; iv: string; ciphertext: string };

export class WrongPinError extends Error {
  readonly code = "WRONG_PIN";
  constructor() {
    super("WRONG_PIN: that PIN does not unlock the keys on this device");
    this.name = "WrongPinError";
  }
}

const ITERATIONS = 600_000; // OWASP 2023 for PBKDF2-HMAC-SHA256

export async function lock(secret: DeviceSecret, method: UnlockMethod): Promise<LockedKeys> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pinKey(method.pin, salt, ITERATIONS);
  const plaintext = new TextEncoder().encode(
    JSON.stringify(secret.kind === "device-key" ? { kind: secret.kind, secretKey: secret.near.secretKey } : secret),
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return {
    v: 1,
    method: "pin",
    iterations: ITERATIONS,
    salt: base64.encode(salt),
    iv: base64.encode(iv),
    ciphertext: base64.encode(ciphertext),
  };
}

export async function unlock(locked: LockedKeys, method: UnlockMethod): Promise<DeviceKeys> {
  const key = await pinKey(method.pin, base64.decode(locked.salt), locked.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(base64.decode(locked.iv)) },
      key,
      bytes(base64.decode(locked.ciphertext)),
    );
  } catch {
    // AES-GCM's tag check cannot tell a wrong PIN from a damaged blob; either way nothing is unlocked.
    throw new WrongPinError();
  }
  const secret = JSON.parse(new TextDecoder().decode(plaintext)) as
    | { kind: "device-key"; secretKey: string }
    | { kind: "recovery-phrase"; phrase: string };
  if (secret.kind === "recovery-phrase") return keysFromRecoveryPhrase(secret.phrase);
  return { near: nearKeyPair(base58.decode(secret.secretKey.slice("ed25519:".length)).slice(0, 32)) };
}

async function pinKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// WebCrypto's types want an ArrayBuffer-backed view.
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view);
}
