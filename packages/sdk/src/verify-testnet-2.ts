// Testnet check of the App SDK part 2 (koukikouks/sats-jar#22): runs every part-2 function
// against the dev contract, with T15's backend handler in-process on its live sponsor chain.
//
//   node --experimental-transform-types --env-file=<env> packages/sdk/src/verify-testnet-2.ts <devices file>
//
// The env supplies SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY and CONTRACT_ACCOUNT_ID (the fresh
// dev contract). The devices file (keep it outside the repo; the same file as part 1's check)
// holds the test devices' PIN-locked keys, so later runs reuse their accounts: giver and two
// guardians (adult devices), child and friend (recovery-phrase phones). A first run makes the
// accounts it lacks at 0.25 NEAR each. The jar is a new, empty demo-timing jar: no Bitcoin is
// spent, so the spend is a real INSUFFICIENT_BALANCE refusal and the transfer moves an empty jar.
// It takes about 6 minutes (the 3-minute handover delay and the unlock date).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlock } from "@sats-jar/device-keys";
import { createBackend } from "../../../backend/src/http.ts";
import { fileStore } from "../../../backend/src/file-store.ts";
import { nearChain } from "../../../backend/src/chain.ts";
import { SatsJarRefusal, type DeviceStorage, type SatsJar } from "./api.ts";
import { createApp } from "./app.ts";
import { near, result } from "./near.ts";

const DEVICES = process.argv[2] ?? "";
const SPONSOR = process.env.SPONSOR_ACCOUNT_ID ?? "";
const CONTRACT = process.env.CONTRACT_ACCOUNT_ID ?? "";
const BACKEND = "https://backend.local";
const PIN = "482913"; // test devices only
const CHILD_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"; // BIP-84's published test address
if (!DEVICES || !SPONSOR || !CONTRACT || !process.env.SPONSOR_PRIVATE_KEY) {
  throw new Error("usage: SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY, CONTRACT_ACCOUNT_ID in the env; a devices file path as the argument");
}

const backend = createBackend({
  chain: nearChain({ sponsorAccountId: SPONSOR, sponsorPrivateKey: process.env.SPONSOR_PRIVATE_KEY, contractAccountId: CONTRACT }),
  store: fileStore(join(mkdtempSync(join(tmpdir(), "sats-jar-sdk-check-")), "drafts.json")),
  appAccount: SPONSOR,
  // The keeper is not part of the app's flows; it does nothing here.
  keeper: { run: async () => ({ startedAt: 0, steps: [] }) },
});
const http: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(BACKEND)) return fetch(input, init);
  return backend(new Request(url.replace(BACKEND, "http://backend.local"), init));
};
const chain = near(http, CONTRACT);

type Records = Record<string, string>;
const all = (): Record<string, Records> =>
  existsSync(DEVICES) ? (JSON.parse(readFileSync(DEVICES, "utf8")) as Record<string, Records>) : {};

/** One test device's storage, kept in the devices file between runs. */
function fileDevice(name: string): DeviceStorage {
  const save = (change: (records: Records) => void) => {
    const devices = all();
    const records = devices[name] ?? {};
    change(records);
    writeFileSync(DEVICES, JSON.stringify({ ...devices, [name]: records }));
  };
  return {
    get: async (key) => all()[name]?.[key] ?? null,
    set: async (key, value) => save((r) => void (r[key] = value)),
    delete: async (key) => save((r) => void delete r[key]),
  };
}

/** The device's record as the SDK stored it (script only: its account and public key). */
function deviceRecord(name: string): { accountId: string; publicKey: string; locked: Parameters<typeof unlock>[0] } {
  return JSON.parse(all()[name]?.["sats-jar:device"] ?? "null") as never;
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok: ${what}`);
}

async function refused(what: Promise<unknown>): Promise<SatsJarRefusal> {
  const outcome = await what.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(outcome instanceof SatsJarRefusal)) throw new Error(`expected a refusal, got ${String(outcome)}`);
  return outcome;
}

const app = (name: string): SatsJar => createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: fileDevice(name) }, http);

async function adult(name: string): Promise<SatsJar> {
  const device = app(name);
  if ((await device.device.state()) === "new") await device.device.setUp({ pin: PIN });
  else await device.device.unlock({ pin: PIN });
  return device;
}

/** A recovery-phrase phone: "Set up my jar" on the first run, unlocked with its PIN after. */
async function phone(name: string): Promise<SatsJar> {
  const device = app(name);
  if ((await device.device.state()) === "new") {
    const { words, check: asked } = await device.child.startSetUp();
    const wrong = await refused(device.child.finishSetUp({ words: asked.map((index) => ({ index, word: "zzz" })), pin: PIN }));
    check(wrong.code === "WRONG_RECOVERY_WORDS", `${name}: wrong words are refused (${wrong.message})`);
    await device.child.finishSetUp({ words: asked.map((index) => ({ index, word: words[index] ?? "" })), pin: PIN });
    console.log(`set up ${name}'s phone`);
  } else {
    await device.device.unlock({ pin: PIN });
  }
  const { accountId, publicKey } = deviceRecord(name);
  // A brand-new account shows at final a few blocks after the backend made it.
  let keys = await chain.accessKeys(accountId);
  for (let attempt = 1; keys.length === 0 && attempt < 10; attempt += 1) {
    await wait(1);
    keys = await chain.accessKeys(accountId);
  }
  check(
    keys.length === 1 && keys[0]?.public_key === publicKey && keys[0].access_key.permission === "FullAccess",
    `${name}'s account ${accountId} has the phone's key as its only key`,
  );
  return device;
}

