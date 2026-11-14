/** @vitest-environment jsdom */
import type { JarStatus } from "@sats-jar/sdk";
import { SatsJarRefusal } from "@sats-jar/sdk";
import { screen, waitFor, within } from "@testing-library/react";
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

  it("says a sent payment is on its way, with its transaction", async () => {
    const { user } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {});
      sdk.holder.spend.mockResolvedValue(sent("S1"));
    });
    await user.type(await screen.findByLabelText("To (Bitcoin address)"), CHILD_ADDRESS);
    await user.type(screen.getByLabelText("Amount (sats)"), "1000");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const line = await screen.findByText(`On its way: 1,000 sats to ${CHILD_ADDRESS}.`);
    expect(within(line.closest("section")!).getByRole("link", { name: "Check it yourself ↗" }).getAttribute("href")).toBe(
      "https://testnet.nearblocks.io/txns/S1",
    );
  });

  it("starts a transfer to a receive code", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, {});
      sdk.holder.startTransfer.mockResolvedValue(sent("T1"));
    });
    expect(await screen.findByText("They find it on their own phone, under 'Someone is giving me a jar'. If they sent you a link, it's already filled in.")).toBeTruthy();
    await user.type(screen.getByLabelText("Their receive code"), RECEIVE_CODE);
    await user.click(screen.getByRole("button", { name: "Start the transfer" }));
    expect(sdk.holder.startTransfer).toHaveBeenCalledWith("7", RECEIVE_CODE);
  });

  it("while a transfer is offered, gives the accept link, hides the spend and cancels on request", async () => {
    const { user, sdk } = renderApp("/jar/7", (sdk) => {
      jarAs(sdk, { transfer: { state: "offered", toMe: false } });
      sdk.holder.cancelTransfer.mockResolvedValue(sent("X1"));
    });
    expect(await screen.findByText("Send them this link. They open it on their phone and press Accept:")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/jar/7/accept`)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Send Bitcoin" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel the transfer" }));
    expect(sdk.holder.cancelTransfer).toHaveBeenCalledWith("7");
  });

  it("shows the Bitcoin moving to the new holder", async () => {
    renderApp("/jar/7", (sdk) => jarAs(sdk, { transfer: { state: "moving", toMe: false, coinsToMove: 0, coinsLeft: 2 } }));
    expect(await screen.findByText("The jar's Bitcoin is moving to the new holder's key: 2 coins still to go.")).toBeTruthy();
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
    expect(await screen.findByRole("heading", { name: "Your receive link" })).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/give/${RECEIVE_CODE}`)).toBeTruthy();
    expect(screen.getByText(RECEIVE_CODE)).toBeTruthy();
    expect(
      screen.getByText("Send this link to the person giving you the jar. It fills in your code for them, and it can only be used to give you a jar."),
    ).toBeTruthy();
    expect(screen.getByText("Next: they start the transfer and send you a link back. Open it on this phone and press Accept.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
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
    expect(await screen.findByRole("heading", { name: "Accept Sunny's jar" })).toBeTruthy();
  });

  it("stays on the page and shows the jar's Bitcoin moving, then that the jar is yours", async () => {
    const { unmount } = renderApp("/jar/7/accept", (sdk) =>
      jarAs(sdk, { roles: [], transfer: { state: "moving", toMe: true, coinsToMove: 3, coinsLeft: 2 } }),
    );
    expect(await screen.findByText("The jar's Bitcoin is moving to your key: 2 coins still to go.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept the jar" })).toBeNull();
    unmount();
    renderApp("/jar/7/accept", (sdk) => jarAs(sdk, { roles: ["holder"], transfer: { state: "none" } }));
    expect(await screen.findByText("Sunny's jar is yours.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open your jar" }).getAttribute("href")).toBe("/jar/7");
  });

  it("shows the accepted jar under Your jars without a reload", async () => {
    const { user, sdk } = renderApp("/jar/7/accept", (sdk) => {
      jarAs(sdk, { roles: [], transfer: { state: "offered", toMe: true } });
      sdk.holder.acceptTransfer.mockImplementation(async () => {
        sdk.jars.status.mockResolvedValue({ ...handedOver, roles: ["holder"], transfer: { state: "none" } });
        sdk.jars.mine.mockResolvedValue([{ jarId: "7", nickname: "Sunny's jar", roles: ["holder"], balance: 0, picture: "", demoTiming: true }]);
        return sent("A2");
      });
    });
    await user.click(await screen.findByRole("button", { name: "Accept the jar" }));
    await user.click(await screen.findByRole("link", { name: "Sats Jar" }));
    const card = (await screen.findByText("Sunny's jar")).closest("li")!;
    expect(within(card).getByText("You hold this jar")).toBeTruthy();
    expect(sdk.jars.mine).toHaveBeenCalled();
  });

  it("tells a phone the transfer isn't for it instead of offering Accept", async () => {
    renderApp("/jar/7/accept", (sdk) => jarAs(sdk, { roles: [], transfer: { state: "offered", toMe: false } }));
    expect(await screen.findByText("This transfer is for a different phone. Open the link on the phone that made your receive code.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept the jar" })).toBeNull();
  });

  it("says when the jar is moving to someone else, or there is nothing to accept", async () => {
    const { unmount } = renderApp("/jar/7/accept", (sdk) =>
      jarAs(sdk, { roles: [], transfer: { state: "moving", toMe: false, coinsToMove: 1, coinsLeft: 1 } }),
    );
    expect(await screen.findByText("This jar is moving to someone else.")).toBeTruthy();
    unmount();
    renderApp("/jar/7/accept", (sdk) => jarAs(sdk, { roles: [], transfer: { state: "none" } }));
    expect(await screen.findByText("There's no transfer to accept for this jar right now. Ask the person giving it to you to start one.")).toBeTruthy();
  });

  it("shows the SDK's sentence when an accept is refused", async () => {
    const { user } = renderApp("/jar/7/accept", (sdk) => {
      jarAs(sdk, { roles: [], transfer: { state: "offered", toMe: true } });
      sdk.holder.acceptTransfer.mockRejectedValue(new SatsJarRefusal("PAYMENT_PENDING", "A payment from the jar is still on its way. Try again once it is confirmed."));
    });
    await user.click(await screen.findByRole("button", { name: "Accept the jar" }));
    expect(await screen.findByText("A payment from the jar is still on its way. Try again once it is confirmed.")).toBeTruthy();
  });
});

