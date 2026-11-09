import { describe, expect, it } from "vitest";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { base64 } from "@scure/base";
import { WrongPinError, createDeviceKey, keysFromRecoveryPhrase, lock, unlock } from "./index.ts";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("PIN lock", () => {
  it("unlocks an adult's device key with the same PIN", async () => {
    const near = createDeviceKey();
    const locked = await lock({ kind: "device-key", near }, { kind: "pin", pin: "4821" });
    expect(await unlock(locked, { kind: "pin", pin: "4821" })).toEqual({ near });
  });

  it("unlocks a child's recovery phrase with the same PIN and gives back both keys", async () => {
    const locked = await lock({ kind: "recovery-phrase", phrase: PHRASE }, { kind: "pin", pin: "0007" });
    expect(await unlock(locked, { kind: "pin", pin: "0007" })).toEqual(keysFromRecoveryPhrase(PHRASE));
  });

  it("refuses a wrong PIN cleanly", async () => {
    const locked = await lock({ kind: "recovery-phrase", phrase: PHRASE }, { kind: "pin", pin: "0007" });
    await expect(unlock(locked, { kind: "pin", pin: "0008" })).rejects.toThrow(WrongPinError);
  });

  it("refuses a tampered blob the same way", async () => {
    const locked = await lock({ kind: "device-key", near: createDeviceKey() }, { kind: "pin", pin: "4821" });
    const ciphertext = base64.decode(locked.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = { ...locked, ciphertext: base64.encode(ciphertext) };
    await expect(unlock(tampered, { kind: "pin", pin: "4821" })).rejects.toThrow(WrongPinError);
  });

  // Pins the blob layout: Node's OpenSSL reads it as PBKDF2-HMAC-SHA256 → AES-256-GCM (16-byte tag at the end).
  it("stores only PBKDF2 → AES-GCM ciphertext, fresh salt and IV each time", async () => {
    const secret = { kind: "recovery-phrase", phrase: PHRASE } as const;
    const locked = await lock(secret, { kind: "pin", pin: "0007" });
    expect(locked).toMatchObject({ v: 1, method: "pin", iterations: 600_000 });

    const key = pbkdf2Sync("0007", base64.decode(locked.salt), locked.iterations, 32, "sha256");
    const sealed = base64.decode(locked.ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, base64.decode(locked.iv));
    decipher.setAuthTag(sealed.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString();
    expect(JSON.parse(plaintext)).toEqual(secret);

    expect(JSON.stringify(locked)).not.toContain("legal");
    const again = await lock(secret, { kind: "pin", pin: "0007" });
    expect(again.salt).not.toBe(locked.salt);
    expect(again.iv).not.toBe(locked.iv);
    expect(again.ciphertext).not.toBe(locked.ciphertext);
  });

  it("never stores the adult's secret key in the clear", async () => {
    const near = createDeviceKey();
    const locked = await lock({ kind: "device-key", near }, { kind: "pin", pin: "4821" });
    const blob = JSON.stringify(locked);
    expect(blob).not.toContain(near.secretKey.slice("ed25519:".length));
    expect(blob).not.toContain(near.publicKey.slice("ed25519:".length));
  });
});
