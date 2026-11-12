/** @vitest-environment jsdom */
import { SatsJarRefusal, type JarStatus } from "@sats-jar/sdk";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import live from "../test/fixtures/dev-jar-1.json";
import { renderApp } from "../test/render.tsx";
import type { StandInSdk } from "../test/stand-in.ts";

const draft = { draftId: "d1", nickname: "Sunny's jar", inviteTokens: ["tok-a", "tok-b", "tok-c"], jarId: null };

function withDraft(sdk: StandInSdk, joined: boolean[]) {
  sdk.invites.mine.mockResolvedValue([draft]);
  sdk.invites.progress.mockResolvedValue({ nickname: "Sunny's jar", joined });
}

afterEach(() => vi.restoreAllMocks());

describe("starting a jar", () => {
  it("asks for invite links with the nickname and the number of guardians, then opens the draft", async () => {
    const { user, sdk } = renderApp("/new", (sdk) => {
      sdk.invites.start.mockResolvedValue(draft);
      withDraft(sdk, [false, false, false]);
    });
    expect(await screen.findByText("Anyone can see this name, so use a nickname, not the child's full name.")).toBeTruthy();
    await user.type(screen.getByLabelText("Jar nickname"), "Sunny's jar");
    await user.click(screen.getByLabelText("3"));
    await user.click(screen.getByRole("button", { name: "Make invite links" }));
    expect(sdk.invites.start).toHaveBeenCalledWith({ nickname: "Sunny's jar", guardians: 3 });
    expect(await screen.findByRole("heading", { name: "Sunny's jar: invite the guardians" })).toBeTruthy();
  });
});

describe("inviting the guardians", () => {
  it("shows one link per guardian with who has joined, and waits for 2", async () => {
    renderApp("/draft/d1", (sdk) => withDraft(sdk, [true, false, false]));
    const first = (await screen.findByText("Guardian 1")).closest("li")!;
    expect(within(first).getByText(`${window.location.origin}/join/tok-a`)).toBeTruthy();
    expect(await within(first).findByText("Joined")).toBeTruthy();
    expect(within(screen.getByText("Guardian 2").closest("li")!).getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("You can create the jar once 2 guardians have joined.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create the jar" })).toBeNull();
  });

  it("lets the giver use the first open link on this device", async () => {
    const { user, sdk } = renderApp("/draft/d1", (sdk) => {
      withDraft(sdk, [true, false, false]);
      sdk.invites.join.mockResolvedValue(undefined);
    });
    await user.click(await screen.findByRole("button", { name: "Use a link myself" }));
    expect(sdk.invites.join).toHaveBeenCalledWith("tok-b");
  });

  it("says a draft made on another device is not here", async () => {
    renderApp("/draft/elsewhere", (sdk) => withDraft(sdk, [false, false, false]));
    expect(await screen.findByText("This jar's invite links are no longer pending.")).toBeTruthy();
  });
});

