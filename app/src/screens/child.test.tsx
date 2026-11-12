/** @vitest-environment jsdom */
import type { JarStatus } from "@sats-jar/sdk";
import { SatsJarRefusal } from "@sats-jar/sdk";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import live from "../test/fixtures/dev-jar-1.json";
import { renderApp } from "../test/render.tsx";
import type { StandInSdk } from "../test/stand-in.ts";

const words = ["hollow", "ribbon", "maple", "acid", "baby", "cable", "dance", "eagle", "fabric", "gadget", "habit", "ice"];
const jar: JarStatus = { ...(live.status as unknown as JarStatus), jarId: "7", nickname: "Sunny's jar" };

function newPhone(sdk: StandInSdk) {
  sdk.device.state.mockResolvedValue("new");
  sdk.child.startSetUp.mockResolvedValue({ words, check: [2, 6, 9] });
  sdk.child.finishSetUp.mockImplementation(async () => void sdk.device.state.mockResolvedValue("unlocked"));
  sdk.child.guardianCode.mockResolvedValue("4821 0937 5512 8846 1203");
  sdk.jars.status.mockResolvedValue(jar);
}

describe("setting up the child's phone", () => {
  it("shows the phrase once, checks 3 words with a PIN, then shows the code and the plain statement, and claims", async () => {
    const { user, sdk } = renderApp("/jar/7/set-up", (sdk) => {
      newPhone(sdk);
      sdk.child.claim.mockResolvedValue({ explorerUrl: "https://testnet.nearblocks.io/txns/C" });
      sdk.jars.topUps.mockResolvedValue([]);
      sdk.jars.allowances.mockResolvedValue([]);
    });
    expect(await screen.findByRole("heading", { name: "Set up your jar" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show my recovery phrase" }));
    expect(await screen.findByText(/Anyone with these words can take your jar\. Nobody, Sats Jar included, can give them back/)).toBeTruthy();
    for (const word of words) expect(screen.getByText(word)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "I've written them down" }));
    expect(screen.queryByText("hollow")).toBeNull();
    await user.type(screen.getByLabelText("Word 3"), "maple");
    await user.type(screen.getByLabelText("Word 7"), "dance");
    await user.type(screen.getByLabelText("Word 10"), "gadget");
    await user.type(screen.getByLabelText("PIN"), "771204");
    await user.type(screen.getByLabelText("Type it again"), "771204");
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(sdk.child.finishSetUp).toHaveBeenCalledWith({
      words: [
        { index: 2, word: "maple" },
        { index: 6, word: "dance" },
        { index: 9, word: "gadget" },
      ],
      pin: "771204",
    });
    expect(await screen.findByRole("heading", { name: "Claim Sunny's jar" })).toBeTruthy();
    expect(screen.getByText("4821 0937 5512 8846 1203")).toBeTruthy();
    expect(
      screen.getByText("After handover, nobody, Sats Jar included, can recover your jar without this phone or your recovery phrase."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Claim my jar" }));
    expect(sdk.child.claim).toHaveBeenCalledWith("7");
  });

  it("refuses wrong words with the SDK's sentence", async () => {
    const { user } = renderApp("/jar/7/set-up", (sdk) => {
      newPhone(sdk);
      sdk.child.finishSetUp.mockRejectedValue(
        new SatsJarRefusal("WRONG_RECOVERY_WORDS", "Those words do not match your recovery phrase. Look at it again."),
      );
    });
    await user.click(await screen.findByRole("button", { name: "Show my recovery phrase" }));
    await user.click(await screen.findByRole("button", { name: "I've written them down" }));
    await user.type(screen.getByLabelText("Word 3"), "zzz");
    await user.type(screen.getByLabelText("Word 7"), "zzz");
    await user.type(screen.getByLabelText("Word 10"), "zzz");
    await user.type(screen.getByLabelText("PIN"), "771204");
    await user.type(screen.getByLabelText("Type it again"), "771204");
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Those words do not match your recovery phrase. Look at it again.")).toBeTruthy();
  });

  it("tells an adult's device to open the link on the child's own phone", async () => {
    renderApp("/jar/7/set-up", (sdk) => {
      sdk.child.guardianCode.mockRejectedValue(new SatsJarRefusal("NO_RECOVERY_PHRASE", "Only a phone set up with a recovery phrase can do that."));
      sdk.jars.status.mockResolvedValue(jar);
    });
    expect(await screen.findByText("This device is set up for an adult. Open this link on the child's own phone.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claim my jar" })).toBeNull();
  });
});

describe("restoring the child's phone", () => {
  it("sends the typed phrase as words with the new PIN, then goes home", async () => {
    const { user, sdk } = renderApp("/restore", (sdk) => {
      sdk.device.state.mockResolvedValue("new");
      sdk.child.restore.mockImplementation(async () => void sdk.device.state.mockResolvedValue("unlocked"));
    });
    expect(await screen.findByRole("heading", { name: "Restore your jar" })).toBeTruthy();
    await user.type(screen.getByLabelText("Recovery phrase"), `  ${words.join("  ").toUpperCase()}\n`);
    await user.type(screen.getByLabelText("PIN"), "771204");
    await user.type(screen.getByLabelText("Type it again"), "771204");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(sdk.child.restore).toHaveBeenCalledWith({ words, pin: "771204" });
    expect(await screen.findByRole("heading", { name: "Your jars" })).toBeTruthy();
  });

  it("shows the SDK's sentence for a device already set up", async () => {
    const { user } = renderApp("/restore", (sdk) =>
      sdk.child.restore.mockRejectedValue(new SatsJarRefusal("ALREADY_SET_UP", "This device is already set up.")),
    );
    await user.type(await screen.findByLabelText("Recovery phrase"), words.join(" "));
    await user.type(screen.getByLabelText("PIN"), "771204");
    await user.type(screen.getByLabelText("Type it again"), "771204");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("This device is already set up.")).toBeTruthy();
  });
});
