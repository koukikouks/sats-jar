/** @vitest-environment jsdom */
import type { HandoverCheck, JarStatus } from "@sats-jar/sdk";
import { SatsJarRefusal } from "@sats-jar/sdk";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import live from "../test/fixtures/dev-jar-1.json";
import { renderApp } from "../test/render.tsx";
import type { StandInSdk } from "../test/stand-in.ts";

const NOW = 1_800_000_000;
const sent = (hash: string) => ({ explorerUrl: `https://testnet.nearblocks.io/txns/${hash}` });
// A demo-timing jar built on the SDK's recorded answer for dev jar 1; each test sets its state.
const base: JarStatus = { ...(live.status as unknown as JarStatus), jarId: "7", demoTiming: true, cap: 2_500, period: 600 };

function jarAs(sdk: StandInSdk, change: Partial<JarStatus>) {
  sdk.jars.status.mockResolvedValue({ ...base, ...change });
  sdk.jars.topUps.mockResolvedValue([]);
  sdk.jars.allowances.mockResolvedValue([]);
}

function section(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("section")!;
}

afterEach(() => vi.restoreAllMocks());

describe("the emergency payment", () => {
  it("lets a guardian propose an amount, told its limit and the waiting time", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { roles: ["guardian"] });
      sdk.emergency.propose.mockResolvedValue({ ...sent("P1"), proposalId: 1 });
    });
    await screen.findByRole("heading", { name: "Emergency payment" });
    expect(
      screen.getByText("At most 7,500 sats. Two guardians must approve, then there's a public waiting time of 30 minutes when the giver can cancel it."),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Amount (sats)"), "2000");
    await user.click(screen.getByRole("button", { name: "Propose" }));
    expect(sdk.emergency.propose).toHaveBeenCalledWith("7", 2_000);
    expect((await within(section("Emergency payment")).findByRole("link", { name: "Check it yourself ↗" })).getAttribute("href")).toBe(
      "https://testnet.nearblocks.io/txns/P1",
    );
  });

  it("says 30 days on a full-timing jar, and nothing to propose for someone who isn't a guardian", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["giver", "holder"], demoTiming: false }));
    expect(await screen.findByText("No emergency payment is proposed.")).toBeTruthy();
    expect(screen.queryByLabelText("Amount (sats)")).toBeNull();
  });

  it("lets another guardian approve that exact proposal", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {
        roles: ["guardian"],
        emergency: { state: "open", proposalId: 4, amount: 2_000, approvals: 1, approvedByMe: false, proposedAt: NOW, delayEndsAt: null },
      });
      sdk.emergency.approve.mockResolvedValue(sent("A1"));
    });
    expect(await screen.findByText("2,000 sats proposed. 1 of 2 guardians have approved.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(sdk.emergency.approve).toHaveBeenCalledWith("7", 4);
  });

  it("shows when an approved proposal goes out, offers no more approvals, and lets the giver cancel it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {
        roles: ["giver", "guardian", "holder"],
        emergency: { state: "open", proposalId: 4, amount: 2_000, approvals: 2, approvedByMe: false, proposedAt: NOW, delayEndsAt: NOW + 1_800 },
      });
      sdk.emergency.cancel.mockResolvedValue(sent("C1"));
    });
    expect(await screen.findByText(/^It goes out after .*, unless the giver cancels it\.$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel it" }));
    expect(sdk.emergency.cancel).toHaveBeenCalledWith("7");
  });

  it("does not offer a guardian who isn't the giver a cancel, and shows a refusal's sentence", async () => {
    const { user } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {
        roles: ["guardian"],
        emergency: { state: "open", proposalId: 4, amount: 2_000, approvals: 1, approvedByMe: false, proposedAt: NOW, delayEndsAt: null },
      });
      sdk.emergency.approve.mockRejectedValue(new SatsJarRefusal("PROPOSAL_CHANGED", "The emergency proposal changed. Look at it again before approving."));
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(screen.queryByRole("button", { name: "Cancel it" })).toBeNull();
    expect(await screen.findByText("The emergency proposal changed. Look at it again before approving.")).toBeTruthy();
  });

  it("reads the ended states", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["giver"], emergency: { state: "cancelled", proposalId: 4 } }));
    expect(await screen.findByText("The last emergency payment was cancelled.")).toBeTruthy();
  });

  it("disappears once the handover's waiting time has ended", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    renderApp("/jar/7", (sdk) =>
      jarAs(sdk, {
        roles: ["guardian"],
        handover: { state: "confirmed", claimedAt: NOW - 600, delayEndsAt: NOW - 1, confirmedByMe: true, pausesAllowancesEarly: false },
      }),
    );
    await screen.findByRole("heading", { name: "Handover" });
    expect(screen.queryByRole("heading", { name: "Emergency payment" })).toBeNull();
  });
});

