/** @vitest-environment jsdom */
import { SatsJarRefusal } from "@sats-jar/sdk";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render.tsx";

describe("the PIN gate", () => {
  it("sets up a new device with a 6-digit PIN typed twice", async () => {
    const { user, sdk } = renderApp("/new", (sdk) => {
      sdk.device.state.mockResolvedValue("new");
      sdk.device.setUp.mockImplementation(async () => void sdk.device.state.mockResolvedValue("unlocked"));
    });
    expect(await screen.findByRole("heading", { name: "Set up Sats Jar on this device" })).toBeTruthy();
    expect(screen.getByText(/We can't reset the PIN, so pick one you'll remember\./)).toBeTruthy();
    await user.type(screen.getByLabelText("PIN"), "482913");
    await user.type(screen.getByLabelText("Type it again"), "482913");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(sdk.device.setUp).toHaveBeenCalledWith({ pin: "482913" });
    expect(await screen.findByRole("button", { name: "Lock" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Set up Sats Jar on this device" })).toBeNull();
  });

  it("refuses a short PIN and two PINs that differ without calling the SDK", async () => {
    const { user, sdk } = renderApp("/new", (sdk) => sdk.device.state.mockResolvedValue("new"));
    await user.type(await screen.findByLabelText("PIN"), "4829");
    await user.type(screen.getByLabelText("Type it again"), "4829");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(await screen.findByText("Use 6 digits.")).toBeTruthy();
    await user.clear(screen.getByLabelText("PIN"));
    await user.clear(screen.getByLabelText("Type it again"));
    await user.type(screen.getByLabelText("PIN"), "482913");
    await user.type(screen.getByLabelText("Type it again"), "482914");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(await screen.findByText("The two PINs don't match.")).toBeTruthy();
    expect(sdk.device.setUp).not.toHaveBeenCalled();
  });

  it("takes only 6 digits in a PIN box, so a seventh digit or a letter never lands", async () => {
    const { user, sdk } = renderApp("/new", (sdk) => {
      sdk.device.state.mockResolvedValue("new");
      sdk.device.setUp.mockImplementation(async () => void sdk.device.state.mockResolvedValue("unlocked"));
    });
    await user.type(await screen.findByLabelText("PIN"), "1234567");
    await user.type(screen.getByLabelText("Type it again"), "12a34567");
    expect((screen.getByLabelText("PIN") as HTMLInputElement).value).toBe("123456");
    expect((screen.getByLabelText("Type it again") as HTMLInputElement).value).toBe("123456");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(sdk.device.setUp).toHaveBeenCalledWith({ pin: "123456" });
  });

  it("unlocks a locked device, showing the SDK's sentence for a wrong PIN", async () => {
    const { user, sdk } = renderApp("/", (sdk) => {
      sdk.device.state.mockResolvedValue("locked");
      sdk.device.unlock
        .mockRejectedValueOnce(new SatsJarRefusal("WRONG_PIN", "That PIN is not right. Try again."))
        .mockImplementationOnce(async () => void sdk.device.state.mockResolvedValue("unlocked"));
    });
    expect(await screen.findByRole("heading", { name: "Unlock Sats Jar" })).toBeTruthy();
    await user.type(screen.getByLabelText("PIN"), "000000");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("That PIN is not right. Try again.")).toBeTruthy();
    await user.clear(screen.getByLabelText("PIN"));
    await user.type(screen.getByLabelText("PIN"), "482913");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(sdk.device.unlock).toHaveBeenLastCalledWith({ pin: "482913" });
    expect(await screen.findByRole("heading", { name: "Your jars" })).toBeTruthy();
  });

  it("locks the app from the header", async () => {
    const { user, sdk } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Lock" }));
    expect(sdk.device.lock).toHaveBeenCalledWith();
    expect(await screen.findByRole("heading", { name: "Unlock Sats Jar" })).toBeTruthy();
  });

  it("shows the Test Bitcoin badge on every screen", async () => {
    renderApp("/");
    expect(await screen.findByText("Test Bitcoin")).toBeTruthy();
  });
});
