// Testnet check of T15 (koukikouks/sats-jar#18) through a running backend: a giver and two
// guardians get accounts from device keys made by @sats-jar/device-keys, the guardians join
// by invite, the giver creates the jar from their own funded account, and the draft is then
// cleared. Every account's keys are read back from the chain and written to
// evidence/backend-accounts.json.
//
//   node --env-file=<backend env> backend/src/verify-testnet.ts http://localhost:<PORT>
//
// The env supplies CONTRACT_ACCOUNT_ID only; device secrets stay in memory and are not written.
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createDeviceKey } from "@sats-jar/device-keys";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { NEAR_RPC } from "./rpc.ts";

const BACKEND = process.argv[2] ?? "";
const CONTRACT = process.env.CONTRACT_ACCOUNT_ID ?? "";
const EVIDENCE = new URL("../../evidence/backend-accounts.json", import.meta.url);
// T07's public test-phrase address (testnet3); nothing is ever paid to it here.
const CHILD_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
const STORAGE_DEPOSIT = 20_000_000_000_000_000_000_000n; // 0.02 NEAR; the contract refunds the rest
const CREATE_GAS = 30_000_000_000_000n; // T06's create_jar burnt 7 Tgas
const YEAR = 365 * 24 * 3600;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

async function backend(method: string, path: string, body?: Json) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { [key: string]: Json } };
}

async function rpcQuery(params: { [key: string]: string }) {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
  });
  return ((await res.json()) as { result?: { [key: string]: Json } }).result;
}

async function finalKeys(accountId: string): Promise<Json[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const keys = (await rpcQuery({ request_type: "view_access_key_list", account_id: accountId }))?.keys;
    if (Array.isArray(keys) && keys.length > 0) return keys;
    await sleep(2_000);
  }
  throw new Error(`${accountId} has no final keys`);
}

/** The transactions that touched an account, from the FastNEAR tx API (as T06 used). */
async function transactions(accountId: string): Promise<string[]> {
  const res = await fetch("https://tx.test.fastnear.com/v0/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: accountId, limit: 10 }),
  });
  const body = (await res.json()) as { account_txs?: { transaction_hash: string }[] };
  return (body.account_txs ?? []).map((t) => t.transaction_hash);
}

/** The indexer trails the chain by a few seconds. */
async function indexedTransactions(accountId: string): Promise<string[]> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const hashes = await transactions(accountId);
    if (hashes.length > 0) return hashes;
    await sleep(2_000);
  }
  return [];
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok: ${what}`);
}

const giver = createDeviceKey();
const guardians = [createDeviceKey(), createDeviceKey()];

const giverAccount = (await backend("POST", "/accounts", { publicKey: giver.publicKey })).body.accountId as string;
const draft = await backend("POST", "/drafts", { nickname: "Backend check", invites: 2 });
check(draft.status === 201, "the giver made 2 invite links");
const draftId = draft.body.draftId as string;
const tokens = draft.body.inviteTokens as string[];

const guardianAccounts: string[] = [];
for (const [n, key] of guardians.entries()) {
  const invite = await backend("GET", `/invites/${tokens[n]}`);
  check(invite.body.joined === false, `invite ${n + 1} is open`);
  const joined = await backend("POST", `/invites/${tokens[n]}/join`, { publicKey: key.publicKey });
  check(joined.status === 200, `guardian ${n + 1} joined`);
  guardianAccounts.push(joined.body.accountId as string);
}

const people = [
  { role: "giver", account: giverAccount, publicKey: giver.publicKey },
  ...guardians.map((g, n) => ({ role: `guardian ${n + 1}`, account: guardianAccounts[n] ?? "", publicKey: g.publicKey })),
];
const accounts: Json[] = [];
for (const person of people) {
  const keys = await finalKeys(person.account);
  const only = keys[0] as { public_key: string; access_key: { permission: Json } };
  check(
    keys.length === 1 && only.public_key === person.publicKey && only.access_key.permission === "FullAccess",
    `${person.role}'s account ${person.account} has exactly one key, the device's`,
  );
  accounts.push({
    role: person.role,
    account: person.account,
    device_public_key: person.publicKey,
    access_keys_on_chain: keys,
    balance_yocto: ((await rpcQuery({ request_type: "view_account", account_id: person.account }))?.amount ?? null) as Json,
    transactions: await indexedTransactions(person.account),
  });
}

const provider = new JsonRpcProvider({ url: NEAR_RPC });
const giverSigner = new Account(giverAccount, provider, KeyPairSigner.fromSecretKey(giver.secretKey as KeyPairString));
const created = await giverSigner.callFunctionRaw({
  contractId: CONTRACT,
  methodName: "create_jar",
  args: {
    child_address: CHILD_ADDRESS,
    cap: "2500",
    period: "86400",
    unlock_at: String(Math.floor(Date.now() / 1000) + YEAR),
    guardians: guardianAccounts,
    family_account: giverAccount,
    nickname: "Backend check",
  },
  deposit: STORAGE_DEPOSIT,
  gas: CREATE_GAS,
});
const status = created.status as { SuccessValue?: string };
const jarId = JSON.parse(Buffer.from(status.SuccessValue ?? "", "base64").toString()) as string;
check(typeof jarId === "string", `the giver created jar ${jarId} from their own funded account`);

const closed = await backend("POST", `/drafts/${draftId}/jar`, { jarId });
check(closed.status === 200, "the draft closed once the jar's guardians matched");
check((await backend("GET", `/drafts/${draftId}`)).body.code === "DRAFT_NOT_FOUND", "the pending invites are gone");

// The deposit's and gas refunds land a few blocks after the call.
await sleep(10_000);
const giverAfter = await rpcQuery({ request_type: "view_account", account_id: giverAccount });
writeFileSync(
  EVIDENCE,
  `${JSON.stringify(
    {
      about:
        "Testnet check of T15 (koukikouks/sats-jar#18): accounts made by the backend's sponsor from device keys, each with exactly one key (the device's) as read from NEAR RPC view_access_key_list, and a jar created from the giver's own funded account. Written by backend/src/verify-testnet.ts.",
      at: new Date().toISOString(),
      sponsor: giverAccount.split(".").slice(1).join("."),
      contract: CONTRACT,
      accounts,
      create_jar: {
        near_tx: created.transaction_outcome.id,
        explorer: `https://testnet.nearblocks.io/txns/${created.transaction_outcome.id}`,
        jar_id: jarId,
        guardians: guardianAccounts,
        giver_balance_after_yocto: (giverAfter?.amount ?? null) as Json,
      },
      draft_cleared: true,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${EVIDENCE.pathname}`);
