// The money moment on testnet against the dev deploy (T06): a real top-up proven through the
// live light client, an allowance signed by the live MPC network and broadcast, and a real
// "already paid" refusal. Each step appends what it did to evidence/dev-money-moment.json.
//
//   node --env-file=<path to .env> scripts/src/money-moment.ts <step>
//   steps: deploy, create-jar, topup, prove, allowance, broadcast, confirm
//
// .env supplies DEMO_GIVER_BTC_ADDRESS and DEMO_GIVER_BTC_WIF. The WIF is read only inside
// `giverKey` and is never printed or written.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import * as btc from "@scure/btc-signer";
import {
  Account,
  KeyPairSigner,
  actions,
  encodeTransaction,
  type KeyPairString,
} from "near-api-js";
import { topupProof, type TopupProof } from "./merkle.ts";

const CONTRACT = "sats-jar-dev.testnet";
const MPC = "v1.signer-prod.testnet";
const LIGHT_CLIENT = "btc-client-v4.testnet";
const NEAR_RPC = "https://rpc.testnet.fastnear.com";
const ESPLORA = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];
const NET = btc.TEST_NETWORK;
const EVIDENCE = new URL("../../evidence/dev-money-moment.json", import.meta.url);
const WASM = new URL("../../target/near/sats_jar/sats_jar.wasm", import.meta.url);

// The approved run (T06 plan): two 2,000-sat coins, cap 2,500, one-day period (demo timing).
const COIN = 2_000n;
const CAP = 2_500;
const PERIOD = 86_400;
const FEE_RATE = 1;
const MAX_TOPUP_FEE = 300n;
const MAX_SPEND = 5_000n;
const CONFIRMATIONS = 3;
/** The contract's documented floors (findings T03, T04). */
const PROVE_GAS = 60;
const ALLOWANCE_GAS = 2 * 15 + 30 + 20;
const RETRY_GAS = 300;
/** The demo exit delay off mainnet: three hours after the unlock date. */
const DEMO_EXIT_DELAY = 10_800;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Evidence = { [key: string]: Json };

// ---------- evidence ----------

function evidence(): Evidence {
  if (!existsSync(EVIDENCE)) {
    return {
      about:
        "Testnet run of T06 (koukikouks/sats-jar#17) against the development contract: every NEAR transaction, Bitcoin transaction and block, with what each shows. Written by scripts/src/money-moment.ts.",
      contract: CONTRACT,
      steps: [],
    };
  }
  return JSON.parse(readFileSync(EVIDENCE, "utf8")) as Evidence;
}

function save(data: Evidence): void {
  writeFileSync(EVIDENCE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Appends one entry to the run's step list, written at once so a crash keeps it. */
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

function get<T extends Json>(key: string): T | undefined {
  return evidence()[key] as T | undefined;
}

function need<T extends Json>(key: string, step: string): T {
  const value = get<T>(key);
  if (value === undefined) throw new Error(`run the ${step} step first`);
  return value;
}

// ---------- NEAR ----------

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(NEAR_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await response.json()) as { result?: T; error?: { cause?: { name?: string } } };
      if (body.result !== undefined) return body.result;
      const cause = body.error?.cause?.name;
      if (cause === "TIMEOUT_ERROR" || cause === "UNKNOWN_TRANSACTION") throw new Retry(cause);
      throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    } catch (error) {
      if (attempt >= 60 || !(error instanceof Retry || error instanceof TypeError)) throw error;
      await sleep(5_000);
    }
  }
}

class Retry extends Error {}

async function view<T>(contract: string, method: string, args: unknown = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

interface Receipt {
  id: string;
  outcome: {
    executor_id: string;
    gas_burnt: number;
    status: { SuccessValue?: string; Failure?: unknown; SuccessReceiptId?: string };
    logs: string[];
  };
  block_hash: string;
}

interface TxStatus {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts?: { receipt_id: string; receipt: { Action?: { actions: { FunctionCall?: { method_name: string } }[] } } }[];
  transaction_outcome: { outcome: { gas_burnt: number } };
  receipts_outcome: Receipt[];
}

interface Call {
  hash: string;
  ok: boolean;
  value: Json;
  error: string | null;
  receipts: { executor: string; method: string | null; gas_burnt_tgas: number; block_height: number; result: Json }[];
}

let account: Account | undefined;
/** The dev account, signing with the key near-cli keeps in its legacy keychain. */
function dev(): Account {
  if (!account) {
    const file = join(homedir(), ".near-credentials", "testnet", `${CONTRACT}.json`);
    const key = (JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString }).private_key;
    account = new Account(CONTRACT, NEAR_RPC, KeyPairSigner.fromSecretKey(key));
  }
  return account;
}