describe("giving a jar from a receive link", () => {
  const holdsJar = (sdk: StandInSdk, jars: { id: string; nickname: string; change: Partial<JarStatus> }[]) => {
    sdk.jars.mine.mockResolvedValue(
      jars.map((jar) => ({ jarId: jar.id, nickname: jar.nickname, roles: ["holder" as const], balance: 1_000, picture: "", demoTiming: true })),
    );
    sdk.jars.status.mockImplementation(async (id: string) => {
      const jar = jars.find((j) => j.id === id)!;
      return { ...handedOver, jarId: id, nickname: jar.nickname, ...jar.change };
    });
    sdk.jars.topUps.mockResolvedValue([]);
    sdk.jars.allowances.mockResolvedValue([]);
  };

  it("opens the one jar this phone can give with the code filled in, and sends it as today", async () => {
    const { user, sdk } = renderApp(`/give/${RECEIVE_CODE}`, (sdk) => {
      holdsJar(sdk, [{ id: "7", nickname: "Sunny's jar", change: {} }]);
      sdk.holder.startTransfer.mockResolvedValue(sent("T1"));
    });
    const field = (await screen.findByLabelText("Their receive code")) as HTMLInputElement;
    expect(field.value).toBe(RECEIVE_CODE);
    await user.click(screen.getByRole("button", { name: "Start the transfer" }));
    expect(sdk.holder.startTransfer).toHaveBeenCalledWith("7", RECEIVE_CODE);
  });

  it("lists the jars when this phone can give more than one", async () => {
    renderApp(`/give/${RECEIVE_CODE}`, (sdk) =>
      holdsJar(sdk, [
        { id: "7", nickname: "Sunny's jar", change: {} },
        { id: "8", nickname: "Kit's jar", change: {} },
      ]),
    );
    expect((await screen.findByRole("link", { name: "Give Sunny's jar" })).getAttribute("href")).toBe(`/jar/7?give=${RECEIVE_CODE}`);
    expect(screen.getByRole("link", { name: "Give Kit's jar" }).getAttribute("href")).toBe(`/jar/8?give=${RECEIVE_CODE}`);
  });

  it("says plainly when this phone holds no jar it can give", async () => {
    renderApp(`/give/${RECEIVE_CODE}`, (sdk) => holdsJar(sdk, [{ id: "7", nickname: "Sunny's jar", change: { handover: { state: "none" } } }]));
    expect(await screen.findByText("This link gives a jar away, but this device holds no jar it can give right now.")).toBeTruthy();
  });

  it("says the same on a new phone, without asking it for a PIN", async () => {
    renderApp(`/give/${RECEIVE_CODE}`, (sdk) => sdk.device.state.mockResolvedValue("new"));
    expect(await screen.findByText("This link gives a jar away, but this device holds no jar it can give right now.")).toBeTruthy();
    expect(screen.queryByLabelText("PIN")).toBeNull();
  });
});