const now = () => Math.floor(Date.now() / 1000);
const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const giver = await adult("giver");
const guardians = [await adult("guardian 1"), await adult("guardian 2")];
const child = await phone("child");
const friend = await phone("friend");

// A fresh, empty demo-timing jar unlocking in 3 minutes.
const draft = await giver.invites.start({ nickname: "SDK check 2", guardians: 2 });
for (const [n, guardian] of guardians.entries()) await guardian.invites.join(draft.inviteTokens[n] ?? "");
const unlockAt = now() + 180;
const { jarId } = await giver.jars.create({ draftId: draft.draftId, childAddress: CHILD_ADDRESS, cap: 2_500, period: 600, unlockAt });
console.log(`jar ${jarId} on ${CONTRACT}`);

// "Try it" before handover.
const early = await guardians[0]!.tryIt.earlySpend(jarId);
check(early.code === "SPEND_BEFORE_HANDOVER", `a guardian's early spend: "${early.message}" ${early.explorerUrl}`);
const outsider = await friend.tryIt.outsiderApproval(jarId);
check(outsider.code === "NOT_A_GUARDIAN", `an outsider's approval: "${outsider.message}" ${outsider.explorerUrl}`);

// Emergency: propose, approve (the delay starts), the giver cancels.
const proposed = await guardians[0]!.emergency.propose(jarId, 2_000);
const open = (await giver.jars.status(jarId)).emergency;
check(open.state === "open" && open.approvals === 1 && open.delayEndsAt === null, `proposal ${proposed.proposalId} is open with 1 approval ${proposed.explorerUrl}`);
await guardians[1]!.emergency.approve(jarId, proposed.proposalId);
const approved = (await giver.jars.status(jarId)).emergency;
check(approved.state === "open" && approved.approvals === 2 && approved.delayEndsAt !== null, `2 approvals: the public delay runs to ${approved.state === "open" ? approved.delayEndsAt : ""}`);
const notGiver = await refused(guardians[0]!.emergency.cancel(jarId));
check(notGiver.code === "NOT_THE_GIVER", `a guardian cannot cancel: "${notGiver.message}" ${notGiver.explorerUrl}`);
await giver.emergency.cancel(jarId);
check((await giver.jars.status(jarId)).emergency.state === "cancelled", "the giver cancelled it");

// Handover: claim, the code check, a guardian's cancel, a fresh claim, two confirmations.
const code = await child.child.guardianCode();
await child.child.claim(jarId);
check((await child.jars.status(jarId)).roles.includes("child"), "the child's phone claimed the jar");
const first = await guardians[0]!.handover.check(jarId);
check(first.code === code, `guardian 1 reads the child's code from the chain: ${first.code}`);
await guardians[0]!.handover.cancel(jarId);
check((await giver.jars.status(jarId)).handover.state === "none", "a guardian cancelled the claim");
await child.child.claim(jarId);
for (const guardian of guardians) {
  const checked = await guardian.handover.check(jarId);
  check(checked.code === code, "the code matches the child's phone");
  await guardian.handover.confirm(jarId, checked);
}
const confirmed = (await giver.jars.status(jarId)).handover;
if (confirmed.state !== "confirmed") throw new Error("not confirmed");
console.log(`ok: confirmed; the public delay ends in ${confirmed.delayEndsAt - now()} s`);

// Completion is the keeper's (T17), not the SDK's: the script asks for it from the giver's account.
await wait(Math.max(confirmed.delayEndsAt, unlockAt) - now() + 10);
const giverKeys = await unlock(deviceRecord("giver").locked, { kind: "pin", pin: PIN });
const completion = await chain.send(
  await chain.sign(
    { accountId: deviceRecord("giver").accountId, secretKey: giverKeys.near.secretKey },
    { method: "complete_handover", args: { jar_id: jarId, fee_rate: "1" }, gas: 100_000_000_000_000n, deposit: 0n },
  ),
);
check(!("refusal" in result(completion, CONTRACT)), "complete_handover moved the empty jar to the child");
const done = await child.jars.status(jarId);
check(done.handover.state === "done" && done.roles.includes("holder"), "the child holds the jar");
console.log(`ok: exit note: ${done.exit.note}`);
const afterwards = await giver.tryIt.afterHandover(jarId);
check(afterwards.code === "NOT_THE_HOLDER", `the family account's spend after handover: "${afterwards.message}" ${afterwards.explorerUrl}`);

// The holder: a spend from the empty jar, then a transfer to the friend.
const spend = await refused(child.holder.spend(jarId, { to: CHILD_ADDRESS, amount: 1_000 }));
check(spend.code === "INSUFFICIENT_BALANCE", `the holder's spend reaches the rule: "${spend.message}" ${spend.explorerUrl}`);
const receiveCode = await friend.holder.receiveCode();
await child.holder.startTransfer(jarId, receiveCode);
check((await friend.jars.status(jarId)).transfer.state === "offered", `a transfer to the friend's receive code ${receiveCode}`);
await child.holder.cancelTransfer(jarId);
check((await friend.jars.status(jarId)).transfer.state === "none", "the holder cancelled it");
await child.holder.startTransfer(jarId, receiveCode);
const accepted = await friend.holder.acceptTransfer(jarId);
const moved = await friend.jars.status(jarId);
check(moved.roles.includes("holder"), `the friend accepted with their own key and holds the jar ${accepted.explorerUrl}`);
console.log("all part-2 checks passed");