/**
 * Calls `method` on the jar contract as the dev account and waits for every receipt. The hash
 * is recorded before sending, so a call that fails or hangs is in the evidence too.
 */
async function call(
  label: string,
  method: string,
  args: unknown,
  tgas: number,
  yocto = 0n,
): Promise<Call> {
  const signed = await dev().createSignedTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall(method, args as object, BigInt(tgas) * 10n ** 12n, yocto)],
  });
  const hash = base58.encode(sha256(encodeTransaction(signed.transaction)));
  record({ step: label, near_tx: hash, sent: { method, args: args as Json, tgas, yocto: yocto.toString() } });
  await rpc("send_tx", {
    signed_tx_base64: Buffer.from(encodeTransaction(signed)).toString("base64"),
    wait_until: "INCLUDED_FINAL",
  });
  return outcome(hash, method);
}

/** Waits until every receipt of `hash` has run (a signing yields for many blocks). */
async function outcome(hash: string, method: string): Promise<Call> {
  const status = await rpc<TxStatus>("EXPERIMENTAL_tx_status", {
    tx_hash: hash,
    sender_account_id: CONTRACT,
    wait_until: "FINAL",
  });
  const methods = new Map<string, string>();
  for (const r of status.receipts ?? []) {
    const name = r.receipt.Action?.actions[0]?.FunctionCall?.method_name;
    if (name) methods.set(r.receipt_id, name);
  }
  const receipts = [];
  // The receipt made from the transaction itself is not in `receipts`: it is the first outcome.
  for (const [index, r] of status.receipts_outcome.entries()) {
    const block = await rpc<{ header: { height: number } }>("block", { block_id: r.block_hash });
    receipts.push({
      executor: r.outcome.executor_id,
      method: methods.get(r.id) ?? (index === 0 ? method : null),
      gas_burnt_tgas: Number((r.outcome.gas_burnt / 1e12).toFixed(3)),
      block_height: block.header.height,
      result: r.outcome.status.Failure
        ? { failure: r.outcome.status.Failure as Json }
        : decode(r.outcome.status.SuccessValue),
    });
  }
  const ok = status.status.SuccessValue !== undefined;
  return {
    hash,
    ok,
    value: ok ? decode(status.status.SuccessValue) : null,
    error: ok ? null : failure(status.status.Failure),
    receipts,
  };
}

function decode(base64: string | undefined): Json {
  if (!base64) return null;
  const text = Buffer.from(base64, "base64").toString();
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

/** The panic text of a failed call (`CODE: sentence` for the contract's refusals). */
function failure(error: unknown): string {
  const text = JSON.stringify(error);
  const match = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text);
  const panic = match ? (JSON.parse(`"${match[1]}"`) as string) : text;
  return panic.replace(/^Smart contract panicked: /, "");
}

function done(label: string, result: Call, extra: { [key: string]: Json } = {}): void {
  record({
    step: `${label} (outcome)`,
    near_tx: result.hash,
    explorer: `https://testnet.nearblocks.io/txns/${result.hash}`,
    ok: result.ok,
    value: result.value,
    error: result.error,
    receipts: result.receipts,
    ...extra,
  });
}

// ---------- Bitcoin ----------

