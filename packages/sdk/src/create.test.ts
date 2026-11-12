import { describe, expect, test } from "vitest";
import { FULL_PERIOD, SatsJarRefusal } from "./api.ts";
import { createApp } from "./app.ts";
import {
  BACKEND,
  CONTRACT,
  fixture,
  memoryStorage,
  recorded,
  testNetwork,
  type SendTx,
  type TestNetwork,
} from "./test-network.ts";

// Live recordings (src/fixtures/near.json): T15's create_jar that made jar 3, T06's refused
// request_allowance, and a send_tx the chain rejected before it ran.
const created = recorded("near", (b) => b.method === "tx" && b.params.tx_hash === "EzMfNipDDPKfNm4cEtuGyQhF2TysNFhxL9rVeXPY55f9");
const alreadyPaid = recorded("near", (b) => b.method === "tx" && b.params.tx_hash === "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP");
const rejected = recorded("near", (b) => b.method === "send_tx");
const jar3 = JSON.parse(
  new TextDecoder().decode(
    Uint8Array.from(
      (recorded("near", (b) => b.params.method_name === "get_jar" && b.params.args_base64 === btoa('{"jar_id":"3"}')) as {
        result: { result: number[] };
      }).result.result,
    ),
  ),
) as { address: string; create_args: Record<string, unknown> };
/** The send's answer never arrives (the connection drops after the transaction left). */
const lost = (): never => {
  throw new Error("connection reset");
};

const CHILD = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"; // T07's public test-phrase address
const UNLOCK = 2_208_988_800; // 2040-01-01

/** A giver with a draft both guardians joined. `send` answers each send_tx. */
async function readyGiver(send: SendTx, extra: Parameters<typeof testNetwork>[0] = {}) {
  let net: TestNetwork | undefined;
  const sendTx: SendTx = (call, attempt) => {
    const answer = send(call, attempt);
    if ((answer as { result?: { status?: { SuccessValue?: string } } }).result?.status?.SuccessValue === "IjMi") {
      net?.jars.set("3", call.args.guardians as string[]);
    }
    return answer;
  };
  net = testNetwork({ ...extra, sendTx });
  const app = (storage = memoryStorage()) => createApp({ contract: CONTRACT, backendUrl: BACKEND, storage }, net.fetch);
  // The giver's storage can be told to fail its writes (a full or broken device store).
  const store = memoryStorage();
  let failWrites = 0;
  const giver = app({
    ...store,
    set: async (k, v) => {
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error("quota exceeded");
      }
      await store.set(k, v);
    },
  });
  /** The giver's next `writes` storage writes fail. */
  const breakStorage = (writes: number) => {
    failWrites = writes;
  };
  await giver.device.setUp({ pin: "482913" });
  const draft = await giver.invites.start({ nickname: "Sunny's jar", guardians: 2 });
  const guardians: string[] = [];
  for (const token of draft.inviteTokens) {
    const guardian = app();
    await guardian.device.setUp({ pin: "111111" });
    const before = new Set(net.accounts.keys());
    await guardian.invites.join(token);
    guardians.push([...net.accounts.keys()].find((a) => !before.has(a)) ?? "");
  }
  const input = { draftId: draft.draftId, childAddress: CHILD, cap: 20_000, period: FULL_PERIOD, unlockAt: UNLOCK };
  return { net, giver, draft, guardians, input, breakStorage };
}

