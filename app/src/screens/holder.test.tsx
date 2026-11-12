/** @vitest-environment jsdom */
import type { JarStatus } from "@sats-jar/sdk";
import { SatsJarRefusal } from "@sats-jar/sdk";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import live from "../test/fixtures/dev-jar-1.json";
import { renderApp } from "../test/render.tsx";
import type { StandInSdk } from "../test/stand-in.ts";

const NOW = 1_800_000_000;
const CHILD_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
const RECEIVE_CODE = "2F4hoB8SRRGgps1Rmp5jTouFbGL3SfdC71ThegP9n6L3UKnpXb2FmJckBmKbBZ";
const sent = (hash: string) => ({ explorerUrl: `https://testnet.nearblocks.io/txns/${hash}` });
const handedOver: JarStatus = {
  ...(live.status as unknown as JarStatus),
  jarId: "7",
  nickname: "Sunny's jar",
  roles: ["holder"],
  handover: { state: "done", completedAt: NOW },
};

function jarAs(sdk: StandInSdk, change: Partial<JarStatus>) {
  sdk.jars.status.mockResolvedValue({ ...handedOver, ...change });
  sdk.jars.topUps.mockResolvedValue([]);
  sdk.jars.allowances.mockResolvedValue([]);
}

describe("the holder after handover", () => {
  it("sends the jar's Bitcoin to an address with no fee rate, as the SDK check does", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {});
      sdk.holder.spend.mockRejectedValue(
        new SatsJarRefusal("INSUFFICIENT_BALANCE", "The jar does not hold enough Bitcoin for that payment and its fee.", "https://x"),
      );
    });
    expect(await screen.findByRole("heading", { name: "Send Bitcoin" })).toBeTruthy();
    expect(screen.getByText("The Bitcoin fee comes out of the jar.")).toBeTruthy();
    await user.type(screen.getByLabelText("To (Bitcoin address)"), CHILD_ADDRESS);
    await user.type(screen.getByLabelText("Amount (sats)"), "1000");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sdk.holder.spend).toHaveBeenCalledWith("7", { to: CHILD_ADDRESS, amount: 1_000 });
    expect(await screen.findByText("The jar does not hold enough Bitcoin for that payment and its fee.")).toBeTruthy();
  });

  it("starts a transfer to a receive code", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {});
      sdk.holder.startTransfer.mockResolvedValue(sent("T1"));
    });
    expect(await screen.findByText("They get it on their own phone, under 'Someone is giving me a jar'.")).toBeTruthy();
    await user.type(screen.getByLabelText("Their receive code"), RECEIVE_CODE);
    await user.click(screen.getByRole("button", { name: "Start the transfer" }));
    expect(sdk.holder.startTransfer).toHaveBeenCalledWith("7", RECEIVE_CODE);
  });

  it("while a transfer is offered, gives the accept link, hides the spend and cancels on request", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { transfer: { state: "offered", toMe: false } });
      sdk.holder.cancelTransfer.mockResolvedValue(sent("X1"));
    });
    expect(await screen.findByText("Send them this link so they can accept:")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/jar/7/accept`)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Send Bitcoin" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel the transfer" }));
    expect(sdk.holder.cancelTransfer).toHaveBeenCalledWith("7");
  });

  it("shows the Bitcoin moving to the new holder", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { transfer: { state: "moving", toMe: false, coinsToMove: 2, coinsLeft: 2 } }));
    expect(await screen.findByText("The jar's Bitcoin is moving to the new holder's key: 0 of 2 coins moved.")).toBeTruthy();
  });

  it("offers nothing to the family account after handover", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { roles: ["giver"] }));
    await screen.findByRole("heading", { name: "Handover" });
    expect(screen.queryByRole("heading", { name: "Send Bitcoin" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Give the jar to someone" })).toBeNull();
  });
});

describe("receiving a jar", () => {
  it("sets up a new phone with its own recovery phrase, then shows its receive code", async () => {
    const words = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const { user, sdk } = renderApp("/receive", (sdk) => {
      sdk.device.state.mockResolvedValue("new");
      sdk.child.startSetUp.mockResolvedValue({ words, check: [0, 4, 11] });
      sdk.child.finishSetUp.mockImplementation(async () => void sdk.device.state.mockResolvedValue("unlocked"));
      sdk.holder.receiveCode.mockResolvedValue(RECEIVE_CODE);
    });
    expect(await screen.findByRole("heading", { name: "Someone is giving you a jar" })).toBeTruthy();
    expect(screen.getByText(/The jar's Bitcoin will answer only to keys made on this phone\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show my recovery phrase" }));
    await user.click(await screen.findByRole("button", { name: "I've written them down" }));
    await user.type(screen.getByLabelText("Word 1"), "a");
    await user.type(screen.getByLabelText("Word 5"), "e");
    await user.type(screen.getByLabelText("Word 12"), "l");
    await user.type(screen.getByLabelText("PIN"), "482913");
    await user.type(screen.getByLabelText("Type it again"), "482913");
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("heading", { name: "Your receive code" })).toBeTruthy();
    expect(screen.getByText(RECEIVE_CODE)).toBeTruthy();
    expect(screen.getByText("Give this code to the person giving you the jar. It can only be used to give you a jar.")).toBeTruthy();
    expect(sdk.holder.receiveCode).toHaveBeenCalledWith();
  });

  it("shows the SDK's sentence on an adult's device", async () => {
    renderApp("/receive", (sdk) =>
      sdk.holder.receiveCode.mockRejectedValue(new SatsJarRefusal("NO_RECOVERY_PHRASE", "Only a phone set up with a recovery phrase can do that.")),
    );
    expect(await screen.findByText("Only a phone set up with a recovery phrase can do that.")).toBeTruthy();
  });
});

describe("accepting a transfer", () => {
  it("accepts with this phone's own key and no fee rate, then opens the jar", async () => {
    const { user, sdk } = renderApp("/jar/7/accept", (sdk) => {
      jarAs(sdk, { transfer: { state: "offered", toMe: true } });
      sdk.holder.acceptTransfer.mockResolvedValue(sent("A1"));
    });
    expect(await screen.findByRole("heading", { name: "Accept Sunny's jar" })).toBeTruthy();
    expect(
      screen.getByText("Accepting moves the jar's Bitcoin to a new address that only your recovery phrase can recover. Then the jar is yours."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Accept the jar" }));
    expect(sdk.holder.acceptTransfer).toHaveBeenCalledWith("7");
    expect(await screen.findByRole("heading", { name: "Sunny's jar" })).toBeTruthy();
  });

  it("shows the SDK's sentence when the transfer is for someone else", async () => {
    const { user } = renderApp("/jar/7/accept", (sdk) => {
      jarAs(sdk, { transfer: { state: "offered", toMe: false } });
      sdk.holder.acceptTransfer.mockRejectedValue(new SatsJarRefusal("NOT_THE_RECEIVER", "This transfer is for someone else."));
    });
    await user.click(await screen.findByRole("button", { name: "Accept the jar" }));
    expect(await screen.findByText("This transfer is for someone else.")).toBeTruthy();
  });
});
