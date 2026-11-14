/** @vitest-environment jsdom */
import { JarNotFoundError, type BitcoinTransaction, type HistoryEvent, type JarProof, type NearTransaction } from "@sats-jar/proof";
import { SatsJarRefusal, type JarStatus, type Role } from "@sats-jar/sdk";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render.tsx";
import type { StandInProof, StandInSdk } from "../test/stand-in.ts";

const picture = "data:image/svg+xml;base64,PHN2Zy8+";

function jar(overrides: Partial<JarProof> = {}): JarProof {
  return {
    jarId: "7",
    nickname: "Sunny's jar",
    holder: "family-7.sats-jar-dev-2.testnet",
    giver: "ruth-1.sats-jar-dev-2.testnet",
    familyAccount: "family-7.sats-jar-dev-2.testnet",
    guardians: ["priya-1.sats-jar-dev-2.testnet", "ruth-1.sats-jar-dev-2.testnet"],
    childAddress: "tb1qchild0000000000000000000000000000000",
    cap: 2_500,
    period: 600,
    unlockAt: 2_220_000_000,
    demoTiming: true,
    address: "tb1qjar00000000000000000000000000000000000000000000000000",
    addressExplorerUrl: "https://mempool.space/testnet/address/tb1qjar",
    oldAddresses: [],
    witnessScript: "",
    publicKey: "",
    locktime: 0,
    provenBalance: 20_000,
    availableAllowance: 0,
    feeBudgetLeft: 0,
    nextAllowanceAt: null,
    clockStartedAt: null,
    handover: "none",
    emergency: null,
    transfer: null,
    nft: { title: "Sunny's jar", description: "", media: picture },
    coins: [],
    payments: [],
    history: [{ index: 0, at: 1_760_000_000, event: "jar_created" }],
    ...overrides,
  };
}

function tx(overrides: Partial<NearTransaction>): NearTransaction {
  return {
    hash: "H1",
    explorerUrl: "https://testnet.nearblocks.io/txns/H1",
    blockHeight: 1,
    time: 1_760_000_000,
    signer: "ruth-1.sats-jar-dev-2.testnet",
    method: "create_jar",
    ok: true,
    refusal: null,
    ...overrides,
  };
}

const child = "sunny-9.sats-jar-dev-2.testnet";

const handedOver: HistoryEvent[] = [
  { index: 0, at: 1_760_000_000, event: "jar_created" },
  { index: 1, at: 1_760_001_000, event: "handover_claimed", childAccount: child },
  { index: 2, at: 1_760_009_000, event: "handover_completed", childAccount: child },
];

/** A public record with this jar, these requests and these Bitcoin transactions. */
function record(proofJar: JarProof, requests: NearTransaction[] = [], bitcoin: BitcoinTransaction[] = []) {
  return (_sdk: StandInSdk, proof: StandInProof) => {
    proof.jar.mockResolvedValue(proofJar);
    proof.nearTransactions.mockResolvedValue(requests);
    proof.bitcoinTransactions.mockResolvedValue(bitcoin);
  };
}

