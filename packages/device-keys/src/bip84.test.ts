import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";
import { bitcoinKeyAt } from "./recovery-phrase.ts";

// BIP-84 test vectors (bitcoin/bips bip-0084.mediawiki); BIP-84 publishes mainnet only.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTORS: [string, string, string][] = [
  ["m/84'/0'/0'/0/0", "KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d", "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c"],
  ["m/84'/0'/0'/0/1", "Kxpf5b8p3qX56DKEe5NqWbNUP9MnqoRFzZwHRtsFqhzuvUJsYZCy", "03e775fd51f0dfb8cd865d9ff1cca2a158cf651fe997fdc9fee9c1d3b5e995ea77"],
  ["m/84'/0'/0'/1/0", "KxuoxufJL5csa1Wieb2kp29VNdn92Us8CoaUG3aGtPtcF3AzeXvF", "03025324888e429ab8e3dbaf1f7802648b9cd01e9b418485c5fa4c1b9b5700e1a6"],
];

// WIF: version 0x80, 32-byte key, 0x01 for a compressed public key.
function wifPrivateKey(wif: string): string {
  const payload = createBase58check(sha256).decode(wif);
  expect(payload[0]).toBe(0x80);
  expect(payload[33]).toBe(0x01);
  return bytesToHex(payload.subarray(1, 33));
}

describe("BIP-84 key derivation", () => {
  it.each(VECTORS)("matches the published vector at %s", (path, wif, pubkey) => {
    const key = bitcoinKeyAt(mnemonicToSeedSync(MNEMONIC), path);
    expect(bytesToHex(key.privateKey)).toBe(wifPrivateKey(wif));
    expect(bytesToHex(key.publicKey)).toBe(pubkey);
  });
});
