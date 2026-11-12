/** @vitest-environment jsdom */
import type { Allowance, JarStatus, TopUp } from "@sats-jar/sdk";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("shows a funded jar's balance, top-up address, counted top-ups and paid allowance from live data", async () => {
    const { sdk } = renderApp("/jar/1", (sdk) =>
      showing(sdk, jar1, live.topUps as TopUp[], live.allowances as Allowance[]),
    );
    expect(await screen.findByRole("heading", { name: jar1.nickname })).toBeTruthy();
    expect(sdk.jars.status).toHaveBeenCalledWith("1");
    expect(screen.getByText("1,260 sats in the jar")).toBeTruthy();
    expect(screen.getByText("You gave this jar · You hold this jar")).toBeTruthy();
    expect(screen.getByText(jar1.address)).toBeTruthy();
    expect(screen.getByText(/It counts once Bitcoin has confirmed it 3 times/)).toBeTruthy();
    const topUps = screen.getByRole("heading", { name: "Top-ups" }).closest("section")!;
    expect(await within(topUps).findAllByText("Counted")).toHaveLength(2);
    expect(within(topUps).getAllByRole("link", { name: "Check it yourself ↗" })[0]?.getAttribute("href")).toBe(live.topUps[0]?.explorerUrl);
    const allowance = screen.getByRole("heading", { name: "Allowance" }).closest("section")!;
    expect(await within(allowance).findByText("Paid")).toBeTruthy();
    expect(within(allowance).getByText(`2,500 sats to the child, fee ${live.allowances[0]?.fee.toLocaleString("en-US")} sats from the jar`)).toBeTruthy();
    expect(within(allowance).getByText("Sats Jar pays it automatically.")).toBeTruthy();
    expect(within(allowance).getByText(/^Next one: .+\.$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByText(jar1.exit.note)).toBeTruthy();
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
    expect(await screen.findByText("No top-ups yet.")).toBeTruthy();
    expect(screen.getByText("Up to 2,500 sats every 10 minutes.")).toBeTruthy();
    expect(screen.getByText("Starts with the first counted top-up.")).toBeTruthy();
    expect(screen.getByText(/From then on, the child can take it over\./)).toBeTruthy();
    expect(screen.getByText("When it's time, send the child this link to open on their own phone:")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/jar/7/set-up`)).toBeTruthy();
  });

  it("sends anyone without a role to the public record", async () => {
    renderApp("/jar/1", (sdk) => showing(sdk, recorded));
    expect(await screen.findByText("This page is for the jar's family.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the jar's public record" }).getAttribute("href")).toBe("/proof/1");
    expect(screen.queryByText(jar1.address)).toBeNull();
  });
});
