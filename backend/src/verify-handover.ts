// Testnet check of T17 (koukikouks/sats-jar#20): on a fresh dev contract, a demo jar is handed
// over and the keeper, pressed through a running backend's POST /keeper/run, proves its top-up,
// completes the handover, broadcasts and confirms the re-homing, then sweeps a stray sent to
// the old address. Every step goes to evidence/keeper-handover.json.
//
//   node --env-file=<env> backend/src/verify-handover.ts <step> [arg]
//   steps: accounts, create-jar, emergency, handover, topup-a, press <url>, topup-b,
//          spend, snapshot <name>, close
//
// The env supplies CONTRACT_ACCOUNT_ID, KEEPER_ACCOUNT_ID, SPONSOR_ACCOUNT_ID and
// SPONSOR_PRIVATE_KEY (accounts only), DEMO_GIVER_BTC_ADDRESS and DEMO_GIVER_BTC_WIF (read only
// inside giverKey, never printed or written). NEAR keys live in ~/.near-credentials/testnet:
// the dev account's from near-cli, the guardian's and the child's written by `accounts`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createDeviceKey, createRecoveryPhrase, keysFromRecoveryPhrase } from "@sats-jar/device-keys";
import * as btc from "@scure/btc-signer";
import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { accountIdFor } from "./accounts.ts";
import { esplora, type Output } from "./bitcoin.ts";
import { nearChain, outcomeOf, type CallOutcome } from "./chain.ts";
import { LIGHT_CLIENT, NEAR_RPC } from "./rpc.ts";

const CONTRACT = process.env.CONTRACT_ACCOUNT_ID ?? "";
const KEEPER = process.env.KEEPER_ACCOUNT_ID ?? "";
const EVIDENCE = new URL("../../evidence/keeper-handover.json", import.meta.url);
const CREDENTIALS = join(homedir(), ".near-credentials", "testnet");
const NET = btc.TEST_NETWORK;
const bitcoin = esplora();
const provider = new JsonRpcProvider({ url: NEAR_RPC });

// The approved run (t17-plan.md): cap 2,000, a one-hour period (demo timing), unlock in 10
// minutes; top-up A of 2,000 to the jar, stray B of 1,500 to its old address.
const CAP = 2_000;
const PERIOD = 3_600;
const UNLOCK_IN = 600;
const TOPUP_A = 2_000n;
const TOPUP_B = 1_500n;
const EMERGENCY = 2_000;
const SPEND = 1_000;
// T06's gates and the ticket's budget: fee rate 1, at most 300 sats a fee, at most 6,000 sats
// out of the giver wallet in all, and the wallet never under 30,000.
const FEE_RATE = 1n;
const MAX_FEE = 300n;
const BUDGET = 6_000n;
const WALLET_FLOOR = 30_000n;
const CONFIRMATIONS = 3;
const ONE_YOCTO = 1n;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Evidence = { [key: string]: Json };
type Topup = { txid: string; value: number; fee: number; address: string; broadcast: boolean };

