// Testnet check of T16 (koukikouks/sats-jar#19): a fresh demo jar on the dev contract gets one
// giver top-up, and the keeper, pressed through a running backend's POST /keeper/run, proves
// it, requests the allowance, broadcasts it and confirms it. Every step goes to
// evidence/keeper-run.json.
//
//   node --env-file=<.env with the giver wallet> backend/src/verify-keeper.ts <step> [backend url]
//   steps: create-jar, topup, press <url>, close
//
// The env supplies DEMO_GIVER_BTC_ADDRESS and DEMO_GIVER_BTC_WIF (read only inside giverKey,
// never printed or written), KEEPER_ACCOUNT_ID and CONTRACT_ACCOUNT_ID. The jar is created by
// the dev account with the key near-cli keeps in ~/.near-credentials.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as btc from "@scure/btc-signer";
import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { esplora } from "./bitcoin.ts";
import { outcomeOf } from "./chain.ts";
import { NEAR_RPC } from "./rpc.ts";

const CONTRACT = process.env.CONTRACT_ACCOUNT_ID ?? "";
const KEEPER = process.env.KEEPER_ACCOUNT_ID ?? "";
const EVIDENCE = new URL("../../evidence/keeper-run.json", import.meta.url);
const NET = btc.TEST_NETWORK;
const bitcoin = esplora();
const provider = new JsonRpcProvider({ url: NEAR_RPC });

// The approved run (t16-plan.md): cap 3,000 and one 3,000-sat top-up, so the allowance pays the
// whole jar minus its fee with no change; a one-hour period (demo timing).
const CAP = 3_000n;
const TOPUP = 3_000n;
const PERIOD = 3_600;
// T06's gates: fee rate 1, a fee of at most 300 sats, at most 5,000 sats leaving the wallet.
const FEE_RATE = 1n;
const MAX_TOPUP_FEE = 300n;
const MAX_SPEND = 5_000n;
/** The giver coin to spend (T06 left two; this is the large one). */
const GIVER_COIN_VALUE = 305_067;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Evidence = { [key: string]: Json };

function evidence(): Evidence {
  if (!existsSync(EVIDENCE)) {
    return {
      about:
        "Testnet run of T16 (koukikouks/sats-jar#19): the keeper, pressed through POST /keeper/run, proves a top-up, requests the allowance, broadcasts and confirms it on a fresh demo jar of the dev contract. Written by backend/src/verify-keeper.ts.",
      contract: CONTRACT,
      keeper: KEEPER,
      steps: [],
    };
  }
  return JSON.parse(readFileSync(EVIDENCE, "utf8")) as Evidence;
}

