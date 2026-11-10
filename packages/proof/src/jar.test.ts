import { describe, expect, test } from "vitest";
import { createProofReader, JarNotFoundError } from "./index.ts";
import { evidence, fixture, replayFetch } from "./test-fetch.ts";

const record = evidence();
const reader = createProofReader({ contract: record.contract, fetch: replayFetch(fixture("near-views")) });

// T06's reading of the jar, its coins and its payment after the allowance was confirmed.
const after = record.steps.find((s) => s.step === "jar after confirm_payment") as unknown as {
  jar: {
    address: string;
    owner_id: string;
    giver: string;
    witness_script: string;
    public_key: string;
    locktime: number;
    create_args: { guardians: string[]; family_account: string; nickname: string; child_address: string };
  };
  coins: { txid: string; vout: number; value: string; status: string; payment_id: string | null }[];
  payment: { payment_id: string; status: string; txid: string; amount: string; fee: string; change: string };
};
const payTx = record.steps.find((s) => s.step.startsWith("allowance payment (broadcast"));

describe("a jar's contract views", () => {
  test("reads the jar after the money moment: address, balance, coins, payment, history and NFT", async () => {
    const jar = await reader.jar("1");

    expect(jar.jarId).toBe("1");
    expect(jar.nickname).toBe(after.jar.create_args.nickname);
    expect(jar.holder).toBe(after.jar.owner_id);
    expect(jar.giver).toBe(after.jar.giver);
    expect(jar.familyAccount).toBe(after.jar.create_args.family_account);
    expect(jar.guardians).toEqual(after.jar.create_args.guardians);
    expect(jar.childAddress).toBe(after.jar.create_args.child_address);
    expect(jar.address).toBe(after.jar.address);
    expect(jar.addressExplorerUrl).toBe(`https://mempool.space/testnet/address/${after.jar.address}`);
    expect(jar.witnessScript).toBe(after.jar.witness_script);
    expect(jar.publicKey).toBe(after.jar.public_key);
    expect(jar.locktime).toBe(after.jar.locktime);
    expect(jar.cap).toBe(2_500);
    expect(jar.period).toBe(86_400);
    expect(jar.demoTiming).toBe(true);
    expect(jar.provenBalance).toBe(record.ledger.left_in_jar);
    expect(jar.handover).toBe("none");

    expect(jar.coins).toEqual(
      after.coins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        value: Number(c.value),
        status: c.status,
        paymentId: c.payment_id,
        explorerUrl: `https://mempool.space/testnet/tx/${c.txid}`,
      })),
    );

    expect(jar.payments).toHaveLength(1);
    expect(jar.payments[0]).toMatchObject({
      paymentId: after.payment.payment_id,
      kind: "allowance",
      status: after.payment.status,
      txid: after.payment.txid,
      amount: Number(after.payment.amount),
      fee: Number(after.payment.fee),
      change: Number(after.payment.change),
      failure: null,
      explorerUrl: payTx?.explorer,
    });

    expect(jar.history.map((h) => h.event)).toEqual([
      "jar_created",
      "topup_proven",
      "topup_proven",
      "allowance_requested",
      "payment_signed",
      "payment_confirmed",
    ]);
    expect(jar.history[1]).toMatchObject({ txid: record.topup?.txid, vout: 0, value: 2_000 });
    expect(jar.history[3]).toMatchObject({ paymentId: "1" });

    expect(jar.nft.title).toBe("Sats Jar #1");
    expect(jar.nft.media.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  test("refuses a jar that does not exist", async () => {
    await expect(reader.jar("99")).rejects.toThrow(JarNotFoundError);
  });
});