function evidence(): Evidence {
  if (!existsSync(EVIDENCE)) {
    return {
      about:
        "Testnet run of T17 (koukikouks/sats-jar#20): on a fresh dev contract the keeper, pressed through POST /keeper/run, completes a demo jar's handover (prove, complete_handover, broadcast, confirm) and sweeps a stray with rehome_stray. Written by backend/src/verify-handover.ts.",
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

function need<T>(key: string, hint: string): T {
  const value = evidence()[key];
  if (value === undefined) throw new Error(`run the ${hint} step first`);
  return value as T;
}

async function view<T>(method: string, args: Record<string, unknown>, contractId = CONTRACT): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

/** A recorded view for the keeper's tests (backend/src/fixtures). */
async function fixture(name: string): Promise<void> {
  const jarId = need<{ jar_id: string }>("jar", "create-jar").jar_id;
  const jar = await view<Json>("get_jar", { jar_id: jarId });
  const file = new URL(`./fixtures/dev2-get-jar-${name}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(jar, null, 2)}\n`);
  record({ step: `get_jar recorded (${name})`, jar });
}

function signerFor(accountId: string): Account {
  const file = join(CREDENTIALS, `${accountId}.json`);
  const key = (JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString }).private_key;
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(key));
}

/** One call as `accountId`, recorded with its hash and outcome. */
async function call(
  accountId: string,
  method: string,
  args: Record<string, unknown>,
  deposit: bigint,
  tgas = 100n,
): Promise<Extract<CallOutcome, { ok: true }>> {
  const response = await signerFor(accountId).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall(method, args, tgas * 10n ** 12n, deposit)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const outcome = outcomeOf(response);
  record({ step: method, by: accountId, near_tx: outcome.hash, sent: args as Json, outcome: outcome as unknown as Json });
  if (!outcome.ok) throw new Error(`${method} refused: ${outcome.code} ${outcome.message}`);
  return outcome;
}

/** A guardian (random device key) and the child (recovery phrase), made by the sponsor path. */
async function accounts(): Promise<void> {
  if (evidence().accounts) throw new Error("the accounts exist already");
  const chain = nearChain({
    sponsorAccountId: process.env.SPONSOR_ACCOUNT_ID ?? "",
    sponsorPrivateKey: process.env.SPONSOR_PRIVATE_KEY ?? "",
    contractAccountId: CONTRACT,
  });
  const app = process.env.SPONSOR_ACCOUNT_ID ?? "";
  const phrase = createRecoveryPhrase();
  const people = { guardian: createDeviceKey(), child: keysFromRecoveryPhrase(phrase).near };
  const ids: { [role: string]: string } = {};
  for (const [role, key] of Object.entries(people)) {
    const accountId = accountIdFor(key.publicKey, app);
    const file = join(CREDENTIALS, `${accountId}.json`);
    // The key (and the child's phrase, which also holds its Bitcoin key) stays on this machine.
    const saved = { account_id: accountId, public_key: key.publicKey, private_key: key.secretKey };
    writeFileSync(file, JSON.stringify(role === "child" ? { ...saved, recovery_phrase: phrase } : saved), {
      mode: 0o600,
    });
    const result = await chain.createAccount(accountId, key.publicKey);
    record({ step: `createAccount (${role})`, account: accountId, result });
    ids[role] = accountId;
  }
  set("accounts", ids);
}

async function createJar(): Promise<void> {
  if (evidence().jar) throw new Error("the jar exists already");
  const { guardian } = need<{ guardian: string }>("accounts", "accounts");
  const args = {
    child_address: giverAddress(),
    cap: String(CAP),
    period: String(PERIOD),
    unlock_at: String(Math.floor(Date.now() / 1000) + UNLOCK_IN),
    guardians: [CONTRACT, guardian],
    family_account: CONTRACT,
    nickname: "Handover check",
  };
  // 0.1 NEAR for the jar's storage; the contract refunds the rest.
  const outcome = await call(CONTRACT, "create_jar", args, 10n ** 23n);
  const jarId = String(outcome.value);
  const jar = await view<{ address: string; demo_timing: boolean }>("get_jar", { jar_id: jarId });
  set("jar", { jar_id: jarId, address: jar.address, demo_timing: jar.demo_timing });
  await fixture("new");
}

/** Records the emergency views live: proposed, then approved (its delay running). Never executed. */
async function emergency(): Promise<void> {
  const { jar_id: jarId } = need<{ jar_id: string }>("jar", "create-jar");
  const { guardian } = need<{ guardian: string }>("accounts", "accounts");
  const proposed = await call(CONTRACT, "propose_emergency", { jar_id: jarId, amount: String(EMERGENCY) }, ONE_YOCTO);
  await fixture("emergency-proposed");
  await call(guardian, "approve_emergency", { jar_id: jarId, proposal_id: proposed.value }, ONE_YOCTO);
  await fixture("emergency-approved");
}

/** The child claims with its phrase's Bitcoin key; both guardians confirm. */
async function handover(): Promise<void> {
  const { jar_id: jarId } = need<{ jar_id: string }>("jar", "create-jar");
  const { guardian, child } = need<{ guardian: string; child: string }>("accounts", "accounts");
  const saved = JSON.parse(readFileSync(join(CREDENTIALS, `${child}.json`), "utf8")) as { recovery_phrase: string };
  const childKey = keysFromRecoveryPhrase(saved.recovery_phrase).bitcoin?.publicKey;
  if (!childKey) throw new Error("the child's phrase gave no Bitcoin key");
  const claim = { jar_id: jarId, child_account: child, child_btc_pubkey: bytesToHex(childKey) };
  await call(child, "claim_handover", claim, ONE_YOCTO);
  await fixture("claimed");
  for (const by of [CONTRACT, guardian]) {
    await call(by, "confirm_handover", { jar_id: jarId, child_account: child }, ONE_YOCTO);
  }
  await fixture("confirmed");
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

/** One giver top-up through T06's gates and the ticket's budget. */
async function topup(slot: "topup_a" | "topup_b", address: string, value: bigint): Promise<void> {
  const data = evidence();
  // Gate: one top-up per slot; another needs the maintainer.
  if (data[slot]) throw new Error(`${slot} was already made (${JSON.stringify(data[slot])})`);
  const key = giverKey();
  const giver = giverAddress();

  // Gate: the fee floor allows 1 sat/vB.
  const minimumFee = await bitcoin.minimumFee();
  if (minimumFee > Number(FEE_RATE)) throw new Error(`minimumFee is ${minimumFee} sat/vB; wait for 1`);

  const outputs = await bitcoin.outputs(giver);
  const wallet = outputs.reduce((sum, o) => sum + BigInt(o.value), 0n);
  const coin = outputs
    .filter((o) => o.status.confirmed)
    .sort((a, b) => b.value - a.value)[0] as Output | undefined;
  if (!coin) throw new Error("the giver has no confirmed coin");
  const input = BigInt(coin.value);
  const giverScript = btc.OutScript.encode(btc.Address(NET).decode(giver));
  const build = (fee: bigint) => {
    const tx = new btc.Transaction();
    tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script: giverScript, amount: input } });
    tx.addOutputAddress(address, value, NET);
    tx.addOutputAddress(giver, input - value - fee, NET);
    tx.sign(key);
    tx.finalize();
    return tx;
  };
  const fee = BigInt(build(0n).vsize) * FEE_RATE;
  const signed = btc.Transaction.fromRaw(build(fee).extract());

  // Gate: exactly the giver coin in; exactly the top-up and the change home out.
  const outs = Array.from({ length: signed.outputsLength }, (_, i) => signed.getOutput(i));
  const firstInput = signed.getInput(0);
  const change = outs[1]?.amount ?? 0n;
  const paid = input - value - change;
  const exact =
    signed.inputsLength === 1 &&
    firstInput.txid !== undefined &&
    bytesToHex(firstInput.txid) === coin.txid &&
    firstInput.index === coin.vout &&
    outs.length === 2 &&
    outs[0]?.amount === value &&
    bytesToHex(outs[0]?.script ?? new Uint8Array()) === outScript(address) &&
    bytesToHex(outs[1]?.script ?? new Uint8Array()) === outScript(giver);
  // Gates: the fee; the ticket's 6,000-sat budget over every top-up; the wallet's floor.
  const spent = (["topup_a", "topup_b"] as const)
    .map((s) => data[s] as Topup | undefined)
    .reduce((sum, t) => sum + BigInt(t ? t.value + t.fee : 0), 0n);
  if (!exact || paid > MAX_FEE || spent + value + paid > BUDGET || wallet - value - paid < WALLET_FLOOR) {
    throw new Error("the signed top-up failed its gate; nothing was broadcast");
  }

  // Gate: the txid is in the evidence before the broadcast.
  const txid = signed.id;
  const entry: Topup = { txid, value: Number(value), fee: Number(paid), address, broadcast: false };
  set(slot, entry);
  record({ step: `${slot} (signed, before broadcast)`, btc_tx: txid, fee: Number(paid), vsize: signed.vsize, minimum_fee: minimumFee, wallet_before: Number(wallet) });
  const sent = await bitcoin.broadcast(signed.hex);
  if (sent !== "sent") throw new Error(`broadcast: ${JSON.stringify(sent)}`);
  set(slot, { ...entry, broadcast: true });
  record({ step: `${slot} (broadcast)`, btc_tx: txid, explorer: `https://mempool.space/testnet/tx/${txid}` });
}