describe("the public record", () => {
  it("shows the jar's settings to a device that is not set up", async () => {
    const { proof } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      sdk.device.state.mockResolvedValue("new");
    });
    expect(await screen.findByRole("heading", { name: "Sunny's jar: public record" })).toBeTruthy();
    expect(screen.getByText("Demo timing")).toBeTruthy();
    expect(
      screen.getByText("Everything here is read straight from the public NEAR and Bitcoin chains, not from Sats Jar. Check any line on an explorer."),
    ).toBeTruthy();
    const theJar = screen.getByRole("heading", { name: "The jar" }).closest("section")!;
    expect(within(theJar).getByRole("img").getAttribute("src")).toBe(picture);
    expect(within(theJar).getByText("Balance: 20,000 sats")).toBeTruthy();
    const address = within(theJar).getByRole("link", { name: /^Bitcoin address: tb1qjar0+ ↗$/ });
    expect(address.getAttribute("href")).toBe("https://mempool.space/testnet/address/tb1qjar");
    expect(within(theJar).getByText("Child's address: tb1qchild0000000000000000000000000000000")).toBeTruthy();
    expect(within(theJar).getByText("Allowance: up to 2,500 sats every 10 minutes")).toBeTruthy();
    expect(within(theJar).getByText(/^Unlocks: /)).toBeTruthy();
    expect(within(theJar).getByText("Guardians: 2")).toBeTruthy();
    expect(within(theJar).getByText("Held by: the family account")).toBeTruthy();
    expect(within(theJar).getByRole("link", { name: "The jar contract ↗" }).getAttribute("href")).toBe(
      "https://testnet.nearblocks.io/address/sats-jar-dev-2.testnet",
    );
    expect(proof.jar).toHaveBeenCalledWith("7");
    expect(screen.queryByLabelText("PIN")).toBeNull();
  });

  it("says the jar is held by its holder since handover once the family account no longer holds it", async () => {
    renderApp("/proof/7", record(jar({ holder: child, history: handedOver })));
    expect(await screen.findByText("Held by: its holder since handover")).toBeTruthy();
  });

  it("says there is no such jar for an unknown jar", async () => {
    renderApp("/proof/99", (_sdk, proof) => proof.jar.mockRejectedValue(new JarNotFoundError("99")));
    expect(await screen.findByText("There is no such jar.")).toBeTruthy();
  });

  it("shows the jar's top-up address and QR code so the giver can share one link", async () => {
    renderApp("/proof/7", record(jar()));
    const topUp = (await screen.findByRole("heading", { name: "Top it up" })).closest("section")!;
    expect(within(topUp).getByText("tb1qjar00000000000000000000000000000000000000000000000000")).toBeTruthy();
    expect(await within(topUp).findByAltText("QR code of the jar's Bitcoin address")).toBeTruthy();
  });

  it("lists the jar's requests oldest first, naming each sender by role and never by account", async () => {
    const requests = [
      tx({ hash: "A", method: "create_jar", signer: "ruth-1.sats-jar-dev-2.testnet" }),
      tx({ hash: "B", method: "propose_emergency", signer: "priya-1.sats-jar-dev-2.testnet" }),
      tx({
        hash: "C",
        method: "request_spend",
        signer: "kai-3.sats-jar-dev-2.testnet",
        ok: false,
        refusal: { code: "SPEND_BEFORE_HANDOVER", reason: "the jar can't be spent before handover" },
        explorerUrl: "https://testnet.nearblocks.io/txns/C",
      }),
      tx({ hash: "D", method: "claim_handover", signer: child }),
      tx({ hash: "E", method: "request_spend", signer: child }),
      tx({ hash: "F", method: "dev_cancel_payment", signer: "kai-3.sats-jar-dev-2.testnet" }),
    ];
    const claimed: HistoryEvent[] = [{ index: 1, at: 1_760_001_000, event: "handover_claimed", childAccount: child }];
    const { proof, container } = renderApp("/proof/7", record(jar({ history: claimed }), requests));
    const section = (await screen.findByRole("heading", { name: "Requests" })).closest("section")!;
    const rows = await within(section).findAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "Create the jar by the giver",
      "Propose an emergency payment by a guardian",
      "Spend from the jar by someone else",
      "Claim the jar by the child",
      "Spend from the jar by the child",
      "A request by someone else",
    ]);
    expect(within(rows[0]!).getByText("Done")).toBeTruthy();
    expect(within(rows[2]!).getByText("Refused: the jar can't be spent before handover")).toBeTruthy();
    expect(within(rows[2]!).getByRole("link", { name: "C ↗" }).getAttribute("href")).toBe("https://testnet.nearblocks.io/txns/C");
    expect(proof.nearTransactions).toHaveBeenCalledWith("7");
    expect(container.textContent).not.toMatch(/testnet|dev_cancel_payment/);
  });

  it("names accounts in a refusal's reason by role, never by account", async () => {
    const requests = [
      tx({
        hash: "G",
        method: "approve_emergency",
        signer: "kai-3.sats-jar-dev-2.testnet",
        ok: false,
        // contract/src/emergency.rs: the NOT_A_GUARDIAN sentence names the caller.
        refusal: { code: "NOT_A_GUARDIAN", reason: "kai-3.sats-jar-dev-2.testnet is not a guardian of jar 7" },
      }),
      tx({
        hash: "H",
        method: "cancel_emergency",
        signer: "priya-1.sats-jar-dev-2.testnet",
        ok: false,
        refusal: { code: "NOT_THE_GIVER", reason: `only ${"ruth-1.sats-jar-dev-2.testnet"}, not ${"a".repeat(64)}, may cancel` },
      }),
    ];
    const { container } = renderApp("/proof/7", record(jar(), requests));
    expect(await screen.findByText("Refused: someone else is not a guardian of jar 7")).toBeTruthy();
    expect(screen.getByText("Refused: only the giver, not someone else, may cancel")).toBeTruthy();
    expect(container.textContent).not.toMatch(/testnet|aaaaaaaa/);
  });

  it("does not repeat a role where the contract's sentence names the account after its role", async () => {
    const requests = [
      tx({
        hash: "J",
        method: "cancel_emergency",
        signer: "priya-1.sats-jar-dev-2.testnet",
        ok: false,
        // contract/src/emergency.rs: the NOT_THE_GIVER sentence, as recorded from testnet.
        refusal: { code: "NOT_THE_GIVER", reason: "only the giver, ruth-1.sats-jar-dev-2.testnet, can cancel an emergency payment" },
      }),
    ];
    const { container } = renderApp("/proof/7", record(jar(), requests));
    expect(await screen.findByText("Refused: only the giver can cancel an emergency payment")).toBeTruthy();
    expect(container.textContent).not.toMatch(/testnet|aaaaaaaa/);
  });

  it("names the holder after handover by role", async () => {
    const requests = [tx({ hash: "A", method: "start_transfer", signer: child })];
    renderApp("/proof/7", record(jar({ holder: child, history: handedOver }), requests));
    expect(await screen.findByText("Start a transfer by the holder")).toBeTruthy();
  });

  it("lists the jar's Bitcoin transactions, received and sent, each linked to its explorer", async () => {
    const bitcoin: BitcoinTransaction[] = [
      { txid: "t2", explorerUrl: "https://mempool.space/testnet/tx/t2", blockHeight: null, time: null, received: 7_300, sent: 10_000, fee: 200 },
      { txid: "t1", explorerUrl: "https://mempool.space/testnet/tx/t1", blockHeight: 9, time: 1_760_000_000, received: 10_000, sent: 0, fee: 150 },
    ];
    const { proof } = renderApp("/proof/7", record(jar(), [], bitcoin));
    const section = (await screen.findByRole("heading", { name: "Bitcoin transactions" })).closest("section")!;
    const rows = await within(section).findAllByRole("listitem");
    expect(within(rows[0]!).getByText("Sent 2,500 sats, fee 200 sats")).toBeTruthy();
    expect(within(rows[0]!).getByText("Not confirmed yet")).toBeTruthy();
    expect(within(rows[1]!).getByText("Received 10,000 sats")).toBeTruthy();
    expect(within(rows[1]!).getByText(/^Confirmed /)).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "t1 ↗" }).getAttribute("href")).toBe("https://mempool.space/testnet/tx/t1");
    expect(proof.bitcoinTransactions).toHaveBeenCalledWith(expect.objectContaining({ jarId: "7" }));
  });

  it("names a move between the jar's own addresses as a move, not money sent", async () => {
    // A re-homing: everything spent was the jar's, everything paid out came back to the jar, less the fee.
    const bitcoin: BitcoinTransaction[] = [
      { txid: "m1", explorerUrl: "https://mempool.space/testnet/tx/m1", blockHeight: 12, time: 1_760_009_000, received: 9_837, sent: 10_000, fee: 163 },
    ];
    renderApp("/proof/7", record(jar({ oldAddresses: ["tb1qold"] }), [], bitcoin));
    const section = (await screen.findByRole("heading", { name: "Bitcoin transactions" })).closest("section")!;
    const [row] = await within(section).findAllByRole("listitem");
    expect(within(row!).getByText("Moved to the jar's new address, fee 163 sats")).toBeTruthy();
  });
});