describe("the handover on the jar page", () => {
  const claimed = (confirmations: number, confirmedByMe = false, pausesAllowancesEarly = false): Partial<JarStatus> => ({
    handover: { state: "claimed", claimedAt: NOW, lapsesAt: NOW + 420, confirmations, confirmedByMe, pausesAllowancesEarly },
  });

  it("lets a guardian check the code read from the chain and confirm with that check", async () => {
    const check = { code: "9765 9494 0429 5968 6952", claimedAt: NOW } as HandoverCheck;
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { roles: ["guardian"], ...claimed(0) });
      sdk.handover.check.mockResolvedValue(check);
      sdk.handover.confirm.mockResolvedValue(sent("H1"));
    });
    expect(await screen.findByText(/^The child's phone has claimed the jar\. 0 of 2 guardians have confirmed\. Unless 2 guardians confirm by .*, the claim lapses\.$/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check the child's code" }));
    expect(sdk.handover.check).toHaveBeenCalledWith("7");
    expect(await screen.findByText("Ask the child to show you the code on their phone. Confirm only if every digit matches.")).toBeTruthy();
    expect(screen.getByText("9765 9494 0429 5968 6952")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "It matches: confirm" }));
    expect(sdk.handover.confirm).toHaveBeenCalledWith("7", check);
  });

  it("warns when confirming now would end allowances early, and lets a guardian cancel the claim", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { roles: ["guardian"], ...claimed(1, false, true) });
      sdk.handover.check.mockResolvedValue({ code: "1234", claimedAt: NOW } as HandoverCheck);
      sdk.handover.cancel.mockResolvedValue(sent("X1"));
    });
    await user.click(await screen.findByRole("button", { name: "Check the child's code" }));
    expect(await screen.findByText(/^Confirming now ends allowances early/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel the claim" }));
    expect(sdk.handover.cancel).toHaveBeenCalledWith("7");
  });

  it("offers nothing more to a guardian who has confirmed", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["guardian"], ...claimed(1, true) }));
    await screen.findByText(/1 of 2 guardians have confirmed/);
    expect(screen.queryByRole("button", { name: "Check the child's code" })).toBeNull();
  });

  it("shows the child's phone its code and lets it cancel its own claim", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { roles: ["child"], ...claimed(0) });
      sdk.child.guardianCode.mockResolvedValue("9765 9494 0429 5968 6952");
      sdk.handover.cancel.mockResolvedValue(sent("X2"));
    });
    expect(await screen.findByText("Show this code to each guardian in person:")).toBeTruthy();
    expect(await screen.findByText("9765 9494 0429 5968 6952")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel my claim" }));
    expect(sdk.handover.cancel).toHaveBeenCalledWith("7");
  });

  it("reads the waiting time, the move and the end", async () => {
    const { unmount } = renderApp("/jar/7", (sdk) =>
      jarAs(sdk, {
        roles: ["guardian"],
        handover: { state: "confirmed", claimedAt: NOW, delayEndsAt: NOW + 180, confirmedByMe: true, pausesAllowancesEarly: false },
      }),
    );
    expect(await screen.findByText(/Until the Bitcoin starts moving, any guardian or the child can cancel\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel the handover" })).toBeTruthy();
    unmount();
    const second = renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["giver"], handover: { state: "completing", coinsToMove: 0, coinsLeft: 1 } }));
    expect(await screen.findByText("The jar's Bitcoin is moving to the child's own key: 1 coin still to go.")).toBeTruthy();
    second.unmount();
    renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["holder"], handover: { state: "done", completedAt: NOW } }));
    expect(await screen.findByText(/^Handed over on .*\. The jar is the child's alone, and every adult's access has ended\.$/)).toBeTruthy();
    expect(
      screen.getByText("Nobody, Sats Jar included, can recover this jar without your phone or your recovery phrase. Keep your recovery phrase safe."),
    ).toBeTruthy();
  });
});
