import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SatsJarRefusal } from "./api.ts";
import { createApp } from "./app.ts";
import { BACKEND, CONTRACT, fixture, memoryStorage, testNetwork, type Fixture, type TestNetwork } from "./test-network.ts";

// T06's record of the live money moment on jar 1 (the oracle), and the live views and Esplora
// pages T20 recorded after it (src/fixtures/proof-*.json).
const evidence = JSON.parse(readFileSync(new URL("../../../evidence/dev-money-moment.json", import.meta.url), "utf8")) as {
  ledger: Record<string, number>;
  steps: { step: string; jar?: Record<string, unknown> }[];
};
const jar1 = evidence.steps.find((s) => s.step === "jar after confirm_payment")?.jar as {
  address: string;
  locktime: number;
  create_args: { child_address: string; nickname: string; unlock_at: string; guardians: string[] };
};
const ADDRESS = jar1.address;
const TOPUP = "2edba4ef7d19b83c9d4eae99329abda471f029e99b93376c1881953a2ac0a9ea";
const ALLOWANCE = "4016901c16ce105d6c6b44531406ac8e4942cb9177698c4b3be7aa939b00e69c";
const recordings = [fixture("proof-near-views"), fixture("proof-bitcoin-jar1"), fixture("bitcoin-tip")];
const TIP = fixture("bitcoin-tip").exchanges[0]?.response.body as number;

function app(net: TestNetwork) {
  return createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: memoryStorage() }, net.fetch);
}

/** A device with an account: it joins an invite, as a guardian does. */
async function withAccount(net: TestNetwork) {
  const someone = app(net);
  await someone.device.setUp({ pin: "482913" });
  const draft = await someone.invites.start({ nickname: "x", guardians: 2 });
  await someone.invites.join(draft.inviteTokens[0] ?? "");
  const account = [...net.accounts.keys()][0] ?? "";
  return { someone, account };
}

/** The recorded get_jar of jar 1, its JSON answer decoded. */
function recordedJar1(): Record<string, unknown> {
  const hit = fixture("proof-near-views").exchanges.find((e) => {
    const params = (e.request.body as { params: { method_name: string } }).params;
    return params.method_name === "get_jar";
  });
  const bytes = (hit?.response.body as { result: { result: number[] } }).result.result;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Record<string, unknown>;
}

