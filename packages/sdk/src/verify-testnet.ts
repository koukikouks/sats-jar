// Testnet check of the App SDK part 1 (koukikouks/sats-jar#21): runs every part-1 function
// against the dev contract, with T15's backend handler in-process on its live sponsor chain.
//
//   node --experimental-transform-types --env-file=<env> packages/sdk/src/verify-testnet.ts <devices file>
//
// (transform-types: @sats-jar/proof uses TypeScript parameter properties, which plain type
// stripping cannot run.)
//
// The env supplies SPONSOR_ACCOUNT_ID and SPONSOR_PRIVATE_KEY (the backend's settings) and
// CONTRACT_ACCOUNT_ID. The devices file (keep it outside the repo) holds the three test
// devices' PIN-locked keys, so later runs reuse their accounts instead of funding new ones
// (0.25 NEAR each). No Bitcoin is spent.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../../../backend/src/http.ts";
import { fileStore } from "../../../backend/src/file-store.ts";
import { nearChain } from "../../../backend/src/chain.ts";
import { FULL_PERIOD, SatsJarRefusal, type DeviceStorage, type SatsJarPartOne } from "./api.ts";
import { createApp } from "./app.ts";
import { near } from "./near.ts";

const DEVICES = process.argv[2] ?? "";
const SPONSOR = process.env.SPONSOR_ACCOUNT_ID ?? "";
const CONTRACT = process.env.CONTRACT_ACCOUNT_ID ?? "sats-jar-dev.testnet";
const BACKEND = "https://backend.local";
const PIN = "482913"; // test devices only
if (!DEVICES || !SPONSOR || !process.env.SPONSOR_PRIVATE_KEY) {
  throw new Error("usage: SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY in the env; a devices file path as the argument");
}

const backend = createBackend({
  chain: nearChain({ sponsorAccountId: SPONSOR, sponsorPrivateKey: process.env.SPONSOR_PRIVATE_KEY, contractAccountId: CONTRACT }),
  store: fileStore(join(mkdtempSync(join(tmpdir(), "sats-jar-sdk-check-")), "drafts.json")),
  appAccount: SPONSOR,
});
let failCloses = 0;
const http: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(BACKEND)) return fetch(input, init);
  if (failCloses > 0 && url.endsWith("/jar")) {
    failCloses -= 1;
    throw new Error("forced: the draft close's answer is lost");
  }
  return backend(new Request(url.replace(BACKEND, "http://backend.local"), init));
};