async function topupA(): Promise<void> {
  const { jar_id: jarId, address } = need<{ jar_id: string; address: string }>("jar", "create-jar");
  // Gate: the handover is confirmed, so no allowance can ever pay this top-up out.
  const jar = await view<{ handover: Json }>("get_jar", { jar_id: jarId });
  if (typeof jar.handover !== "object" || jar.handover === null || !("confirmed" in jar.handover)) {
    throw new Error("confirm the handover before top-up A");
  }
  await topup("topup_a", address, TOPUP_A);
}

/** Top-up A, 3 deep on the light client: before that no keeper may run against this jar. */
async function topupADeep(): Promise<boolean> {
  const { txid } = need<Topup>("topup_a", "topup-a");
  const status = await bitcoin.status(txid);
  const tip = await view<number>("get_last_block_height", {}, LIGHT_CLIENT);
  return status.confirmed && status.block_height !== undefined && tip - status.block_height + 1 >= CONFIRMATIONS;
}

async function press(url: string): Promise<void> {
  // Gate (t17-plan-review high): a press before A is 3 deep would hand over an empty jar.
  if (!(await topupADeep())) throw new Error("top-up A is not yet 3 deep on the light client; no press");
  const response = await fetch(`${url}/keeper/run`, { method: "POST" });
  const report = (await response.json()) as Json;
  const tip = await view<number>("get_last_block_height", {}, LIGHT_CLIENT);
  record({ step: "POST /keeper/run", status: response.status, light_client_tip: tip, report });
  console.log(JSON.stringify(report, null, 2));
}

