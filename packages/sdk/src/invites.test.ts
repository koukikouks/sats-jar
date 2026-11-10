import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, memoryStorage, testNetwork, type TestNetwork } from "./test-network.ts";

async function device(net: TestNetwork, pin = "482913") {
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
  await app.device.setUp({ pin });
  return app;
}

describe("guardian invites", () => {
  test("a giver's invite links are kept on the device, and guardians join from them", async () => {
    const net = testNetwork({});
    const giver = await device(net);
    const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 2 });
    expect(draft).toMatchObject({ nickname: "Sunny's jar", jarId: null });
    expect(draft.inviteTokens).toHaveLength(2);
    expect(await giver.invites.mine()).toEqual([draft]);
    expect(await giver.invites.progress(draft.draftId)).toEqual({ nickname: "Sunny's jar", joined: [false, false] });

    const guardian = await device(net);
    expect(await guardian.invites.preview(draft.inviteTokens[1] ?? "")).toEqual({ nickname: "Sunny's jar", joined: false });
    await guardian.invites.join(draft.inviteTokens[1] ?? "");

    expect(await giver.invites.progress(draft.draftId)).toEqual({ nickname: "Sunny's jar", joined: [false, true] });
    expect(net.accounts.size).toBe(1);
  });

  test("a used link and a second link for the same person are refused with readable reasons", async () => {
    const net = testNetwork({});
    const giver = await device(net);
    const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 3 });
    const [first = "", second = ""] = draft.inviteTokens;
    const guardian = await device(net);
    await guardian.invites.join(first);

    await expect((await device(net)).invites.join(first)).rejects.toMatchObject({
      code: "INVITE_USED",
      message: expect.stringMatching(/already joined/),
    });
    await expect(guardian.invites.join(second)).rejects.toMatchObject({ code: "ALREADY_GUARDIAN" });
  });

  test("a giver may join one of their own links", async () => {
    const net = testNetwork({});
    const giver = await device(net);
    const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 2 });
    await giver.invites.join(draft.inviteTokens[0] ?? "");
    expect((await giver.invites.progress(draft.draftId)).joined).toEqual([true, false]);
  });

  test("an unknown link is refused as INVITE_NOT_FOUND, and joining needs an unlocked device", async () => {
    const net = testNetwork({});
    const giver = await device(net);
    const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 2 });
    await expect(giver.invites.preview("not-a-token")).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });

    giver.device.lock();
    await expect(giver.invites.join(draft.inviteTokens[0] ?? "")).rejects.toMatchObject({ code: "LOCKED" });
    expect(net.accounts.size).toBe(0);
  });

  test("a backend failure comes back as UNAVAILABLE, never its raw text", async () => {
    const net = testNetwork({});
    const giver = await device(net);
    const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 2 });
    net.breakBackend(1);
    const refusal = await (await device(net)).invites.join(draft.inviteTokens[0] ?? "").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "UNAVAILABLE" });
    expect(String((refusal as Error).message)).not.toMatch(/hiccup|went wrong/);
  });
});
