import { ed25519 } from "@noble/curves/ed25519.js";
import { type NearKeyPair, nearKeyPair } from "./recovery-phrase.ts";

// Adults get a random key with no phrase (ADR 0009).
export function createDeviceKey(): NearKeyPair {
  return nearKeyPair(ed25519.utils.randomSecretKey());
}
