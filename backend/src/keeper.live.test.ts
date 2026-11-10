// The keeper's adapters against testnet; skipped unless LIVE_TESTNET=1.
//   LIVE_TESTNET=1 KEEPER_ACCOUNT_ID=... KEEPER_PRIVATE_KEY=... pnpm vitest run backend/src/keeper.live.test.ts
// The recordings in fixtures/ were taken with curl; here the adapters must read the same.
import { describe, expect, it } from "vitest";
import { esplora } from "./bitcoin.ts";
import { nearKeeperChain, type CoinView, type JarView, type PaymentView } from "./chain.ts";
import { fixture, PAYMENT_TXID, TOPUP_TXID } from "./keeper.fakes.ts";

const live = process.env.LIVE_TESTNET === "1";

describe.skipIf(!live)("keeper adapters on testnet", () => {
  // Built only when the suite runs: a skipped run has no keeper key.
  const chain = live
    ? nearKeeperChain({
        keeperAccountId: process.env.KEEPER_ACCOUNT_ID ?? "",
        keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY ?? "",
        contractAccountId: "sats-jar-dev.testnet",
      })
    : (undefined as never);
  const bitcoin = esplora();

  it("reads dev jar 1, its coins and payment 1 as recorded", async () => {
    const recorded = fixture<JarView>("near-get-jar-1.json");
    const jar = await chain.jar("1");

    expect(jar).toMatchObject({ address: recorded.address, create_args: recorded.create_args, clock: recorded.clock });
    expect(await chain.coins("1")).toEqual(fixture<CoinView[]>("near-get-coins-1.json"));
    expect(await chain.payment("1")).toEqual(fixture<PaymentView>("near-get-payment-1.json"));
    expect(await chain.payment("999999")).toBeUndefined();
    expect(await chain.jarCount()).toBeGreaterThanOrEqual(3);
    expect(await chain.lightClientTip()).toBeGreaterThanOrEqual(5_323_140);
    expect(await chain.blockHeight()).toBeGreaterThan(277_000_000);
  });

  it("reads T06's top-up and payment from Esplora as recorded", async () => {
    const status = await bitcoin.status(PAYMENT_TXID);

    expect(status).toMatchObject(fixture<object>("esplora-status-payment.json"));
    expect(await bitcoin.status(TOPUP_TXID)).toMatchObject(fixture<object>("esplora-status-topup.json"));
    expect(await bitcoin.txHex(TOPUP_TXID)).toBe(fixture("esplora-hex-topup.txt"));
    expect(await bitcoin.blockTxids(status.block_hash ?? "")).toEqual(fixture("esplora-txids-payment-block.json"));
    expect(await bitcoin.outputs(fixture<JarView>("near-get-jar-1.json").address)).toEqual(
      fixture("esplora-utxo-jar-1.json"),
    );
    expect(await bitcoin.minimumFee()).toBeGreaterThanOrEqual(1);
  });

  it("a real refusal comes back with the contract's code", async () => {
    const outcome = await chain.call("retry_signing", { payment_id: "1" }, 80);

    expect(outcome).toMatchObject({ ok: false, code: "PAYMENT_ALREADY_CONFIRMED", message: "this payment is already confirmed" });
  }, 60_000);
});