describe("jar status", () => {
  test("shows jar 1 as the money moment left it: address, QR, balance, picture, allowance, exit", async () => {
    const status = await app(testNetwork({ fixtures: recordings })).jars.status("1");
    const view = recordedJar1();

    expect(status).toMatchObject({
      jarId: "1",
      nickname: jar1.create_args.nickname,
      roles: [],
      address: ADDRESS,
      qrPayload: `bitcoin:${ADDRESS}`,
      balance: evidence.ledger.left_in_jar,
      childAddress: jar1.create_args.child_address,
      cap: 2_500,
      period: 86_400,
      unlockAt: Number(jar1.create_args.unlock_at),
      demoTiming: true,
      availableAllowance: Number(view.available_allowance),
      nextAllowanceAt: Number(view.next_allowance_at),
      handover: { state: "none" },
      emergency: { state: "none" },
      transfer: { state: "none" },
    });
    expect(status.picture).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(status.exit.opensAt).toBe(jar1.locktime);
    expect(status.exit.childAddress).toBe(jar1.create_args.child_address);
    expect(status.exit.note).toContain(new Date(jar1.locktime * 1000).toISOString().slice(0, 10));
    expect(status.exit.note).toMatch(/no handover/);
  });

  test("names the viewer's roles: giver, guardian, holder, and the child once they claimed", async () => {
    const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
    const net = testNetwork({ fixtures: recordings, views });
    const { someone, account } = await withAccount(net);
    // Synthetic, labelled: jar 1's live view with this device's account as giver, guardian and holder.
    const view = recordedJar1();
    const args = view.create_args as Record<string, unknown>;
    views.push({
      method: "get_jar",
      args: { jar_id: "1" },
      result: { ...view, giver: account, owner_id: account, create_args: { ...args, guardians: [account, "other.testnet"] } },
    });
    expect((await someone.jars.status("1")).roles).toEqual(["giver", "guardian", "holder"]);

    // A claim by this account (T08's view shape, findings-t08).
    views[0] = {
      method: "get_jar",
      args: { jar_id: "1" },
      result: {
        ...view,
        handover: { claimed: { child_account: account, child_btc_pubkey: "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319", claimed_at: "1794269000", lapses_at: "1794269420", confirmed_by: ["guardian-a.sats-jar-dev.testnet"] } },
      },
    };
    const claimed = await someone.jars.status("1");
    expect(claimed.roles).toEqual(["child"]);
    expect(claimed.handover).toMatchObject({ state: "claimed", claimedAt: 1794269000, lapsesAt: 1794269420, confirmations: 1, confirmedByMe: false });
  });

  test("shows an open emergency proposal with one approval and no delay yet", async () => {
    // Synthetic, labelled: jar 1's live view with T13's emergency field (t13 worktree, EmergencyView).
    const view = recordedJar1();
    const net = testNetwork({
      fixtures: recordings,
      views: [{ method: "get_jar", args: { jar_id: "1" }, result: { ...view, emergency: { open: { proposal_id: 2, amount: "5000", approved_by: ["guardian-a.sats-jar-dev.testnet"], proposed_at: "1794270000", delay_ends_at: null } } } }],
    });
    expect((await app(net).jars.status("1")).emergency).toEqual({
      state: "open",
      proposalId: 2,
      amount: 5_000,
      approvals: 1,
      approvedByMe: false,
      proposedAt: 1794270000,
      delayEndsAt: null,
    });
  });

  describe("the handover, emergency and transfer, in the real contract's view shapes", () => {
    // The real contract's part-2 fields (src/fixtures/sandbox-views.json), put on jar 1's live
    // view (synthetic, labelled): the sandbox names (*.test.near) stand for this jar's people.
    const sandbox = (JSON.parse(readFileSync(new URL("./fixtures/sandbox-views.json", import.meta.url), "utf8")) as {
      views: Record<string, Record<string, unknown>>;
    }).views;
    const part2 = (from: string) => {
      const { handover, emergency, transfer, locktime } = sandbox[from] ?? {};
      return { handover, emergency, transfer, locktime };
    };
    async function statusWith(fields: Record<string, unknown>, me?: (account: string) => Record<string, unknown>) {
      const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
      const net = testNetwork({ fixtures: recordings, views });
      const { someone, account } = await withAccount(net);
      views.push({ method: "get_jar", args: { jar_id: "1" }, result: { ...recordedJar1(), ...fields, ...(me?.(account) ?? {}) } });
      return someone.jars.status("1");
    }

    test("confirmed: the public delay's end; then completing: the re-homing's progress", async () => {
      expect((await statusWith(part2("handover_confirmed"))).handover).toEqual({
        state: "confirmed",
        claimedAt: 1794288056,
        delayEndsAt: 1794288236,
        confirmedByMe: false,
        pausesAllowancesEarly: true, // the delay ends long before jar 1's unlock date
      });
      expect((await statusWith(part2("handover_completing"))).handover).toEqual({ state: "completing", coinsToMove: 0, coinsLeft: 2 });
    });

    test("done: the exit now answers only to the holder's recovery phrase (story 62), from the new address's locktime", async () => {
      const fields = part2("handover_done");
      const status = await statusWith(fields);
      expect(status.handover).toEqual({ state: "done", completedAt: 1794288545 });
      expect(status.exit.opensAt).toBe(fields.locktime);
      expect(status.exit.note).toMatch(/recovery phrase/);
      expect(status.exit.note).not.toMatch(/parent/);
    });

    test("a transfer offered to this device, then moving to it coin by coin", async () => {
      const toMe = (key: "started" | "accepted") => (account: string) => {
        const transfer = sandbox[key === "started" ? "transfer_started" : "transfer_accepted"]?.transfer as Record<string, Record<string, unknown>>;
        return { transfer: { [key]: { ...transfer[key], receiver: account } } };
      };
      expect((await statusWith(part2("transfer_started"), toMe("started"))).transfer).toEqual({ state: "offered", toMe: true });
      expect((await statusWith(part2("transfer_accepted"), toMe("accepted"))).transfer).toEqual({
        state: "moving",
        toMe: true,
        coinsToMove: 0,
        coinsLeft: 1,
      });
      expect((await statusWith(part2("transfer_started"))).transfer).toEqual({ state: "offered", toMe: false });
    });

    test("an emergency proposal with two approvals shows when its public delay ends; a cancelled one says so", async () => {
      expect((await statusWith(part2("emergency_open_2"))).emergency).toEqual({
        state: "open",
        proposalId: 1,
        amount: 2_000,
        approvals: 2,
        approvedByMe: false,
        proposedAt: 1794288054,
        delayEndsAt: 1794289854,
      });
      expect((await statusWith(part2("emergency_cancelled"))).emergency).toEqual({ state: "cancelled", proposalId: 1 });
    });
  });

  test("a view the reader cannot make sense of reads as UNAVAILABLE, never the raw error", async () => {
    // Synthetic, labelled: a get_jar answer missing its fields.
    const net = testNetwork({ fixtures: recordings, views: [{ method: "get_jar", args: { jar_id: "1" }, result: { jar_id: "1" } }] });
    const refusal = await app(net).jars.status("1").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SatsJarRefusal);
    expect(refusal).toMatchObject({ code: "UNAVAILABLE" });
  });

  test("an unknown jar is refused as UNKNOWN_JAR", async () => {
    await expect(app(testNetwork({ fixtures: recordings })).jars.status("99")).rejects.toMatchObject({ code: "UNKNOWN_JAR" });
  });
});

