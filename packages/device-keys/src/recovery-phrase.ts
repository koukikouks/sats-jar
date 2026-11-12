import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { slip10Ed25519 } from "./slip10.ts";

export type NearKeyPair = { publicKey: string; secretKey: string };
export type BitcoinKey = { privateKey: Uint8Array; publicKey: Uint8Array };
export type DeviceKeys = { near: NearKeyPair; bitcoin?: BitcoinKey };

const NEAR_PATH = [44, 397, 0];
const BITCOIN_PATH = "m/84'/1'/0'/0/0"; // BIP-84, testnet coin type

export class InvalidRecoveryPhraseError extends Error {
  readonly code = "INVALID_RECOVERY_PHRASE";
  constructor() {
    super("INVALID_RECOVERY_PHRASE: these are not the 12 words of a recovery phrase");
    this.name = "InvalidRecoveryPhraseError";
  }
}

// 128 bits of entropy from crypto.getRandomValues give 12 words.
export function createRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function keysFromRecoveryPhrase(phrase: string): DeviceKeys {
  if (phrase.split(" ").length !== 12 || !validateMnemonic(phrase, wordlist)) {
    throw new InvalidRecoveryPhraseError();
  }
  const seed = mnemonicToSeedSync(phrase);
  return {
    near: nearKeyPair(slip10Ed25519(seed, NEAR_PATH)),
    bitcoin: bitcoinKeyAt(seed, BITCOIN_PATH),
  };
}

// NEAR's string format: the secret is the 32-byte seed followed by the 32-byte public key.
export function nearKeyPair(secret: Uint8Array): NearKeyPair {
  const publicKey = ed25519.getPublicKey(secret);
  const full = new Uint8Array(64);
  full.set(secret);
  full.set(publicKey, 32);
  return {
    publicKey: `ed25519:${base58.encode(publicKey)}`,
    secretKey: `ed25519:${base58.encode(full)}`,
  };
}

// Internal: takes any path so the published (mainnet) BIP-84 vectors can be checked.
export function bitcoinKeyAt(seed: Uint8Array, path: string): BitcoinKey {
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey || !node.publicKey) throw new Error("BIP-32 derivation gave no key");
  return { privateKey: node.privateKey, publicKey: node.publicKey };
}