const EARLY = "Send its Bitcoin somewhere else before handover";
const AS_FAMILY = "Spend it as the family after handover";
const WITHOUT_HOLDING = "Spend it without holding it";
const OUTSIDER = "Approve its emergency payment as an outsider";

/** An unlocked device whose person has these roles in jar 7. */
function device(roles: Role[]) {
  return (sdk: StandInSdk) => sdk.jars.status.mockResolvedValue({ jarId: "7", roles } as unknown as JarStatus);
}

async function tryItSection() {
  const heading = await screen.findByRole("heading", { name: "Try to break the rule" });
  const section = heading.closest("section")!;
  await within(section).findAllByRole("button");
  return section;
}

const buttonNames = (section: HTMLElement) => within(section).getAllByRole("button").map((button) => button.textContent);

describe("trying to break the rule", () => {
  it("offers an early spend and an outsider's approval before handover, on any device", async () => {
    renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      sdk.device.state.mockResolvedValue("new");
    });
    const section = await tryItSection();
    expect(
      within(section).getByText("These buttons send real requests the jar's rule must refuse. Each refusal is a real transaction you can check."),
    ).toBeTruthy();
    expect(buttonNames(section)).toEqual([EARLY, OUTSIDER]);
  });

  it("sends the early spend from this device and shows the refusal with its transaction", async () => {
    const { user, sdk } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      device([])(sdk);
      sdk.tryIt.earlySpend.mockResolvedValue({
        code: "SPEND_BEFORE_HANDOVER",
        message: "The jar can't be spent before handover.",
        explorerUrl: "https://testnet.nearblocks.io/txns/T1",
      });
    });
    const section = await tryItSection();
    await user.click(within(section).getByRole("button", { name: EARLY }));
    expect(await within(section).findByText("Refused: The jar can't be spent before handover.")).toBeTruthy();
    expect(within(section).getByRole("link", { name: "Check it yourself ↗" }).getAttribute("href")).toBe("https://testnet.nearblocks.io/txns/T1");
    expect(sdk.tryIt.earlySpend).toHaveBeenCalledWith("7");
    expect(sdk.jars.status).toHaveBeenCalledWith("7");
  });

  it("sends an outsider's approval and shows the refusal", async () => {
    const { user, sdk } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      device([])(sdk);
      sdk.tryIt.outsiderApproval.mockResolvedValue({
        code: "NOT_A_GUARDIAN",
        message: "Only the jar's guardians can approve its emergency payment.",
        explorerUrl: "https://testnet.nearblocks.io/txns/T3",
      });
    });
    const section = await tryItSection();
    await user.click(within(section).getByRole("button", { name: OUTSIDER }));
    expect(await within(section).findByText("Refused: Only the jar's guardians can approve its emergency payment.")).toBeTruthy();
    expect(sdk.tryIt.outsiderApproval).toHaveBeenCalledWith("7");
  });

  it("hides the outsider's approval from a guardian's device", async () => {
    renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      device(["guardian"])(sdk);
    });
    expect(buttonNames(await tryItSection())).toEqual([EARLY]);
  });

  it("offers the giver's device a spend as the family after handover, and no early spend", async () => {
    const { user, sdk } = renderApp("/proof/7", (sdk, proof) => {
      record(jar({ holder: child, history: handedOver }))(sdk, proof);
      device(["giver", "guardian"])(sdk);
      sdk.tryIt.afterHandover.mockResolvedValue({
        code: "NOT_THE_HOLDER",
        message: "Only the jar's holder can spend it.",
        explorerUrl: "https://testnet.nearblocks.io/txns/T2",
      });
    });
    const section = await tryItSection();
    expect(buttonNames(section)).toEqual([AS_FAMILY]);
    await user.click(within(section).getByRole("button", { name: AS_FAMILY }));
    expect(await within(section).findByText("Refused: Only the jar's holder can spend it.")).toBeTruthy();
    expect(sdk.tryIt.afterHandover).toHaveBeenCalledWith("7");
  });

  it("offers any other device a spend without holding the jar after handover", async () => {
    renderApp("/proof/7", (sdk, proof) => {
      record(jar({ holder: child, history: handedOver }))(sdk, proof);
      device([])(sdk);
    });
    expect(buttonNames(await tryItSection())).toEqual([WITHOUT_HOLDING, OUTSIDER]);
  });

  it("offers the holder's device no spend after handover", async () => {
    renderApp("/proof/7", (sdk, proof) => {
      record(jar({ holder: child, history: handedOver }))(sdk, proof);
      device(["holder"])(sdk);
    });
    expect(buttonNames(await tryItSection())).toEqual([OUTSIDER]);
  });

  it("sets up a new device through the PIN gate before trying", async () => {
    const { user, sdk } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      sdk.device.state.mockResolvedValue("new");
    });
    const section = await tryItSection();
    await user.click(within(section).getByRole("button", { name: EARLY }));
    expect(await within(section).findByText("To try, set up Sats Jar on this device first.")).toBeTruthy();
    expect(within(section).getByRole("heading", { name: "Choose a PIN for this device" })).toBeTruthy();
    expect(sdk.tryIt.earlySpend).not.toHaveBeenCalled();
    expect(sdk.jars.status).not.toHaveBeenCalled();
  });

  it("asks a locked device for its PIN before trying", async () => {
    const { user, sdk } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      sdk.device.state.mockResolvedValue("locked");
    });
    const section = await tryItSection();
    await user.click(within(section).getByRole("button", { name: OUTSIDER }));
    expect(await within(section).findByRole("heading", { name: "Unlock Sats Jar" })).toBeTruthy();
    expect(within(section).queryByText("To try, set up Sats Jar on this device first.")).toBeNull();
    expect(sdk.tryIt.outsiderApproval).not.toHaveBeenCalled();
  });

  it("shows the SDK's sentence when a try could not be sent", async () => {
    const { user } = renderApp("/proof/7", (sdk, proof) => {
      record(jar())(sdk, proof);
      device([])(sdk);
      sdk.tryIt.earlySpend.mockRejectedValue(new SatsJarRefusal("UNAVAILABLE", "Sats Jar can't reach the network just now. Try again shortly."));
    });
    const section = await tryItSection();
    await user.click(within(section).getByRole("button", { name: EARLY }));
    expect(await within(section).findByText("Sats Jar can't reach the network just now. Try again shortly.")).toBeTruthy();
  });
});