async function esplora(path: string, init?: RequestInit): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    for (const base of ESPLORA) {
      try {
        const response = await fetch(`${base}${path}`, init);
        const text = await response.text();
        if (response.ok) return text;
        // A refused broadcast is an answer, not an outage.
        if (init?.method === "POST") throw new Error(`broadcast refused: ${text}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("broadcast refused")) throw error;
      }
    }
    if (attempt >= 10) throw new Error(`esplora ${path} unreachable`);
    await sleep(5_000);
  }
}

async function esploraJson<T>(path: string): Promise<T> {
  return JSON.parse(await esplora(path)) as T;
}

/** Waits until the fee floor allows 1 sat/vB (the approved run never pays more). */
async function feeFloor(): Promise<number> {
  for (;;) {
    const fees = await esploraJson<{ minimumFee: number }>("/v1/fees/recommended");
    if (fees.minimumFee <= FEE_RATE) return fees.minimumFee;
    console.log(`minimumFee is ${fees.minimumFee} sat/vB; waiting for 1`);
    await sleep(60_000);
  }
}

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

async function utxos(address: string): Promise<Utxo[]> {
  return esploraJson<Utxo[]>(`/address/${address}/utxo`);
}

/** Waits for the light client to see `txid` `CONFIRMATIONS` deep, then builds its proof. */
async function confirmedProof(txid: string): Promise<{ proof: TopupProof; height: number; tip: number }> {
  for (;;) {
    const status = await esploraJson<{ confirmed: boolean; block_hash?: string; block_height?: number }>(
      `/tx/${txid}/status`,
    );
    if (status.confirmed && status.block_hash && status.block_height) {
      const tip = await view<number>(LIGHT_CLIENT, "get_last_block_height");
      if (tip - status.block_height + 1 >= CONFIRMATIONS) {
        const txids = await esploraJson<string[]>(`/block/${status.block_hash}/txids`);
        return { proof: topupProof(status.block_hash, txids, txid), height: status.block_height, tip };
      }
      console.log(`${txid}: ${Math.max(0, tip - status.block_height + 1)} of ${CONFIRMATIONS} confirmations on the light client`);
    } else {
      console.log(`${txid}: not yet in a block`);
    }
    await sleep(30_000);
  }
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

// ---------- the jar ----------

interface JarView {
  jar_id: string;
  address: string;
  witness_script: string;
  public_key: string;
  locktime: number;
  demo_timing: boolean;
  create_args: { unlock_at: string; child_address: string };
  proven_balance: string;
  available_allowance: string;
  fee_budget_left: string;
  next_allowance_at: string | null;
}

interface PaymentView {
  payment_id: string;
  status: string;
  failure: string | null;
  txid: string;
  amount: string;
  fee: string;
  change: string;
  inputs: { txid: string; vout: number; value: string }[];
  signed_tx: string | null;
}

async function jar(id: string): Promise<JarView> {
  const view_ = await view<JarView | null>(CONTRACT, "get_jar", { jar_id: id });
  if (!view_) throw new Error(`jar ${id} not found`);
  return view_;
}

/** `secp256k1:<base58 x‖y>` to the 33-byte compressed key. */
function compressed(nearKey: string): Uint8Array {
  const xy = base58.decode(nearKey.replace(/^secp256k1:/, ""));
  if (xy.length !== 64) throw new Error(`not a 64-byte secp256k1 key: ${nearKey}`);
  return Uint8Array.from([(xy[63]! & 1) === 0 ? 0x02 : 0x03, ...xy.subarray(0, 32)]);
}

function check(name: string, live: Json, ours: Json): { [key: string]: Json } {
  const match = JSON.stringify(live) === JSON.stringify(ours);
  if (!match) console.log(`MISMATCH ${name}: live ${JSON.stringify(live)} vs ${JSON.stringify(ours)}`);
  return { check: name, live, contract_or_stand_in: ours, match };
}

function comparison(entry: { [key: string]: Json }): void {
  const data = evidence();
  data.comparisons = [...((data.comparisons as Json[] | undefined) ?? []), entry];
  save(data);
}

async function accountTransactions(): Promise<Json[]> {
  const response = await fetch("https://tx.test.fastnear.com/v0/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: CONTRACT, limit: 200 }),
  });
  const body = (await response.json()) as { account_txs: { transaction_hash: string; tx_block_height: number }[] };
  return body.account_txs.map((t) => ({
    near_tx: t.transaction_hash,
    block_height: t.tx_block_height,
    explorer: `https://testnet.nearblocks.io/txns/${t.transaction_hash}`,
  }));
}