type PaymentView = { payment_id: string; jar_id: string; kind: string; status: string; inputs: { txid: string; vout: number }[] };

async function jarPayments(jarId: string): Promise<PaymentView[]> {
  const payments: PaymentView[] = [];
  for (let id = 1; ; id++) {
    const payment = await view<PaymentView | null>("get_payment", { payment_id: String(id) });
    if (!payment) return payments.filter((p) => p.jar_id === jarId);
    payments.push(payment);
  }
}

async function topupB(): Promise<void> {
  const { jar_id: jarId } = need<{ jar_id: string }>("jar", "create-jar");
  const a = need<Topup>("topup_a", "topup-a");
  // Gate (t17-plan-review high): the first complete_handover re-homed top-up A, not an empty jar.
  const rehomedA = (await jarPayments(jarId)).some(
    (p) => p.kind === "rehoming" && p.inputs.some((i) => i.txid === a.txid && i.vout === 0),
  );
  if (!rehomedA) throw new Error("no re-homing payment spends top-up A; no stray is sent");
  const jar = await view<{ old_addresses: string[] }>("get_jar", { jar_id: jarId });
  const old = jar.old_addresses[0];
  if (!old) throw new Error("the jar has no old address");
  await topup("topup_b", old, TOPUP_B);
}

/** The child, now holder, sends part of the jar back to the giver; the keeper broadcasts it. */
async function spend(): Promise<void> {
  const { jar_id: jarId } = need<{ jar_id: string }>("jar", "create-jar");
  const { child } = need<{ child: string }>("accounts", "accounts");
  const args = { jar_id: jarId, to: giverAddress(), amount: String(SPEND), fee_rate: String(FEE_RATE) };
  await call(child, "request_spend", args, ONE_YOCTO, 10n * 15n + 50n);
}

/** The closing state: nothing unfinished, the keeper's only key, its transactions, the jar. */
async function close(): Promise<void> {
  const { jar_id: jarId } = need<{ jar_id: string }>("jar", "create-jar");
  const payments = await jarPayments(jarId);
  const open = payments.filter((p) => p.status !== "confirmed" && p.status !== "cancelled");
  if (open.length > 0) throw new Error(`unfinished payments: ${open.map((p) => p.payment_id).join(", ")}`);
  const keys = await provider.viewAccessKeyList({ accountId: KEEPER, finalityQuery: { finality: "final" } });
  const txs = await fetch("https://tx.test.fastnear.com/v0/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: KEEPER, limit: 50 }),
  }).then((r) => r.json() as Promise<{ account_txs: { transaction_hash: string; is_signer: boolean }[] }>);
  const outs = await bitcoin.outputs(giverAddress());
  set("close", {
    keeper_keys: keys as unknown as Json,
    keeper_transactions: txs.account_txs.map((t) => ({
      near_tx: t.transaction_hash,
      signed_by_keeper: t.is_signer,
      explorer: `https://testnet.nearblocks.io/txns/${t.transaction_hash}`,
    })),
    jar: await view<Json>("get_jar", { jar_id: jarId }),
    nft_token: await view<Json>("nft_token", { token_id: jarId }),
    coins: await view<Json>("get_coins", { jar_id: jarId }),
    payments: payments as unknown as Json,
    history: await view<Json>("get_history", { jar_id: jarId }),
    giver_after: outs.reduce((sum, o) => sum + o.value, 0),
  });
}

const [step, arg] = process.argv.slice(2);
if (step === "accounts") await accounts();
else if (step === "create-jar") await createJar();
else if (step === "emergency") await emergency();
else if (step === "handover") await handover();
else if (step === "topup-a") await topupA();
else if (step === "press") await press(arg ?? "");
else if (step === "topup-b") await topupB();
else if (step === "spend") await spend();
else if (step === "snapshot") await fixture(arg ?? "snapshot");
else if (step === "close") await close();
else throw new Error("steps: accounts, create-jar, emergency, handover, topup-a, press <url>, topup-b, spend, snapshot <name>, close");
