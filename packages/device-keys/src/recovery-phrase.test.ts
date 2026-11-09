import { parseSeedPhrase } from "near-api-js/seed-phrase";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { InvalidRecoveryPhraseError, createRecoveryPhrase, keysFromRecoveryPhrase } from "./index.ts";

const ABANDON_ABOUT =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// The 12-word English mnemonics of trezor/python-mnemonic vectors.json (the BIP-39 reference vectors).
const BIP39_TWELVE_WORD_VECTORS = [
  ABANDON_ABOUT,
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
  "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
  "cat swing flag economy stadium alone churn speed unique patch report train",
  "scheme spot photo card baby mountain device kick cradle pact join borrow",
  "vessel ladder alter error federal sibling chat ability sun glass valve picture",
];

describe("recovery phrase", () => {
  it("derives the child's NEAR key on the standard NEAR path", () => {
    // Oracle: near-api-js 7.4.0 parseSeedPhrase (near-seed-phrase, m/44'/397'/0').
    const expected = parseSeedPhrase(ABANDON_ABOUT);
    const keys = keysFromRecoveryPhrase(ABANDON_ABOUT);
    expect(keys.near.publicKey).toBe("ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25");
    expect(keys.near.publicKey).toBe(expected.getPublicKey().toString());
  });

  it.each(BIP39_TWELVE_WORD_VECTORS)("gives the same NEAR key pair as near-api-js for %s", (phrase) => {
    const expected = parseSeedPhrase(phrase);
    const keys = keysFromRecoveryPhrase(phrase);
    expect(keys.near.publicKey).toBe(expected.getPublicKey().toString());
    expect(keys.near.secretKey).toBe(expected.toString());
  });

  // Oracle: Bitcoin Core v30.2 on regtest. Root tprv from the BIP-39 seed (empty passphrase), computed with
  // Python stdlib (pbkdf2_hmac sha512 "mnemonic" 2048, then HMAC-SHA512 key "Bitcoin seed"), then
  //   bitcoin-cli -regtest deriveaddresses "wpkh(<tprv>/84h/1h/0h/0/0)#<checksum>"
  // Regtest and testnet P2WPKH share the witness program; only the HRP differs.
  it.each([
    [ABANDON_ABOUT, "bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk"],
    [BIP39_TWELVE_WORD_VECTORS[1]!, "bcrt1qjgx204hxfwuse548jc34fjzg6ffq8pvrz8x53u"],
  ])("derives the child's Bitcoin key at BIP-84 testnet m/84'/1'/0'/0/0 for %s", (phrase, coreAddress) => {
    const bitcoin = keysFromRecoveryPhrase(phrase).bitcoin;
    if (!bitcoin) throw new Error("the child's keys must include a Bitcoin key");
    const decoded = bech32.decode(coreAddress as `${string}1${string}`);
    const witnessProgram = bech32.fromWords(decoded.words.slice(1));
    expect(bytesToHex(ripemd160(sha256(bitcoin.publicKey)))).toBe(bytesToHex(witnessProgram));
    expect(bytesToHex(secp256k1.getPublicKey(bitcoin.privateKey, true))).toBe(bytesToHex(bitcoin.publicKey));
  });

  // Built from vector phrases: BIP-39's checksum rule rejects each one.
  it.each([
    ["a wrong checksum word", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"],
    ["eleven words", "legal winner thank year wave sausage worth useful legal winner thank"],
    ["a word not in the list", "legal winner thank year wave sausage worth useful legal winner thank yelow"],
  ])("refuses a recovery phrase with %s", (_, phrase) => {
    expect(() => keysFromRecoveryPhrase(phrase)).toThrow(InvalidRecoveryPhraseError);
  });

  it("makes a fresh 12-word BIP-39 recovery phrase each time", () => {
    const phrase = createRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateMnemonic(phrase, wordlist)).toBe(true);
    expect(keysFromRecoveryPhrase(phrase).bitcoin).toBeDefined();
    expect(createRecoveryPhrase()).not.toBe(phrase);
  });
});