// ---------- steps ----------

async function deploy(): Promise<void> {
  const wasm = readFileSync(WASM);
  const local = base58.encode(sha256(wasm));
  const state = await rpc<{ code_hash: string; storage_usage: number; amount: string }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: CONTRACT,
  });
  const entry = {
    account: CONTRACT,
    build: "cargo near build non-reproducible-wasm --features dev-escape --no-abi",
    wasm_bytes: wasm.length,
    wasm_sha256_bs58: local,
    deployed_code_hash: state.code_hash,
    storage_usage: state.storage_usage,
    mpc_contract: MPC,
    mpc_version: await view<string>(MPC, "version"),
    mpc_root_public_key: await view<string>(MPC, "public_key"),
    light_client: LIGHT_CLIENT,
    light_client_mainchain_size: await view<number>(LIGHT_CLIENT, "get_mainchain_size"),
    // The faucet's account creation and the deploy (sent by near-cli, so listed from FastNEAR).
    account_transactions: await accountTransactions(),
  };
  set("deploy", entry);
  comparison(check("deployed code hash equals the local dev build", state.code_hash, local));
  if (state.code_hash !== local) throw new Error("the deployed code is not this build");
}

async function createJar(): Promise<void> {
  if (get("jar")) throw new Error("the jar exists already");
  const now = Math.floor(Date.now() / 1000);
  const args = {
    child_address: giverAddress(),
    cap: String(CAP),
    period: String(PERIOD),
    unlock_at: String(now + 86_400),
    guardians: [`guardian-a.${CONTRACT}`, `guardian-b.${CONTRACT}`],
    family_account: CONTRACT,
    nickname: "Dev money moment",
  };
  const result = await call("create_jar", "create_jar", args, 100, 10n ** 24n);
  done("create_jar", result);
  if (!result.ok || typeof result.value !== "string") throw new Error(`create_jar failed: ${result.error}`);
  const id = result.value;
  const view_ = await jar(id);

  // Gates before any sats move: the live signer's key for this jar, and the script rebuilt
  // byte for byte with an independent library.
  const derived = await view<string>(MPC, "derived_public_key", {
    path: id,
    predecessor: CONTRACT,
    domain_id: 0,
  });
  const keyHash = btc.Address(NET).decode(giverAddress());
  if (keyHash.type !== "wpkh") throw new Error("the giver address is not P2WPKH");
  const locktime = Number(view_.create_args.unlock_at) + DEMO_EXIT_DELAY;
  const script = btc.Script.encode([
    "IF", compressed(derived), "CHECKSIG",
    "ELSE", locktime, "CHECKLOCKTIMEVERIFY", "DROP", "DUP", "HASH160", keyHash.hash, "EQUALVERIFY", "CHECKSIG",
    "ENDIF",
  ]);
  const address = btc.Address(NET).encode({ type: "wsh", hash: sha256(script) });
  const gates = [
    check("jar key equals the live derived_public_key", derived, view_.public_key),
    check("witness script rebuilt independently", bytesToHex(script), view_.witness_script),
    check("locktime is unlock_at + 3 h", locktime, view_.locktime),
    check("jar address is the P2WSH of that script", address, view_.address),
    check("demo timing", true, view_.demo_timing),
  ];
  gates.forEach(comparison);
  set("jar", { jar_id: id, view: view_ as unknown as Json });
  if (gates.some((g) => !g.match)) throw new Error("a gate failed: no sats are sent to this jar");
}

