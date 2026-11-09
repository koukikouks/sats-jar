import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceKey, createRecoveryPhrase, keysFromRecoveryPhrase, lock, unlock } from "./index.ts";

// No server stores any key or blob: every flow runs with the network cut off.
describe("device keys stay on the device", () => {
  beforeEach(() => {
    const cutOff = () => {
      throw new Error("device keys must not touch the network");
    };
    vi.stubGlobal("fetch", cutOff);
    vi.stubGlobal("XMLHttpRequest", cutOff);
    vi.stubGlobal("WebSocket", cutOff);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("makes, locks and unlocks keys without the network", async () => {
    const phrase = createRecoveryPhrase();
    const child = await lock({ kind: "recovery-phrase", phrase }, { kind: "pin", pin: "1234" });
    expect(await unlock(child, { kind: "pin", pin: "1234" })).toEqual(keysFromRecoveryPhrase(phrase));
    const near = createDeviceKey();
    const adult = await lock({ kind: "device-key", near }, { kind: "pin", pin: "1234" });
    expect(await unlock(adult, { kind: "pin", pin: "1234" })).toEqual({ near });
  });
});
