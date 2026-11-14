/** @vitest-environment jsdom */
import { SatsJarRefusal, type Allowance, type JarStatus, type TopUp } from "@sats-jar/sdk";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import live from "../test/fixtures/dev-jar-1.json";
import { renderApp } from "../test/render.tsx";
import type { StandInSdk } from "../test/stand-in.ts";

// The SDK's real answers for sats-jar-dev.testnet jar 1, recorded from testnet. Its `roles` are
// set here (synthetic): no test device has a role in that jar, and the family page needs one.
const recorded = live.status as unknown as JarStatus;
const jar1: JarStatus = { ...recorded, roles: ["giver", "holder"] };

function showing(sdk: StandInSdk, jar: JarStatus, topUps: TopUp[] = [], allowances: Allowance[] = []) {
  sdk.jars.status.mockResolvedValue(jar);
  sdk.jars.topUps.mockResolvedValue(topUps);
  sdk.jars.allowances.mockResolvedValue(allowances);
}

describe("the jar page", () => {
  it("words the exit after handover without naming the chain behind it", async () => {
    renderApp("/jar/1", (sdk) =>
      showing(sdk, { ...jar1, demoTiming: false, exit: { ...jar1.exit, opensAt: Date.UTC(2042, 4, 1) / 1000 }, handover: { state: "done", completedAt: 1_800_000_000 } }),
    );
    expect(
      await screen.findByText("If the signing network behind Sats Jar ever stops, the Bitcoin-only exit opens on 1 May 2042, and only the holder's recovery phrase can use it."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NEAR/);
  });

  it("shows a funded jar's balance, top-up address, counted top-ups and paid allowance from live data", async () => {
    const { sdk } = renderApp("/jar/1", (sdk) =>
      showing(sdk, jar1, live.topUps as TopUp[], live.allowances as Allowance[]),
    );
    expect(await screen.findByRole("heading", { name: jar1.nickname })).toBeTruthy();
    expect(sdk.jars.status).toHaveBeenCalledWith("1");
    expect(screen.getByText("1,260 sats in the jar")).toBeTruthy();
    expect(screen.getByText("You gave this jar")).toBeTruthy();
    expect(screen.getByText(jar1.address)).toBeTruthy();
    expect(screen.getByText(/It counts once Bitcoin has confirmed it 3 times/)).toBeTruthy();
    const topUps = screen.getByRole("heading", { name: "Top-ups" }).closest("section")!;
    expect(await within(topUps).findAllByText("Counted")).toHaveLength(2);
    expect(within(topUps).getAllByRole("link", { name: "Check it yourself ↗" })[0]?.getAttribute("href")).toBe(live.topUps[0]?.explorerUrl);
    const allowance = screen.getByRole("heading", { name: "Allowance" }).closest("section")!;
    expect(await within(allowance).findByText("Paid")).toBeTruthy();
    expect(within(allowance).getByText(`2,500 sats to the child, fee ${live.allowances[0]?.fee.toLocaleString("en-US")} sats from the jar`)).toBeTruthy();
    expect(within(allowance).getByText("Sats Jar sends it to the child's address on its own.")).toBeTruthy();
    expect(within(allowance).getByText(/^Next allowance: .+\.$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByText(/^If Sats Jar's signing ever stops before the handover is done, the Bitcoin-only exit opens on .+ and pays the child's address, which a parent controls\.$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the public record" }).getAttribute("href")).toBe("/proof/1");
  });

  it("reads every top-up and allowance state in plain words", async () => {
    const topUp = (status: TopUp["status"], confirmations: number | null, txid: string): TopUp => ({
      txid,
      value: 5_000,
      status,
      confirmations,
      countedAt: null,
      explorerUrl: `https://mempool.space/testnet/tx/${txid}`,
    });
    const allowance = (status: Allowance["status"], requestedAt: number): Allowance => ({
      amount: 2_500,
      fee: 141,
      status,
      requestedAt,
      explorerUrl: "https://mempool.space/testnet/tx/x",
    });
    renderApp("/jar/1", (sdk) =>
      showing(
        sdk,
        jar1,
        [topUp("on_the_way", null, "a"), topUp("confirming", 2, "b"), topUp("too_small", null, "c")],
        [allowance("signing", 1), allowance("signing_failed", 2), allowance("signed", 3), allowance("cancelled", 4)],
      ),
    );
    expect(await screen.findByText("On the way")).toBeTruthy();
    expect(screen.getByText("Confirming, 2 of 3")).toBeTruthy();
    expect(screen.getByText("Under 1,000 sats, so it doesn't count")).toBeTruthy();
    expect(screen.getByText("Being signed")).toBeTruthy();
    expect(screen.getByText("Signing again")).toBeTruthy();
    expect(screen.getByText("Sent, waiting for Bitcoin to confirm")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });

  it("shows a new demo-timing jar: badge, empty lists, no allowance clock, and the set-up link for the child", async () => {
    const fresh: JarStatus = {
      ...jar1,
      jarId: "7",
      balance: 0,
      demoTiming: true,
      availableAllowance: 0,
      nextAllowanceAt: null,
      period: 600,
      roles: ["guardian"],
      handover: { state: "none" },
    };
    renderApp("/jar/7", (sdk) => showing(sdk, fresh));
    expect(await screen.findByText("Demo timing")).toBeTruthy();
    expect(await screen.findByText("No top-ups yet. The first counted one starts the allowance.")).toBeTruthy();
    expect(screen.getByText("Up to 2,500 sats every 10 minutes.")).toBeTruthy();
    expect(screen.getByText("Starts with the first counted top-up.")).toBeTruthy();
    expect(screen.getByText(/From then on, the child can take it over\./)).toBeTruthy();
    expect(screen.getByText("When it's time, send the child this link to open on their own phone:")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/jar/7/set-up`)).toBeTruthy();
  });

  it("sends anyone without a role to the public record", async () => {
    renderApp("/jar/1", (sdk) => showing(sdk, recorded));
    expect(await screen.findByText("This page is for the jar's family. Anyone can see its public record.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the jar's public record" }).getAttribute("href")).toBe("/proof/1");
    expect(screen.queryByText(jar1.address)).toBeNull();
    expect(screen.queryByText(/your claim has lapsed/)).toBeNull();
  });

  it("tells a phone set up with a recovery phrase that its claim may have lapsed, and how to claim again", async () => {
    renderApp("/jar/1", (sdk) => {
      showing(sdk, { ...recorded, roles: [], handover: { state: "none" } });
      sdk.child.guardianCode.mockResolvedValue("4821 0937 5512 8846 1203");
    });
    expect(await screen.findByText("If you claimed this jar, your claim has lapsed or was cancelled. You can claim it again.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Claim it again" }).getAttribute("href")).toBe("/jar/1/set-up");
    expect(screen.getByRole("link", { name: "See the jar's public record" }).getAttribute("href")).toBe("/proof/1");
  });

  it("says nothing about a lapsed claim to an adult's device", async () => {
    renderApp("/jar/1", (sdk) => {
      showing(sdk, { ...recorded, roles: [], handover: { state: "none" } });
      sdk.child.guardianCode.mockRejectedValue(new SatsJarRefusal("NO_RECOVERY_PHRASE", "Only a phone set up with a recovery phrase can do that."));
    });
    expect(await screen.findByText("This page is for the jar's family. Anyone can see its public record.")).toBeTruthy();
    expect(screen.queryByText(/your claim has lapsed/)).toBeNull();
  });

  it("says nothing about a lapsed claim once a handover is done, and doesn't ask for the code", async () => {
    const { sdk } = renderApp("/jar/1", (sdk) => {
      showing(sdk, { ...recorded, roles: [], handover: { state: "done", completedAt: 1_800_000_000 } });
      sdk.child.guardianCode.mockResolvedValue("4821 0937 5512 8846 1203");
    });
    expect(await screen.findByText("This page is for the jar's family. Anyone can see its public record.")).toBeTruthy();
    expect(screen.queryByText(/your claim has lapsed/)).toBeNull();
    expect(sdk.child.guardianCode).not.toHaveBeenCalled();
  });
});

describe("the jar page tells the truth at this moment", () => {
  const NOW = 1_800_000_000;
  afterEach(() => vi.restoreAllMocks());
  const at = (change: Partial<JarStatus>, topUps: TopUp[] = []) => (sdk: StandInSdk) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    showing(sdk, { ...jar1, demoTiming: true, ...change }, topUps);
  };
  const allowanceText = () => screen.getByRole("heading", { name: "Allowance" }).closest("section")!.textContent ?? "";

  it("reads a top-up past 3 confirmations as confirmed and being counted", async () => {
    const topUp = (confirmations: number, txid: string): TopUp => ({
      txid, value: 5_000, status: "confirming", confirmations, countedAt: null, explorerUrl: `https://mempool.space/testnet/tx/${txid}`,
    });
    renderApp("/jar/1", at({}, [topUp(2, "a"), topUp(3, "b"), topUp(11, "c")]));
    expect(await screen.findByText("Confirming, 2 of 3")).toBeTruthy();
    expect(screen.getAllByText("Confirmed on Bitcoin, being counted")).toHaveLength(2);
    expect(screen.queryByText(/of 3/, { selector: "span" })?.textContent).toBe("Confirming, 2 of 3");
  });

  it("gives the next allowance's time while it is ahead", async () => {
    renderApp("/jar/1", at({ nextAllowanceAt: NOW + 300, availableAllowance: 0 }));
    expect(await screen.findByText(/^Next allowance: .+\.$/)).toBeTruthy();
    expect(screen.queryByText(/due now/)).toBeNull();
  });

  it("says a passed allowance time is due now when the jar has sats to pay it", async () => {
    renderApp("/jar/1", at({ nextAllowanceAt: NOW - 60, availableAllowance: 2_500, balance: 9_000 }));
    expect(await screen.findByText("Next allowance: due now, Sats Jar sends it soon.")).toBeTruthy();
  });

  it("never promises a passed allowance from an empty jar", async () => {
    renderApp("/jar/1", at({ nextAllowanceAt: NOW - 60, availableAllowance: 2_500, balance: 0 }));
    expect(await screen.findByText("Next allowance: once the jar has sats again.")).toBeTruthy();
    expect(screen.queryByText(/due now/)).toBeNull();
  });

  it("pauses the allowance while a confirmed handover waits to go ahead", async () => {
    renderApp("/jar/1", at({
      availableAllowance: 2_500,
      handover: { state: "confirmed", claimedAt: NOW - 900, delayEndsAt: NOW - 1, confirmedByMe: false, pausesAllowancesEarly: true },
    }));
    expect(await screen.findByText("Allowances are paused while the handover waits to go ahead. If it's cancelled, they start again.")).toBeTruthy();
    expect(allowanceText()).not.toMatch(/Available now|on its own|Next allowance/);
  });

  it("ends the allowance while the jar's Bitcoin moves to the child, and after handover", async () => {
    const moving = renderApp("/jar/1", at({ availableAllowance: 7_500, handover: { state: "completing", coinsToMove: 2, coinsLeft: 1 } }));
    expect(await screen.findByText("Allowances have ended. The jar's Bitcoin is moving to the child's own key.")).toBeTruthy();
    expect(allowanceText()).not.toMatch(/Available now|on its own/);
    moving.unmount();
    renderApp("/jar/1", at({ availableAllowance: 7_500, handover: { state: "done", completedAt: NOW - 60 } }));
    expect(await screen.findByText("Allowances have ended. The jar is the child's now.")).toBeTruthy();
    expect(allowanceText()).not.toMatch(/Available now|on its own/);
  });

  it("shows a demo jar's exit as a local date and time, and a 30-day jar's as a day", async () => {
    const opensAt = Date.UTC(2026, 10, 14, 0, 31) / 1000;
    const local = new Date(opensAt * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    const demo = renderApp("/jar/1", at({ exit: { ...jar1.exit, opensAt }, handover: { state: "none" } }));
    expect(await screen.findByText(new RegExp(`exit opens on ${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and pays`))).toBeTruthy();
    demo.unmount();
    renderApp("/jar/1", at({ demoTiming: false, exit: { ...jar1.exit, opensAt: Date.UTC(2042, 4, 1) / 1000 }, handover: { state: "none" } }));
    expect(await screen.findByText(/exit opens on 1 May 2042 and pays/)).toBeTruthy();
  });

  it("never says 'if no handover happens' while a handover is under way", async () => {
    const claimed = renderApp("/jar/1", at({ handover: { state: "claimed", claimedAt: NOW, lapsesAt: NOW + 420, confirmations: 0, confirmedByMe: false, pausesAllowancesEarly: false } }));
    expect(await screen.findByText(/^If Sats Jar's signing ever stops before the handover is done/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/If no handover happens/);
    claimed.unmount();
    renderApp("/jar/1", at({ handover: { state: "completing", coinsToMove: 2, coinsLeft: 1 } }));
    expect(
      await screen.findByText(/^The jar's Bitcoin is moving to the child's own key\. Once it's there, if Sats Jar's signing ever stops, the Bitcoin-only exit opens on .+, and only the child's recovery phrase can use it\.$/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/If no handover happens/);
  });
});
