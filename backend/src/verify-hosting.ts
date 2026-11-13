// Testnet check of T30 (koukikouks/sats-jar#46): the hosted keeper has one key that can only call
// the locked contract, and the backend on Railway answers, keeping a draft across a redeploy.
// Every step goes to evidence/hosting.json.
//
//   node backend/src/verify-hosting.ts keeper <creation tx>
//   node backend/src/verify-hosting.ts backend <backend url>
//   node backend/src/verify-hosting.ts after-redeploy <backend url>
//
// Reads no key. The check draft's id is the giver's link to it (backend README), so it is kept
// outside the repo between the backend and after-redeploy steps and never written to evidence.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { NEAR_RPC } from "./rpc.ts";

const CONTRACT = "sats-jar.testnet";
const KEEPER = "keeper-locked.sats-jar-app.testnet";
const NICKNAME = "Hosting check";
const EVIDENCE = new URL("../../evidence/hosting.json", import.meta.url);
const DRAFT_FILE = join(tmpdir(), "sats-jar-hosting-draft.json");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Evidence = { [key: string]: Json };

function evidence(): Evidence {
  if (!existsSync(EVIDENCE)) {
    return {
      about:
        "Hosting checks of spec #45 (koukikouks/sats-jar#45): the hosted keeper's keys on the locked contract, and the backend on Railway. Written by backend/src/verify-hosting.ts.",
      contract: CONTRACT,
      keeper: KEEPER,
    };
  }
  return JSON.parse(readFileSync(EVIDENCE, "utf8")) as Evidence;
}

function set(section: string, value: Json): void {
  const data = { ...evidence(), [section]: value };
  writeFileSync(EVIDENCE, `${JSON.stringify(data, null, 2)}\n`);
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
}

async function keeper(creationTx: string): Promise<void> {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const { keys } = await provider.viewAccessKeyList({ accountId: KEEPER, finalityQuery: { finality: "final" } });
  const only = keys[0]?.access_key.permission;
  check(keys.length === 1, `${KEEPER} has exactly one key (has ${keys.length})`);
  check(
    typeof only === "object" && "FunctionCall" in only && only.FunctionCall.receiver_id === CONTRACT,
    `its key is a function-call key on ${CONTRACT}`,
  );
  set("keeper_setup", {
    at: new Date().toISOString(),
    account: KEEPER,
    creation_tx: creationTx,
    explorer: `https://testnet.nearblocks.io/txns/${creationTx}`,
    keys: keys as unknown as Json,
  });
}

async function call(url: string, method: string, path: string, body?: Json) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, answer: (await response.json()) as { [key: string]: Json } };
}

async function backend(url: string): Promise<void> {
  const run = await call(url, "POST", "/keeper/run");
  check(run.status === 200 && Array.isArray(run.answer.steps), "POST /keeper/run answers with a report");
  const draft = await call(url, "POST", "/drafts", { nickname: NICKNAME, invites: 2 });
  check(draft.status === 201 && typeof draft.answer.draftId === "string", "POST /drafts makes a draft");
  writeFileSync(DRAFT_FILE, JSON.stringify({ draftId: draft.answer.draftId }));
  const unknown = await call(url, "GET", "/no-such-endpoint");
  check(unknown.status === 404 && unknown.answer.code === "NOT_FOUND", "an unknown path answers NOT_FOUND");
  set("backend", {
    at: new Date().toISOString(),
    keeper_run: { status: run.status, startedAt: run.answer.startedAt ?? null, steps: run.answer.steps ?? null },
    draft_made: draft.status,
    unknown_path: unknown.answer,
  });
}

async function afterRedeploy(url: string): Promise<void> {
  const { draftId } = JSON.parse(readFileSync(DRAFT_FILE, "utf8")) as { draftId: string };
  const draft = await call(url, "GET", `/drafts/${encodeURIComponent(draftId)}`);
  check(draft.status === 200 && draft.answer.nickname === NICKNAME, "the draft is still there after a redeploy");
  set("after_redeploy", { at: new Date().toISOString(), draft_kept: true, nickname: NICKNAME });
}

const [step, arg] = process.argv.slice(2);
if (!arg) throw new Error("usage: verify-hosting.ts keeper <creation tx> | backend <url> | after-redeploy <url>");
if (step === "keeper") await keeper(arg);
else if (step === "backend") await backend(arg.replace(/\/$/, ""));
else if (step === "after-redeploy") await afterRedeploy(arg.replace(/\/$/, ""));
else throw new Error(`unknown step ${step}`);