describe("creating a jar", () => {
  test("sends create_jar from the giver's own account with the draft's guardians, then closes the draft", async () => {
    const { net, giver, draft, guardians, input } = await readyGiver(() => created);

    const jar = await giver.jars.create(input);

    expect(jar).toEqual({ jarId: "3", address: jar3.address, qrPayload: `bitcoin:${jar3.address}` });
    expect(net.sent).toHaveLength(1);
    const call = net.sent[0];
    const giverAccount = [...net.accounts].find(([, key]) => key === call?.publicKey)?.[0];
    expect(call).toMatchObject({
      signerId: giverAccount,
      receiverId: CONTRACT,
      method: "create_jar",
      gas: 30_000_000_000_000n,
      deposit: 20_000_000_000_000_000_000_000n, // 0.02 NEAR; the contract refunds the rest
      args: {
        child_address: CHILD,
        cap: "20000",
        period: "2592000",
        unlock_at: String(UNLOCK),
        guardians,
        family_account: giverAccount,
        nickname: "Sunny's jar",
      },
    });
    expect((await giver.invites.mine())[0]?.jarId).toBe("3");
    await expect(giver.invites.progress(draft.draftId)).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  test("a retry after the draft failed to close sends nothing and returns the same jar", async () => {
    let net: TestNetwork | undefined;
    const ready = await readyGiver(() => {
      net?.breakBackend(1); // the close after this send fails
      return created;
    });
    net = ready.net;

    await expect(ready.giver.jars.create(ready.input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await ready.giver.jars.create(ready.input)).jarId).toBe("3");
    expect(ready.net.sent).toHaveLength(1);
  });

  test("a retry after a lost answer finds the first transaction's outcome and sends nothing new", async () => {
    let landed = false;
    const { net, giver, input } = await readyGiver(
      () => {
        landed = true;
        return lost();
      },
      { txStatus: () => (landed ? created : undefined) },
    );

    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    net.jars.set("3", net.sent[0]?.args.guardians as string[]);
    expect((await giver.jars.create(input)).jarId).toBe("3");
    expect(net.sent).toHaveLength(1);
  });

  test("a storage failure while settling a retry stops it; it never signs a second create_jar", async () => {
    let landed = false;
    const { net, giver, input, breakStorage } = await readyGiver(
      () => {
        landed = true;
        return lost();
      },
      { txStatus: () => (landed ? created : undefined) },
    );
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });

    breakStorage(1); // the write that records the found jar id fails
    await expect(giver.jars.create(input)).rejects.toThrow();
    expect(net.sent).toHaveLength(1);

    net.jars.set("3", net.sent[0]?.args.guardians as string[]);
    expect((await giver.jars.create(input)).jarId).toBe("3");
    expect(net.sent).toHaveLength(1);
  });

  test("a retry the chain never saw resends the same signed bytes, never a new signing", async () => {
    const { net, giver, input } = await readyGiver((_, attempt) => (attempt === 1 ? lost() : created));

    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await giver.jars.create({ ...input, cap: 30_000 })).jarId).toBe("3");
    expect(net.sent).toHaveLength(2);
    expect(net.sent[1]?.signedTx).toBe(net.sent[0]?.signedTx);
  });

  test("when the old bytes can no longer land, a jar with the same create args is taken instead of minting", async () => {
    // Synthetic views, labelled: T15's recorded jar 3, with the first attempt's create args.
    const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
    const { net, giver, input } = await readyGiver((_, attempt) => (attempt === 1 ? lost() : rejected), { views });
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const first = net.sent[0];
    net.jars.set("3", first?.args.guardians as string[]);
    views.push(
      { method: "nft_tokens_for_owner", args: { account_id: first?.signerId, from_index: "0", limit: 50 }, result: [{ token_id: "3" }] },
      { method: "get_jar", args: { jar_id: "3" }, result: { ...jar3, create_args: first?.args } },
    );

    expect((await giver.jars.create(input)).jarId).toBe("3");
    expect(net.sent).toHaveLength(2); // the first bytes, resent once; nothing newly signed
    expect(net.sent[1]?.signedTx).toBe(first?.signedTx);
  });

  test("bytes now rejected that only the full-history indexer saw land give their jar; nothing is minted again", async () => {
    // FastNEAR's live row for this very create_jar (T15's, which made jar 3), served under the
    // retried bytes' hash (labelled): RPC has forgotten it, so only the indexer knows it landed.
    const row = (fixture("part2-live").exchanges.find((e) => JSON.stringify(e.request.body).includes("EzMfNip"))?.response.body as {
      transactions: { transaction: Record<string, unknown> }[];
    }).transactions[0];
    let landed = false;
    const { net, giver, input } = await readyGiver(
      (_, attempt) => {
        if (attempt === 1) {
          landed = true;
          return lost();
        }
        return rejected;
      },
      { indexed: (hash) => (landed && row ? { ...row, transaction: { ...row.transaction, hash } } : undefined) },
    );
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    net.jars.set("3", net.sent[0]?.args.guardians as string[]);

    expect((await giver.jars.create(input)).jarId).toBe("3");
    expect(net.signings()).toBe(1);
  });

  test("a jar of the giver's with other create args is not taken; the new create is signed afresh", async () => {
    const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
    const { net, giver, input } = await readyGiver(
      (_, attempt) => (attempt === 1 ? lost() : attempt === 2 ? rejected : created),
      { views },
    );
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const first = net.sent[0];
    views.push(
      { method: "nft_tokens_for_owner", args: { account_id: first?.signerId, from_index: "0", limit: 50 }, result: [{ token_id: "3" }] },
      { method: "get_jar", args: { jar_id: "3" }, result: { ...jar3, create_args: { ...first?.args, cap: "25000" } } },
    );

    expect((await giver.jars.create({ ...input, cap: 30_000 })).jarId).toBe("3");
    expect(net.sent).toHaveLength(3); // first bytes, the same bytes resent, then a new signing
    expect(net.sent[1]?.signedTx).toBe(first?.signedTx);
    expect(net.sent[2]?.args).toEqual({ ...first?.args, cap: "30000" });
  });
});

describe("create refusals", () => {
  test("the contract's refusal comes back typed and readable, with the refused transaction's link", async () => {
    // T06's live ALREADY_PAID refusal: the same outcome shape every contract refusal has.
    const { giver, input } = await readyGiver(() => alreadyPaid);
    const refusal = await giver.jars.create(input).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SatsJarRefusal);
    expect(refusal).toMatchObject({
      code: "ALREADY_PAID",
      message: "This period's allowance has already been paid.",
      explorerUrl: "https://testnet.nearblocks.io/txns/HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP",
    });
  });

  test("a transaction the chain rejects before it runs is TRANSACTION_FAILED, and a retry signs afresh", async () => {
    const { net, giver, input } = await readyGiver((_, attempt) => (attempt === 1 ? rejected : created));
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect((await giver.jars.create({ ...input, cap: 30_000 })).jarId).toBe("3");
    expect(net.sent.map((c) => c.args.cap)).toEqual(["20000", "30000"]); // signed afresh with the new input
  });

  test("creating needs an unlocked device and a draft this device started", async () => {
    const { net, giver, input } = await readyGiver(() => created);
    await expect(giver.jars.create({ ...input, draftId: "someone-elses" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
    giver.device.lock();
    await expect(giver.jars.create(input)).rejects.toMatchObject({ code: "LOCKED" });
    expect(net.sent).toHaveLength(0);
  });
});