describe("while the public record is still reading", () => {
  const never = () => new Promise<never>(() => {});

  it("says it is reading the chain instead of showing a blank page", async () => {
    renderApp("/proof/7", (_sdk, proof) => proof.jar.mockReturnValue(never()));
    expect((await screen.findByRole("status")).textContent).toBe("Reading the chain…");
  });

  it("says each list is reading the chain until its answer arrives", async () => {
    renderApp("/proof/7", (_sdk, proof) => {
      proof.jar.mockResolvedValue(jar());
      proof.nearTransactions.mockReturnValue(never());
      proof.bitcoinTransactions.mockReturnValue(never());
    });
    const requests = (await screen.findByRole("heading", { name: "Requests" })).closest("section")!;
    expect(within(requests).getByRole("status").textContent).toBe("Reading the chain…");
    const bitcoin = screen.getByRole("heading", { name: "Bitcoin transactions" }).closest("section")!;
    expect(within(bitcoin).getByRole("status").textContent).toBe("Reading the chain…");
  });

  it("says so when a list comes back empty", async () => {
    renderApp("/proof/7", record(jar(), [], []));
    expect(await screen.findByText("No requests yet.")).toBeTruthy();
    expect(await screen.findByText("No Bitcoin transactions yet.")).toBeTruthy();
    expect(screen.queryByText("Reading the chain…")).toBeNull();
  });

  it("says what each list holds and in what order", async () => {
    renderApp("/proof/7", record(jar(), [tx({})], []));
    expect(await screen.findByText("Every request about this jar, oldest first, including the ones the rule refused.")).toBeTruthy();
    expect(screen.getByText("Every Bitcoin transaction at every address the jar has used, newest first.")).toBeTruthy();
  });
});
