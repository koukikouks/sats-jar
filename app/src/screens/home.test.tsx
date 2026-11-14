/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render.tsx";

const picture = "data:image/svg+xml;base64,PHN2Zy8+";

describe("home", () => {
  it("offers a new device its three ways in, and no PIN yet", async () => {
    renderApp("/", (sdk) => sdk.device.state.mockResolvedValue("new"));
    expect(await screen.findByRole("heading", { name: "A jar of Bitcoin for someone you love" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Make a jar" }).getAttribute("href")).toBe("/new");
    expect(screen.getByRole("link", { name: "Restore my jar from its recovery phrase" }).getAttribute("href")).toBe("/restore");
    expect(screen.getByRole("link", { name: "Someone is giving me a jar" }).getAttribute("href")).toBe("/receive");
    expect(screen.getByText("Asked to be a guardian, or setting up your own jar? Open the link you were sent.")).toBeTruthy();
    expect(screen.queryByLabelText("PIN")).toBeNull();
  });

  it("lists this device's jars with picture, badge, balance and roles", async () => {
    renderApp("/", (sdk) =>
      sdk.jars.mine.mockResolvedValue([
        { jarId: "7", nickname: "Sunny's jar", roles: ["giver", "holder"], balance: 20_000, picture, demoTiming: true },
        { jarId: "8", nickname: "Kit's jar", roles: ["guardian"], balance: 0, picture, demoTiming: false },
      ]),
    );
    const sunny = (await screen.findByText("Sunny's jar")).closest("li")!;
    expect(within(sunny).getByRole("link").getAttribute("href")).toBe("/jar/7");
    expect(within(sunny).getByText("Demo timing")).toBeTruthy();
    expect(within(sunny).getByText("20,000 sats")).toBeTruthy();
    expect(within(sunny).getByText("You gave this jar · You hold this jar")).toBeTruthy();
    const kit = screen.getByText("Kit's jar").closest("li")!;
    expect(within(kit).queryByText("Demo timing")).toBeNull();
    expect(within(kit).getByText("You're a guardian")).toBeTruthy();
  });

  it("lists jars still being set up with how many guardians joined", async () => {
    const { sdk } = renderApp("/", (sdk) => {
      sdk.invites.mine.mockResolvedValue([
        { draftId: "d1", nickname: "Sunny's jar", inviteTokens: ["a", "b", "c"], jarId: null },
        { draftId: "d2", nickname: "Made already", inviteTokens: ["x", "y"], jarId: "3" },
      ]);
      sdk.invites.progress.mockResolvedValue({ nickname: "Sunny's jar", joined: [true, false, false] });
    });
    const draft = await screen.findByRole("link", { name: "Sunny's jar: 1 of 3 guardians joined so far" });
    expect(draft.getAttribute("href")).toBe("/draft/d1");
    expect(sdk.invites.progress).toHaveBeenCalledWith("d1");
    expect(screen.queryByText(/Made already/)).toBeNull();
  });

  it("says so when there are no jars", async () => {
    renderApp("/");
    expect(await screen.findByText("No jars here yet. Make one, or open a link someone sent you.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Make a jar" })).toBeTruthy();
  });
});
