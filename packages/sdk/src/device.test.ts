import { describe, expect, test } from "vitest";
import { SatsJarRefusal } from "./api.ts";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, memoryStorage, testNetwork } from "./test-network.ts";

const config = (storage = memoryStorage()) => ({ contract: CONTRACT, backendUrl: BACKEND, storage });

describe("device setup and unlock", () => {
  test("a device set up with a PIN stays locked after a reload and unlocks with that PIN", async () => {
    const net = testNetwork({});
    const storage = memoryStorage();
    const first = createApp(config(storage), net.fetch);
    expect(await first.device.state()).toBe("new");

    await first.device.setUp({ pin: "482913" });
    expect(await first.device.state()).toBe("unlocked");

    const reloaded = createApp(config(storage), net.fetch);
    expect(await reloaded.device.state()).toBe("locked");
    await reloaded.device.unlock({ pin: "482913" });
    expect(await reloaded.device.state()).toBe("unlocked");
    reloaded.device.lock();
    expect(await reloaded.device.state()).toBe("locked");
  });

  test("a wrong PIN is refused as WRONG_PIN with a readable message", async () => {
    const net = testNetwork({});
    const storage = memoryStorage();
    await createApp(config(storage), net.fetch).device.setUp({ pin: "482913" });

    const app = createApp(config(storage), net.fetch);
    const refusal = await app.device.unlock({ pin: "000000" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SatsJarRefusal);
    expect(refusal).toMatchObject({ code: "WRONG_PIN", message: expect.stringMatching(/PIN/) });
    expect(await app.device.state()).toBe("locked");
  });

  test("setting up twice is refused so the device's keys are never replaced", async () => {
    const net = testNetwork({});
    const app = createApp(config(), net.fetch);
    await app.device.setUp({ pin: "482913" });
    await expect(app.device.setUp({ pin: "111111" })).rejects.toMatchObject({ code: "ALREADY_SET_UP" });
  });

  test("damaged stored keys read as UNAVAILABLE, never the raw error", async () => {
    const storage = memoryStorage();
    const net = testNetwork({});
    await createApp(config(storage), net.fetch).device.setUp({ pin: "482913" });
    const record = JSON.parse((await storage.get("sats-jar:device")) ?? "{}") as { locked: Record<string, unknown> };
    await storage.set("sats-jar:device", JSON.stringify({ ...record, locked: { ...record.locked, salt: "%%% not base64 %%%" } }));

    const refusal = await createApp(config(storage), net.fetch).device.unlock({ pin: "482913" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SatsJarRefusal);
    expect(refusal).toMatchObject({ code: "UNAVAILABLE" });
  });

  test("unlocking a device with no keys is refused as NO_DEVICE", async () => {
    const app = createApp(config(), testNetwork({}).fetch);
    await expect(app.device.unlock({ pin: "482913" })).rejects.toMatchObject({ code: "NO_DEVICE" });
  });
});

describe("acting without keys", () => {
  test("joining or creating on a device with no keys is refused as NO_DEVICE, and nothing is sent", async () => {
    const net = testNetwork({});
    const app = createApp(config(), net.fetch);
    await expect(app.invites.join("any-token")).rejects.toMatchObject({ code: "NO_DEVICE" });
    await expect(
      app.jars.create({ draftId: "d", childAddress: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", cap: 20_000, period: 2_592_000, unlockAt: 2_208_988_800 }),
    ).rejects.toMatchObject({ code: "NO_DEVICE" });
    expect(net.accounts.size).toBe(0);
    expect(net.sent).toHaveLength(0);
  });
});
