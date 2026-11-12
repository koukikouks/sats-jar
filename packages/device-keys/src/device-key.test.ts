import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { createDeviceKey } from "./index.ts";

describe("adult device key", () => {
  it("is a fresh NEAR ed25519 key pair that near-api-js reads back", () => {
    const key = createDeviceKey();
    // Oracle: near-api-js derives the public key from our secret key string.
    expect(KeyPair.fromString(key.secretKey as `ed25519:${string}`).getPublicKey().toString()).toBe(key.publicKey);
    expect(key.publicKey).toMatch(/^ed25519:/);
    expect(createDeviceKey().secretKey).not.toBe(key.secretKey);
  });
});
