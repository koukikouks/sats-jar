import { describe, expect, it } from "vitest";
import { InvalidPublicKeyError, guardianCode } from "./index.ts";

// Oracle: Python hashlib, independent of this code:
//   n = int.from_bytes(sha256(b"sats-jar guardian code v1" + base58decode(key)).digest()[:9], "big") % 10**20
//   f"{n:020d}" in groups of four
describe("guardian code", () => {
  it.each([
    ["ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25", "3754 9810 2217 9825 4110"],
    ["ed25519:5shPrRr1NRJL7aTdCMqSSKxfUHvacCTEjCkCEpd26RmJ", "6542 3197 7482 5746 3230"],
  ])("derives the code a guardian compares from the account key %s", (key, code) => {
    expect(guardianCode(key)).toBe(code);
  });

  it.each([
    ["a secp256k1 key", "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3"],
    ["a key without its curve", "6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25"],
    ["a short key", "ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZ"],
    ["a key that is not base58", "ed25519:0OIl6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25"],
  ])("refuses %s", (_, key) => {
    expect(() => guardianCode(key)).toThrow(InvalidPublicKeyError);
  });
});