function save(data: Evidence): void {
  writeFileSync(EVIDENCE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Appends one entry, written at once so a crash keeps it. */
function record(entry: { [key: string]: Json }): void {
  const data = evidence();
  (data.steps as Json[]).push({ at: new Date().toISOString(), ...entry });
  save(data);
}

function set(key: string, value: Json): void {
  const data = evidence();
  data[key] = value;
  save(data);
}

async function view<T>(method: string, args: Record<string, unknown>, contractId = CONTRACT): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

function giverAddress(): string {
  const address = process.env.DEMO_GIVER_BTC_ADDRESS;
  if (!address) throw new Error("DEMO_GIVER_BTC_ADDRESS is not set (pass --env-file)");
  return address;
}

/** The giver's private key. Any failure is reported without the WIF in it. */
function giverKey(): Uint8Array {
  let key: Uint8Array;
  try {
    key = btc.WIF(NET).decode(process.env.DEMO_GIVER_BTC_WIF ?? "");
  } catch {
    throw new Error("DEMO_GIVER_BTC_WIF is missing or not a testnet WIF");
  }
  if (btc.getAddress("wpkh", key, NET) !== giverAddress()) {
    throw new Error("DEMO_GIVER_BTC_WIF does not belong to DEMO_GIVER_BTC_ADDRESS");
  }
  return key;
}

function outScript(address: string): string {
  return bytesToHex(btc.OutScript.encode(btc.Address(NET).decode(address)));
}

async function createJar(): Promise<void> {
  if (evidence().jar) throw new Error("the jar exists already");
  const file = join(homedir(), ".near-credentials", "testnet", `${CONTRACT}.json`);
  const key = (JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString }).private_key;
  const dev = new Account(CONTRACT, provider, KeyPairSigner.fromSecretKey(key));
  const now = Math.floor(Date.now() / 1000);
  const args = {
    child_address: giverAddress(),
    cap: String(CAP),
    period: String(PERIOD),
    unlock_at: String(now + 2 * 86_400),
    guardians: [`guardian-a.${CONTRACT}`, `guardian-b.${CONTRACT}`],
    family_account: CONTRACT,
    nickname: "Keeper check",
  };
  const response = await dev.signAndSendTransaction({
    receiverId: CONTRACT,
    // 0.1 NEAR for the jar's storage; the contract refunds the rest.
    actions: [actions.functionCall("create_jar", args, 100n * 10n ** 12n, 10n ** 23n)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const outcome = outcomeOf(response);
  record({ step: "create_jar", near_tx: outcome.hash, sent: args, outcome: outcome as unknown as Json });
  if (!outcome.ok) throw new Error(`create_jar refused: ${outcome.code} ${outcome.message}`);
  const jarId = String(outcome.value);
  const jar = await view<{ address: string; demo_timing: boolean }>("get_jar", { jar_id: jarId });
  set("jar", { jar_id: jarId, address: jar.address, demo_timing: jar.demo_timing });
}

async function topup(): Promise<void> {
  const data = evidence();
  // Gate: one top-up only; a second needs the maintainer.
  if (data.topup) throw new Error(`a top-up was already made (${JSON.stringify(data.topup)})`);
  const jar = data.jar as { address: string } | undefined;
  if (!jar) throw new Error("run the create-jar step first");
  const key = giverKey();
  const giver = giverAddress();

  // Gate: the fee floor allows 1 sat/vB.
  const minimumFee = await bitcoin.minimumFee();
  if (minimumFee > Number(FEE_RATE)) throw new Error(`minimumFee is ${minimumFee} sat/vB; wait for 1`);

  const coin = (await bitcoin.outputs(giver)).find((o) => o.value === GIVER_COIN_VALUE && o.status.confirmed);
  if (!coin) throw new Error(`the giver's confirmed ${GIVER_COIN_VALUE}-sat coin is not there`);
  const input = BigInt(coin.value);
  const giverScript = btc.OutScript.encode(btc.Address(NET).decode(giver));
  const build = (fee: bigint) => {
    const tx = new btc.Transaction();
    tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script: giverScript, amount: input } });
    tx.addOutputAddress(jar.address, TOPUP, NET);
    tx.addOutputAddress(giver, input - TOPUP - fee, NET);
    tx.sign(key);
    tx.finalize();
    return tx;
  };
  const fee = BigInt(build(0n).vsize) * FEE_RATE;
  const signed = btc.Transaction.fromRaw(build(fee).extract());

  // Gate: exactly the giver coin in; exactly the top-up to the jar and the change home out.
  const outs = Array.from({ length: signed.outputsLength }, (_, i) => signed.getOutput(i));
  const firstInput = signed.getInput(0);
  const change = outs[1]?.amount ?? 0n;
  const paid = input - TOPUP - change;
  const exact =
    signed.inputsLength === 1 &&
    firstInput.txid !== undefined &&
    bytesToHex(firstInput.txid) === coin.txid &&
    firstInput.index === coin.vout &&
    outs.length === 2 &&
    outs[0]?.amount === TOPUP &&
    bytesToHex(outs[0]?.script ?? new Uint8Array()) === outScript(jar.address) &&
    bytesToHex(outs[1]?.script ?? new Uint8Array()) === outScript(giver);
  // Gates: fee at most 300 sats; the change at least the input minus 5,000.
  if (!exact || paid > MAX_TOPUP_FEE || change < input - MAX_SPEND) {
    throw new Error("the signed top-up failed its gate; nothing was broadcast");
  }

  // Gate: the txid is in the evidence before the broadcast.
  const txid = signed.id;
  set("topup", { txid, value: Number(TOPUP), fee: Number(paid), broadcast: false });
  record({ step: "topup (signed, before broadcast)", btc_tx: txid, fee: Number(paid), vsize: signed.vsize, minimum_fee: minimumFee });
  const sent = await bitcoin.broadcast(signed.hex);
  if (sent !== "sent") throw new Error(`broadcast: ${JSON.stringify(sent)}`);
  set("topup", { txid, value: Number(TOPUP), fee: Number(paid), broadcast: true });
  set("ledger", { giver_coin: Number(input), topup: Number(TOPUP), topup_fee: Number(paid), giver_change: Number(change) });
  record({ step: "topup (broadcast)", btc_tx: txid, explorer: `https://mempool.space/testnet/tx/${txid}` });
}

async function press(url: string): Promise<void> {
  const response = await fetch(`${url}/keeper/run`, { method: "POST" });
  const report = (await response.json()) as Json;
  const tip = await view<number>("get_last_block_height", {}, "btc-client-v4.testnet");
  record({ step: "POST /keeper/run", status: response.status, light_client_tip: tip, report });
  console.log(JSON.stringify(report, null, 2));
}

/** The closing state: the keeper's only key, its transactions, the jar and its payment. */
async function close(): Promise<void> {
  const jar = evidence().jar as { jar_id: string; address: string };
  const keys = await provider.viewAccessKeyList({ accountId: KEEPER, finalityQuery: { finality: "final" } });
  const txs = await fetch("https://tx.test.fastnear.com/v0/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: KEEPER, limit: 50 }),
  }).then((r) => r.json() as Promise<{ account_txs: { transaction_hash: string; is_signer: boolean }[] }>);
  set("close", {
    keeper_keys: keys as unknown as Json,
    keeper_transactions: txs.account_txs.map((t) => ({
      near_tx: t.transaction_hash,
      signed_by_keeper: t.is_signer,
      explorer: `https://testnet.nearblocks.io/txns/${t.transaction_hash}`,
    })),
    jar: await view<Json>("get_jar", { jar_id: jar.jar_id }),
    coins: await view<Json>("get_coins", { jar_id: jar.jar_id }),
    history: await view<Json>("get_history", { jar_id: jar.jar_id }),
    giver_outputs: (await bitcoin.outputs(giverAddress())) as unknown as Json,
  });
}

/** What the run cost the giver wallet: everything sent out minus what came back. */
async function ledger(): Promise<void> {
  const data = evidence();
  const topup = data.topup as { txid: string; fee: number };
  const outs = await bitcoin.outputs(giverAddress());
  // T06's 2,500-sat allowance was in the wallet before this run.
  const back = outs.filter((o) => o.txid !== topup.txid && o.txid !== "4016901c16ce105d6c6b44531406ac8e4942cb9177698c4b3be7aa939b00e69c");
  const change = outs.find((o) => o.txid === topup.txid);
  set("ledger", {
    ...(data.ledger as { [key: string]: Json }),
    allowance_received: back.reduce((sum, o) => sum + o.value, 0),
    giver_after: outs.reduce((sum, o) => sum + o.value, 0),
    giver_change_confirmed: change?.value ?? null,
  });
}

const [step, url] = process.argv.slice(2);
if (step === "create-jar") await createJar();
else if (step === "topup") await topup();
else if (step === "press") await press(url ?? "");
else if (step === "close") {
  await close();
  await ledger();
}
else throw new Error("steps: create-jar, topup, press <url>, close");