/** One test device's storage, kept in the devices file between runs. */
function fileDevice(name: string): DeviceStorage {
  const all = (): Record<string, Record<string, string>> =>
    existsSync(DEVICES) ? (JSON.parse(readFileSync(DEVICES, "utf8")) as Record<string, Record<string, string>>) : {};
  const save = (change: (records: Record<string, string>) => void) => {
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

async function ready(name: string): Promise<SatsJarPartOne> {
  const app = createApp({ contract: CONTRACT, backendUrl: BACKEND, storage: fileDevice(name) }, http);
  if ((await app.device.state()) === "new") {
    await app.device.setUp({ pin: PIN });
    console.log(`made ${name}'s device`);
  } else {
    const wrong = await refused(app.device.unlock({ pin: "000000" }));
    check(wrong.code === "WRONG_PIN", `${name}: a wrong PIN is refused (${wrong.message})`);
    await app.device.unlock({ pin: PIN });
  }
  check((await app.device.state()) === "unlocked", `${name}'s device is unlocked`);
  return app;
}

const chain = near(http, CONTRACT);
const supply = async () => Number(await chain.view<string>("nft_total_supply", {}));

const giver = await ready("giver");
const guardians = [await ready("guardian 1"), await ready("guardian 2")];

// Invites: a draft with two links, both joined.
const draft = await giver.invites.start({ nickname: "SDK check", guardians: 2 });
check(draft.inviteTokens.length === 2, "the giver made 2 invite links, kept on the device");
for (const [n, guardian] of guardians.entries()) {
  const token = draft.inviteTokens[n] ?? "";
  check((await guardian.invites.preview(token)).nickname === "SDK check", `guardian ${n + 1} previews the link`);
  await guardian.invites.join(token);
}
check((await giver.invites.progress(draft.draftId)).joined.every(Boolean), "both guardians joined");
const used = await refused(guardians[0]!.invites.join(draft.inviteTokens[0] ?? ""));
check(used.code === "INVITE_USED", `a used link is refused (${used.message})`);

// Every create refusal the giver can reach from the app, each a real refused transaction.
const valid = {
  draftId: draft.draftId,
  childAddress: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", // T07's public test-phrase address
  cap: 2_500,
  period: 600, // demo timing
  unlockAt: Math.floor(Date.now() / 1000) + 30 * 86_400,
};
const jar1 = await chain.view<{ address: string }>("get_jar", { jar_id: "1" });
const attempts: [string, Partial<typeof valid>][] = [
  ["INVALID_CHILD_ADDRESS", { childAddress: "not-an-address" }],
  ["CHILD_ADDRESS_WRONG_NETWORK", { childAddress: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" }],
  ["CHILD_ADDRESS_NOT_P2WPKH", { childAddress: jar1.address }],
  ["CAP_TOO_SMALL", { cap: 1_000 }],
  ["UNLOCK_IN_PAST", { unlockAt: 1_000_000_000 }],
  ["PERIOD_TOO_SHORT", { period: 30 }],
  ["LOCKTIME_OUT_OF_RANGE", { unlockAt: 4_294_967_000 }],
];
for (const [code, change] of attempts) {
  const refusal = await refused(giver.jars.create({ ...valid, ...change }));
  check(refusal.code === code && refusal.explorerUrl !== null, `${code}: "${refusal.message}" ${refusal.explorerUrl}`);
}
const half = await giver.invites.start({ nickname: "SDK check (one guardian)", guardians: 2 });
await guardians[0]!.invites.join(half.inviteTokens[0] ?? "");
const tooFew = await refused(giver.jars.create({ ...valid, draftId: half.draftId }));
check(tooFew.code === "TOO_FEW_GUARDIANS", `TOO_FEW_GUARDIANS: "${tooFew.message}" ${tooFew.explorerUrl}`);

// A real jar; its draft close fails once and the retry must not mint a second jar.
const before = await supply();
failCloses = 1;
const lost = await refused(giver.jars.create(valid));
check(lost.code === "UNAVAILABLE", "the first create's draft close was lost");
const created = await giver.jars.create(valid);
check((await supply()) === before + 1, `the retry returned jar ${created.jarId}; exactly one jar was minted`);
check(created.qrPayload === `bitcoin:${created.address}`, `jar ${created.jarId} pays to ${created.address}`);
check((await giver.invites.mine())[0]?.jarId === created.jarId, "the draft on the device names the jar");

// Following it, and jar 1 (a proven coin and a paid allowance from T06).
const status = await giver.jars.status(created.jarId);
check(status.balance === 0 && status.demoTiming && status.nextAllowanceAt === null, "the new jar is empty, demo timing, no allowance clock yet");
check(status.roles.join() === "giver,holder", "the giver gave and holds it (family account)");
check(status.exit.opensAt > valid.unlockAt, `exit note: ${status.exit.note}`);
check((await giver.jars.topUps(created.jarId)).length === 0, "no top-ups yet");
check((await giver.jars.allowances(created.jarId)).length === 0, "no allowances yet");
check((await guardians[1]!.jars.status(created.jarId)).roles.join() === "guardian", "guardian 2 sees itself as a guardian");
const one = await giver.jars.status("1");
check(one.balance === 1_260, "jar 1 holds the 1,260 sats T06 left");
const topUps = await giver.jars.topUps("1");
check(topUps.filter((t) => t.status === "counted").length === 2, "jar 1 shows its two counted top-ups");
const allowances = await giver.jars.allowances("1");
check(allowances.length === 1 && allowances[0]?.status === "confirmed" && allowances[0].amount === 2_500, "jar 1 shows its confirmed 2,500-sat allowance");
check((await giver.jars.mine()).some((j) => j.jarId === created.jarId), "the giver's jar list has the new jar");
check((await guardians[0]!.jars.mine()).some((j) => j.jarId === created.jarId && j.roles.includes("guardian")), "guardian 1's jar list has it too");
const unknown = await refused(giver.jars.status("999999"));
check(unknown.code === "UNKNOWN_JAR", "an unknown jar is refused as UNKNOWN_JAR");
console.log("all part-1 checks passed");