async function topup(): Promise<void> {
  const existing = get<{ txid: string }>("topup");
  if (existing) {
    throw new Error(`a top-up was already made (${existing.txid}); a second one needs the maintainer`);
  }
  const theJar = need<{ jar_id: string; view: { address: string } }>("jar", "create-jar");
  const key = giverKey();
  const giver = giverAddress();
  const coins = await utxos(giver);
  const [utxo] = coins;
  if (coins.length !== 1 || !utxo || !utxo.status.confirmed) {
    throw new Error("the giver wallet should hold exactly one confirmed coin");
  }
  const minimumFee = await feeFloor();
  const input = BigInt(utxo.value);
  const giverScript = hexToBytes(outScript(giver));

  const build = (fee: bigint) => {
    const tx = new btc.Transaction();
    tx.addInput({ txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: giverScript, amount: input } });
    tx.addOutputAddress(theJar.view.address, COIN, NET);
    tx.addOutputAddress(theJar.view.address, COIN, NET);
    tx.addOutputAddress(giver, input - 2n * COIN - fee, NET);
    tx.sign(key);
    tx.finalize();
    return tx;
  };
  const fee = BigInt(build(0n).vsize * FEE_RATE);
  const signed = btc.Transaction.fromRaw(build(fee).extract());

  // Gate before broadcast: one known input; exactly the two jar coins and the change home.
  const jarScript = outScript(theJar.view.address);
  const outs = Array.from({ length: signed.outputsLength }, (_, i) => signed.getOutput(i));
  const firstInput = signed.getInput(0);
  const change = outs[2]?.amount ?? 0n;
  const spent = input - change;
  const gate =
    signed.inputsLength === 1 &&
    firstInput.txid !== undefined &&
    bytesToHex(firstInput.txid) === utxo.txid &&
    firstInput.index === utxo.vout &&
    outs.length === 3 &&
    outs[0]?.amount === COIN && bytesToHex(outs[0]?.script ?? new Uint8Array()) === jarScript &&
    outs[1]?.amount === COIN && bytesToHex(outs[1]?.script ?? new Uint8Array()) === jarScript &&
    bytesToHex(outs[2]?.script ?? new Uint8Array()) === outScript(giver) &&
    input - 2n * COIN - change <= MAX_TOPUP_FEE &&
    spent <= MAX_SPEND;
  if (!gate) throw new Error("the signed top-up failed its gate; nothing was broadcast");

  const txid = signed.id;
  set("topup", { txid, broadcast: false });
  record({
    step: "topup (signed, before broadcast)",
    btc_tx: txid,
    to_jar: [Number(COIN), Number(COIN)],
    fee: Number(input - 2n * COIN - change),
    vsize: signed.vsize,
    minimum_fee: minimumFee,
  });
  await esplora("/tx", { method: "POST", body: signed.hex });
  set("topup", { txid, broadcast: true, fee: Number(input - 2n * COIN - change) });
  set("ledger", {
    wallet_before: Number(input),
    topup: Number(2n * COIN),
    topup_fee: Number(input - 2n * COIN - change),
    wallet_after_topup: Number(change),
  });
  record({ step: "topup (broadcast)", btc_tx: txid, explorer: `https://mempool.space/testnet/tx/${txid}` });
}

async function prove(): Promise<void> {
  const { txid } = need<{ txid: string }>("topup", "topup");
  const { jar_id } = need<{ jar_id: string }>("jar", "create-jar");
  const { proof, height, tip } = await confirmedProof(txid);
  record({ step: "topup confirmed", btc_tx: txid, block: proof.tx_block_blockhash, block_height: height, light_client_tip: tip });
  const raw = await esplora(`/tx/${txid}/hex`);
  for (const vout of [0, 1]) {
    const args = { jar_id, tx: raw, vout, proof };
    let result = await call(`prove_topup vout ${vout}`, "prove_topup", args, PROVE_GAS);
    done(`prove_topup vout ${vout}`, result);
    if (!result.ok && !/^(COIN_ALREADY_KNOWN|NOT_CONFIRMED)/.test(result.error ?? "")) {
      // Isolate a gas shortfall from a real refusal before touching any constant.
      result = await call(`prove_topup vout ${vout} at ${RETRY_GAS} Tgas`, "prove_topup", args, RETRY_GAS);
      done(`prove_topup vout ${vout} at ${RETRY_GAS} Tgas`, result);
    }
    if (!result.ok) throw new Error(`prove_topup failed: ${result.error}`);
    const lc = result.receipts.find((r) => r.executor === LIGHT_CLIENT);
    comparison(check(`prove_topup vout ${vout} succeeds at exactly ${PROVE_GAS} Tgas`, result.ok, true));
    comparison({
      check: `light client answer and gas (vout ${vout})`,
      live: { answer: lc?.result ?? null, gas_burnt_tgas: lc?.gas_burnt_tgas ?? null },
      contract_or_stand_in: { call_gas_tgas: 20, callback_gas_tgas: 20 },
      match: lc !== undefined && lc.gas_burnt_tgas < 20,
    });
  }
  const view_ = await jar(jar_id);
  const coins = await view<Json>(CONTRACT, "get_coins", { jar_id });
  record({ step: "jar after top-up", jar: view_ as unknown as Json, coins });
  comparison(check("proven balance after both coins", view_.proven_balance, String(2n * COIN)));
}