describe("top-ups", () => {
  test("lists jar 1's two counted top-ups, newest first, and not the allowance's change", async () => {
    const topUps = await app(testNetwork({ fixtures: recordings })).jars.topUps("1");
    expect(topUps).toEqual([
      { txid: TOPUP, value: 2_000, status: "counted", confirmations: null, countedAt: 1794269175, explorerUrl: `https://mempool.space/testnet/tx/${TOPUP}` },
      { txid: TOPUP, value: 2_000, status: "counted", confirmations: null, countedAt: 1794269169, explorerUrl: `https://mempool.space/testnet/tx/${TOPUP}` },
    ]);
    expect(topUps.map((t) => t.txid)).not.toContain(ALLOWANCE);
  });

  test("shows top-ups still on the way, confirming with their count, and too small to count", async () => {
    // Synthetic, labelled: three Esplora transactions to jar 1's address ahead of the live page.
    const live = fixture("proof-bitcoin-jar1");
    const firstPage = live.exchanges[0];
    if (!firstPage) throw new Error("no page");
    const pay = (txid: string, value: number, height: number | null) => ({
      txid,
      fee: 150,
      status: height === null ? { confirmed: false } : { confirmed: true, block_height: height, block_time: 1794270000 },
      vin: [{ prevout: { scriptpubkey_address: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", value: value + 5_000 } }],
      vout: [{ scriptpubkey_address: ADDRESS, value }],
    });
    const synthetic: Fixture = {
      recorded_at: live.recorded_at,
      note: "synthetic",
      exchanges: [
        {
          request: firstPage.request,
          response: {
            status: 200,
            body: [pay("aa".repeat(32), 5_000, null), pay("bb".repeat(32), 3_000, TIP - 1), pay("cc".repeat(32), 600, null), ...(firstPage.response.body as unknown[])],
          },
        },
      ],
    };
    const topUps = await app(testNetwork({ fixtures: [synthetic, ...recordings] })).jars.topUps("1");
    expect(topUps.slice(0, 3)).toEqual([
      { txid: "aa".repeat(32), value: 5_000, status: "on_the_way", confirmations: null, countedAt: null, explorerUrl: `https://mempool.space/testnet/tx/${"aa".repeat(32)}` },
      { txid: "bb".repeat(32), value: 3_000, status: "confirming", confirmations: 2, countedAt: null, explorerUrl: `https://mempool.space/testnet/tx/${"bb".repeat(32)}` },
      { txid: "cc".repeat(32), value: 600, status: "too_small", confirmations: null, countedAt: null, explorerUrl: `https://mempool.space/testnet/tx/${"cc".repeat(32)}` },
    ]);
    expect(topUps).toHaveLength(5);
  });
});

describe("allowances", () => {
  test("lists jar 1's confirmed allowance with its fee, time and Bitcoin link", async () => {
    expect(await app(testNetwork({ fixtures: recordings })).jars.allowances("1")).toEqual([
      {
        amount: evidence.ledger.allowance_received,
        fee: evidence.ledger.allowance_fee_from_jar,
        status: "confirmed",
        requestedAt: 1794269187,
        explorerUrl: `https://mempool.space/testnet/tx/${ALLOWANCE}`,
      },
    ]);
  });
});

describe("allowance status", () => {
  test("a payment status this SDK does not know reads as UNAVAILABLE, not an unchecked value", async () => {
    // Synthetic, labelled: jar 1's live payment with a status no contract version has.
    const live = fixture("proof-near-views").exchanges.find(
      (e) => (e.request.body as { params: { method_name: string } }).params.method_name === "get_payment",
    );
    const payment = JSON.parse(new TextDecoder().decode(Uint8Array.from((live?.response.body as { result: { result: number[] } }).result.result))) as Record<string, unknown>;
    const net = testNetwork({ fixtures: recordings, views: [{ method: "get_payment", args: { payment_id: "1" }, result: { ...payment, status: "replaced" } }] });
    await expect(app(net).jars.allowances("1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("my jars", () => {
  test("lists the jars this device's person guards, from every jar on the contract", async () => {
    const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
    const net = testNetwork({ views });
    const { someone, account } = await withAccount(net);
    // Synthetic, labelled: the live jar 2 with this device's account added as a guardian.
    const jar2 = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          (fixture("near").exchanges.find((e) => (e.request.body as { params: { args_base64?: string } }).params.args_base64 === btoa('{"jar_id":"2"}'))
            ?.response.body as { result: { result: number[] } }).result.result,
        ),
      ),
    ) as { create_args: Record<string, unknown>; proven_balance: string; demo_timing: boolean };
    views.push({ method: "get_jar", args: { jar_id: "2" }, result: { ...jar2, create_args: { ...jar2.create_args, guardians: ["x.testnet", account] } } });

    const mine = await someone.jars.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      jarId: "2",
      nickname: jar2.create_args.nickname,
      roles: ["guardian"],
      balance: Number(jar2.proven_balance),
      demoTiming: jar2.demo_timing,
    });
    expect(mine[0]?.picture).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  test("a device with no account yet has no jars", async () => {
    const net = testNetwork({});
    const fresh = app(net);
    await fresh.device.setUp({ pin: "482913" });
    expect(await fresh.jars.mine()).toEqual([]);
  });
});