describe("creating the jar", () => {
  it("sends a demo-timing jar the way the SDK's testnet check does, then opens it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { user, sdk } = renderApp("/draft/d1", (sdk) => {
      withDraft(sdk, [true, true, false]);
      sdk.jars.create.mockResolvedValue({ jarId: "7", address: "tb1qjar", qrPayload: "bitcoin:tb1qjar" });
      sdk.jars.status.mockRejectedValue(new SatsJarRefusal("UNAVAILABLE", "We could not reach the network just now. Try again shortly."));
    });
    const address = await screen.findByLabelText("Where should the allowance go?");
    expect(
      screen.getByText(
        "Paste the child's Bitcoin address. In a Bitcoin wallet a parent controls, tap Receive and copy the address it shows. Don't use an exchange's deposit address. Before handover the jar can only ever pay this address.",
      ),
    ).toBeTruthy();
    await user.type(address, "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl");
    await user.type(screen.getByLabelText("Allowance per period (sats)"), "2500");
    await user.click(screen.getByLabelText("Demo timing: every 10 minutes"));
    expect(screen.getByText("Shortens every wait so a jar's whole life fits in an afternoon. The jar shows a Demo timing badge.")).toBeTruthy();
    await user.type(screen.getByLabelText("Unlocks in (minutes)"), "3");
    expect(screen.getByText("Only the 2 guardians who have joined will be on the jar.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create the jar" }));
    expect(sdk.jars.create).toHaveBeenCalledWith({
      draftId: "d1",
      childAddress: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl",
      cap: 2_500,
      period: 600,
      unlockAt: 1_800_000_180,
    });
    expect(await screen.findByText("We could not reach the network just now. Try again shortly.")).toBeTruthy();
    expect(sdk.jars.status).toHaveBeenCalledWith("7");
  });

  it("sends a full-timing jar unlocking at midnight UTC of the chosen day", async () => {
    const { user, sdk } = renderApp("/draft/d1", (sdk) => {
      withDraft(sdk, [true, true, true]);
      sdk.jars.create.mockResolvedValue({ jarId: "7", address: "tb1qjar", qrPayload: "bitcoin:tb1qjar" });
      sdk.jars.status.mockReturnValue(new Promise(() => {}));
    });
    await user.type(await screen.findByLabelText("Where should the allowance go?"), "tb1qchild");
    await user.type(screen.getByLabelText("Allowance per period (sats)"), "20000");
    expect(screen.getByText("The earliest the jar can be handed over to the child. Most families choose the 18th birthday.")).toBeTruthy();
    await user.type(screen.getByLabelText("Unlock date"), "2040-05-01");
    expect(screen.queryByText(/guardians who have joined will be on the jar/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create the jar" }));
    expect(sdk.jars.create).toHaveBeenCalledWith({
      draftId: "d1",
      childAddress: "tb1qchild",
      cap: 20_000,
      period: 2_592_000,
      unlockAt: Date.UTC(2040, 4, 1) / 1000,
    });
  });

  it("shows a full-timing jar's unlock day as the day the giver chose, whatever the time zone", async () => {
    renderApp("/jar/7", (sdk) => {
      sdk.jars.status.mockResolvedValue({ ...(live.status as unknown as JarStatus), jarId: "7", roles: ["giver"], demoTiming: false, unlockAt: Date.UTC(2040, 4, 1) / 1000 });
      sdk.jars.topUps.mockResolvedValue([]);
      sdk.jars.allowances.mockResolvedValue([]);
    });
    expect(await screen.findByText("The jar unlocks on 1 May 2040. From then on, the child can take it over.")).toBeTruthy();
  });

  it("shows a create refusal next to the button", async () => {
    const { user } = renderApp("/draft/d1", (sdk) => {
      withDraft(sdk, [true, true]);
      sdk.jars.create.mockRejectedValue(
        new SatsJarRefusal(
          "CAP_TOO_SMALL",
          "The cap is too small to pay its own Bitcoin fees. Choose at least 1,630 sats.",
          "https://testnet.nearblocks.io/txns/R1",
        ),
      );
    });
    await user.type(await screen.findByLabelText("Where should the allowance go?"), "tb1qchild");
    await user.type(screen.getByLabelText("Allowance per period (sats)"), "1000");
    await user.type(screen.getByLabelText("Unlock date"), "2040-05-01");
    await user.click(screen.getByRole("button", { name: "Create the jar" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The cap is too small to pay its own Bitcoin fees. Choose at least 1,630 sats. Check it yourself ↗");
    expect(within(alert).getByRole("link", { name: "Check it yourself ↗" }).getAttribute("href")).toBe("https://testnet.nearblocks.io/txns/R1");
  });
});

describe("joining as a guardian", () => {
  it("says what a guardian does, then joins from this device", async () => {
    const { user, sdk } = renderApp("/join/tok-a", (sdk) => {
      sdk.invites.preview.mockResolvedValue({ nickname: "Sunny's jar", joined: false });
      sdk.invites.join.mockResolvedValue(undefined);
    });
    expect(await screen.findByRole("heading", { name: "Be a guardian of Sunny's jar" })).toBeTruthy();
    expect(screen.getByText(/No guardian can send the jar's Bitcoin anywhere else\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Join as a guardian" }));
    expect(sdk.invites.preview).toHaveBeenCalledWith("tok-a");
    expect(sdk.invites.join).toHaveBeenCalledWith("tok-a");
    expect(await screen.findByText("You're a guardian of Sunny's jar. The jar appears under Your jars once it's created.")).toBeTruthy();
  });

  it("asks a new device for a PIN before joining", async () => {
    renderApp("/join/tok-a", (sdk) => {
      sdk.device.state.mockResolvedValue("new");
      sdk.invites.preview.mockResolvedValue({ nickname: "Sunny's jar", joined: false });
    });
    expect(await screen.findByRole("heading", { name: "Set up Sats Jar on this device" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Be a guardian of Sunny's jar" })).toBeTruthy();
  });

  it("tells a device that already joined to pass the link on, and offers no second join", async () => {
    const { user } = renderApp("/join/tok-b", (sdk) => {
      sdk.invites.preview.mockResolvedValue({ nickname: "Sunny's jar", joined: false });
      sdk.invites.join.mockRejectedValue(new SatsJarRefusal("ALREADY_GUARDIAN", "You are already a guardian of this jar."));
    });
    await user.click(await screen.findByRole("button", { name: "Join as a guardian" }));
    expect(
      await screen.findByText("This device has already joined this jar as a guardian. Send this link to the other guardian to open on their own phone."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join as a guardian" })).toBeNull();
  });

  it("says a used link is used, and offers no join", async () => {
    renderApp("/join/tok-a", (sdk) => sdk.invites.preview.mockResolvedValue({ nickname: "Sunny's jar", joined: true }));
    expect(await screen.findByText("Someone has already joined with this invite link. Ask for a new link.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join as a guardian" })).toBeNull();
  });

  it("shows the SDK's sentence for an unknown link", async () => {
    renderApp("/join/nope", (sdk) =>
      sdk.invites.preview.mockRejectedValue(
        new SatsJarRefusal("INVITE_NOT_FOUND", "This invite link is not for a jar being set up. Ask for a new link."),
      ),
    );
    expect(await screen.findByText("This invite link is not for a jar being set up. Ask for a new link.")).toBeTruthy();
  });
});