async function allowance(): Promise<void> {
  const { jar_id } = need<{ jar_id: string }>("jar", "create-jar");
  if (get("payment")) throw new Error("the allowance was already requested; use broadcast or confirm");
  const before = await jar(jar_id);
  const gates = [
    check("available allowance before the request", before.available_allowance, String(CAP)),
    check("fee budget left before the request", before.fee_budget_left, String(CAP / 10)),
    check("proven balance before the request", before.proven_balance, String(2n * COIN)),
  ];
  gates.forEach(comparison);
  if (gates.some((g) => !g.match)) throw new Error("the jar is not as planned; no allowance requested");
  const minimumFee = await feeFloor();
  record({ step: "fee floor before request_allowance", minimum_fee: minimumFee });

  const args = { jar_id, fee_rate: String(FEE_RATE) };
  // The first request runs its own receipt in the block after inclusion; the second follows it,
  // while the first is still signing, and must read "already paid".
  const pending = call("request_allowance", "request_allowance", args, ALLOWANCE_GAS);
  await sleep(8_000);
  const second = await call("request_allowance again (already paid)", "request_allowance", args, ALLOWANCE_GAS);
  done("request_allowance again (already paid)", second);
  comparison(check("second request in the period is refused as already paid", (second.error ?? "").split(":")[0] ?? "", "ALREADY_PAID"));
  const result = await pending;
  done("request_allowance", result);
  if (!result.ok) throw new Error(`request_allowance failed: ${result.error}`);
  const id = String(result.value);
  set("payment", { payment_id: id });

  let payment = await view<PaymentView>(CONTRACT, "get_payment", { payment_id: id });
  if (payment.status === "signing_failed") {
    comparison(check(`signing at exactly ${ALLOWANCE_GAS} Tgas`, payment.failure, null));
    const retry = await call(`retry_signing at ${RETRY_GAS} Tgas`, "retry_signing", { payment_id: id }, RETRY_GAS);
    done(`retry_signing at ${RETRY_GAS} Tgas`, retry);
    payment = await view<PaymentView>(CONTRACT, "get_payment", { payment_id: id });
  }
  // Each `sign` yields; the signer's resume receipt returns the signature.
  const signer = result.receipts.filter((r) => r.executor === MPC);
  const request = result.receipts[0];
  comparison({
    check: "live sign requests (1 yocto, 15 Tgas floor), their answers and the signing callback",
    live: {
      request_block: request?.block_height ?? null,
      signer_receipts: signer.map((s) => ({ method: s.method, gas_burnt_tgas: s.gas_burnt_tgas, block_height: s.block_height, result: s.result })),
      callback: result.receipts.find((r) => r.method === "on_payment_signed") ?? null,
    },
    contract_or_stand_in: { sign_gas_tgas: 15, deposit_yocto: 1, inputs: 2, callback_gas_tgas: 30 },
    match: signer.filter((s) => s.method === "sign").length === 2 && payment.status === "signed",
  });
  record({ step: "payment after signing", payment: payment as unknown as Json });
  if (payment.status !== "signed") throw new Error(`payment ${id} is ${payment.status}: ${payment.failure}`);
}

async function broadcast(): Promise<void> {
  const { payment_id } = need<{ payment_id: string }>("payment", "allowance");
  const theJar = need<{ view: { address: string } }>("jar", "create-jar");
  const payment = await view<PaymentView>(CONTRACT, "get_payment", { payment_id });
  if (!payment.signed_tx) throw new Error(`payment ${payment_id} is not signed`);
  const tx = btc.Transaction.fromRaw(hexToBytes(payment.signed_tx), { allowUnknownOutputs: true });
  const payee = tx.getOutput(0);
  const change = tx.getOutput(1);
  const checks = [
    check("payment txid", tx.id, payment.txid),
    check("payee is the child's address", bytesToHex(payee.script ?? new Uint8Array()), outScript(giverAddress())),
    check("payee amount is the cap", Number(payee.amount ?? 0n), CAP),
    check("change goes back to the jar", bytesToHex(change.script ?? new Uint8Array()), outScript(theJar.view.address)),
    check("change amount", String(change.amount ?? 0n), payment.change),
    check("two inputs", tx.inputsLength, 2),
  ];
  checks.forEach(comparison);
  if (checks.some((c) => !c.match)) throw new Error("the signed payment is not as planned; not broadcast");
  set("payment", { payment_id, txid: payment.txid, broadcast: false });
  record({ step: "allowance payment (before broadcast)", btc_tx: payment.txid, vsize: tx.vsize, fee: Number(payment.fee) });
  await esplora("/tx", { method: "POST", body: payment.signed_tx });
  set("payment", { payment_id, txid: payment.txid, broadcast: true });
  record({
    step: "allowance payment (broadcast, accepted by testnet3)",
    btc_tx: payment.txid,
    explorer: `https://mempool.space/testnet/tx/${payment.txid}`,
  });
}

async function confirm(): Promise<void> {
  const { payment_id, txid } = need<{ payment_id: string; txid: string }>("payment", "broadcast");
  const { jar_id } = need<{ jar_id: string }>("jar", "create-jar");
  const { proof, height, tip } = await confirmedProof(txid);
  record({ step: "allowance payment confirmed", btc_tx: txid, block: proof.tx_block_blockhash, block_height: height, light_client_tip: tip });
  const args = { payment_id, proof };
  let result = await call("confirm_payment", "confirm_payment", args, PROVE_GAS);
  done("confirm_payment", result);
  if (!result.ok && !/^NOT_CONFIRMED/.test(result.error ?? "")) {
    result = await call(`confirm_payment at ${RETRY_GAS} Tgas`, "confirm_payment", args, RETRY_GAS);
    done(`confirm_payment at ${RETRY_GAS} Tgas`, result);
  }
  if (!result.ok) throw new Error(`confirm_payment failed: ${result.error}`);
  comparison(check(`confirm_payment succeeds at exactly ${PROVE_GAS} Tgas`, result.ok, true));
  const payment = await view<PaymentView>(CONTRACT, "get_payment", { payment_id });
  const view_ = await jar(jar_id);
  const coins = await view<{ txid: string; vout: number; value: string; status: string }[]>(CONTRACT, "get_coins", { jar_id });
  const changeCoin = coins.find((c) => c.txid === txid && c.vout === 1);
  comparison(check("payment confirmed", payment.status, "confirmed"));
  comparison(check("change is a confirmed coin", changeCoin?.status ?? null, "confirmed"));
  comparison(check("proven balance is the change", view_.proven_balance, payment.change));
  record({ step: "jar after confirm_payment", jar: view_ as unknown as Json, coins: coins as unknown as Json, payment: payment as unknown as Json });
  const wallet = (await utxos(giverAddress())).reduce((sum, u) => sum + u.value, 0);
  const ledger = need<{ [key: string]: Json }>("ledger", "topup");
  set("ledger", { ...ledger, allowance_received: CAP, allowance_fee_from_jar: Number(payment.fee), left_in_jar: Number(payment.change), wallet_after: wallet });
}

const steps: Record<string, () => Promise<void>> = {
  deploy,
  "create-jar": createJar,
  topup,
  prove,
  allowance,
  broadcast,
  confirm,
};

const step = steps[process.argv[2] ?? ""];
if (!step) {
  console.error(`usage: money-moment.ts <${Object.keys(steps).join("|")}>`);
  process.exit(2);
}
await step();
console.log("done");
