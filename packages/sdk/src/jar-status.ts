// A jar as its screens show it: built from the proof view's reader (T20) over public APIs, plus
// who this device's person is to the jar.
import { JarNotFoundError, ProofUnavailableError, createProofReader, type JarProof } from "@sats-jar/proof";
import {
  SatsJarRefusal,
  type Allowance,
  type EmergencyStatus,
  type HandoverStatus,
  type JarStatus,
  type JarSummary,
  type Role,
  type TopUp,
  type TransferStatus,
} from "./api.ts";
import type { Near } from "./near.ts";
import { refusal, unavailable } from "./refusals.ts";

const DUST_FLOOR = 1_000; // the contract's top-up floor (story 18)
const PAGE = 50; // NEP-181 enumeration pages (findings-t09)
// The handover's public delay (contract handover.rs): 3 days, or 3 minutes under demo timing.
const HANDOVER_DELAY = 3 * 86_400;
const DEMO_HANDOVER_DELAY = 3 * 60;
const EXPLORERS = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];
// A jar page's sections poll within a moment of each other; a read this fresh serves them all.
const SHARED_MS = 5_000;
// A read failing for network reasons shows the last good one while it is this young (spec #58).
const KEEP_GOOD_MS = 60_000;

/** One jar's reads: the one on its way, and the last good one with when it finished. */
interface Reads {
  generation: number;
  inflight?: Promise<JarProof>;
  good?: { proof: JarProof; at: number };
}

interface ViewJar {
  giver: string;
  owner_id: string;
  create_args: { guardians: string[]; nickname: string; unlock_at: string };
  proven_balance: string;
  demo_timing: boolean;
  handover: unknown;
}

export function jarReader(deps: { http: typeof fetch; near: Near; contract: string; me: () => Promise<string | null> }) {
  const proof = createProofReader({ contract: deps.contract, fetch: deps.http });

  const reads = new Map<string, Reads>();
  let generation = 0;

  /** The jar, read once for every section asking within a moment (spec #58). */
  function read(jarId: string): Promise<JarProof> {
    const now = Date.now();
    let entry = reads.get(jarId);
    if (entry?.generation !== generation) {
      entry = { generation };
      reads.set(jarId, entry);
    }
    if (entry.inflight) return entry.inflight;
    if (entry.good && now - entry.good.at < SHARED_MS) return Promise.resolve(entry.good.proof);
    const mine = entry;
    const inflight = proof.jar(jarId).then(
      (fresh) => {
        // A read started before this device last wrote must not stand in for the jar after it.
        if (mine.generation === generation) mine.good = { proof: fresh, at: Date.now() };
        return fresh;
      },
      (error: unknown) => {
        const good = mine.generation === generation ? mine.good : undefined;
        if (error instanceof ProofUnavailableError && good && Date.now() - good.at < KEEP_GOOD_MS) return good.proof;
        throw translate(error);
      },
    );
    mine.inflight = inflight;
    const done = () => {
      if (mine.inflight === inflight) mine.inflight = undefined;
    };
    inflight.then(done, done);
    return inflight;
  }

  /** Called after every write from this device: the next read of any jar goes to the chain. */
  function forget(): void {
    generation += 1;
    reads.clear();
  }

  async function status(jarId: string): Promise<JarStatus> {
    const [jar, me] = await Promise.all([read(jarId), deps.me()]);
    const now = Math.floor(Date.now() / 1000);
    const handedOver = typeof jar.handover === "object" && jar.handover !== null && "done" in jar.handover;
    return {
      jarId: jar.jarId,
      nickname: jar.nickname,
      roles: roles(me, { giver: jar.giver, holder: jar.holder, guardians: jar.guardians, handover: jar.handover }),
      balance: jar.provenBalance,
      picture: jar.nft.media,
      demoTiming: jar.demoTiming,
      address: jar.address,
      qrPayload: `bitcoin:${jar.address}`,
      childAddress: jar.childAddress,
      cap: jar.cap,
      period: jar.period,
      unlockAt: jar.unlockAt,
      availableAllowance: jar.availableAllowance,
      nextAllowanceAt: jar.nextAllowanceAt,
      exit: {
        opensAt: jar.locktime,
        childAddress: jar.childAddress,
        // Story 62: after handover the jar's Bitcoin sits at an address whose exit branch is the
        // holder's own recovery-phrase key, so the exit never returns to an adult.
        note: handedOver
          ? `If NEAR's signing network ever stops, the Bitcoin-only exit opens on ${day(jar.locktime)}, and only the holder's recovery phrase can use it.`
          : `If no handover happens, the Bitcoin-only exit opens on ${day(jar.locktime)} and pays the child's address, which a parent controls.`,
      },
      handover: handover(jar.handover, me, now, jar.unlockAt, jar.demoTiming),
      emergency: emergency(jar.emergency, me),
      transfer: transfer(jar.transfer, me),
    };
  }

  async function topUps(jarId: string): Promise<TopUp[]> {
    const jar = await read(jarId);
    let seen;
    try {
      seen = await proof.bitcoinTransactions(jar);
    } catch (error) {
      throw translate(error);
    }
    const counted = new Set(jar.history.flatMap((h) => (h.event === "topup_proven" && h.txid ? [h.txid] : [])));
    const payments = new Set(jar.payments.map((p) => p.txid));
    const arriving = seen.filter((tx) => tx.received > 0 && !counted.has(tx.txid) && !payments.has(tx.txid));
    const tip = arriving.some((tx) => tx.blockHeight !== null && tx.received >= DUST_FLOOR) ? await tipHeight() : 0;
    const uncounted: TopUp[] = arriving.map((tx) => {
      const tooSmall = tx.received < DUST_FLOOR;
      const confirming = !tooSmall && tx.blockHeight !== null;
      return {
        txid: tx.txid,
        value: tx.received,
        status: tooSmall ? "too_small" : confirming ? "confirming" : "on_the_way",
        confirmations: confirming && tx.blockHeight !== null ? tip - tx.blockHeight + 1 : null,
        countedAt: null,
        explorerUrl: tx.explorerUrl,
      };
    });
    const proven: TopUp[] = jar.history
      .filter((h) => h.event === "topup_proven" && h.txid !== undefined)
      .reverse()
      .map((h) => ({
        txid: h.txid ?? "",
        value: h.value ?? 0,
        status: "counted",
        confirmations: null,
        countedAt: h.at,
        explorerUrl: `https://mempool.space/testnet/tx/${h.txid ?? ""}`,
      }));
    return [...uncounted, ...proven];
  }

  async function allowances(jarId: string): Promise<Allowance[]> {
    const jar = await read(jarId);
    const requested = new Map(
      jar.history.flatMap((h) => (h.event === "allowance_requested" && h.paymentId ? [[h.paymentId, h.at] as const] : [])),
    );
    return jar.payments
      .filter((p) => p.kind === "allowance")
      .map((p) => ({
        amount: p.amount,
        fee: p.fee,
        status: allowanceStatus(p.status),
        requestedAt: requested.get(p.paymentId) ?? 0,
        explorerUrl: p.explorerUrl,
      }));
  }

  async function mine(): Promise<JarSummary[]> {
    const me = await deps.me();
    if (me === null) return [];
    const found: JarSummary[] = [];
    for (let from = 0; ; from += PAGE) {
      const tokens = await deps.near.view<{ token_id: string; metadata: { media: string } }[]>("nft_tokens", {
        from_index: String(from),
        limit: PAGE,
      });
      const jars = await Promise.all(tokens.map((t) => deps.near.view<ViewJar | null>("get_jar", { jar_id: t.token_id })));
      tokens.forEach((token, i) => {
        const jar = jars[i];
        if (!jar) return;
        const mine = roles(me, {
          giver: jar.giver,
          holder: jar.owner_id,
          guardians: jar.create_args.guardians,
          handover: jar.handover,
        });
        if (mine.length === 0) return;
        found.push({
          jarId: token.token_id,
          nickname: jar.create_args.nickname,
          roles: mine,
          balance: Number(jar.proven_balance),
          picture: token.metadata.media,
          demoTiming: jar.demo_timing,
        });
      });
      if (tokens.length < PAGE) return found;
    }
  }

  async function tipHeight(): Promise<number> {
    for (const base of EXPLORERS) {
      try {
        const response = await deps.http(`${base}/blocks/tip/height`);
        if (response.ok) return Number(await response.json());
      } catch {
        // try the next explorer
      }
    }
    throw unavailable();
  }

  return { status, topUps, allowances, mine, forget };
}

function translate(error: unknown): Error {
  if (error instanceof JarNotFoundError) return refusal("UNKNOWN_JAR");
  if (error instanceof SatsJarRefusal) return error;
  // ProofUnavailableError, or an answer the reader could not make sense of: never raw text.
  return unavailable();
}

const ALLOWANCE_STATUSES: readonly Allowance["status"][] = ["signing", "signing_failed", "signed", "confirmed", "cancelled"];

/** The contract's payment status, checked; one this SDK does not know reads as UNAVAILABLE. */
function allowanceStatus(status: string): Allowance["status"] {
  const known = ALLOWANCE_STATUSES.find((s) => s === status);
  if (!known) throw unavailable();
  return known;
}

/** The claim's child account in any handover state that names one. */
function claimant(view: unknown): string | null {
  if (typeof view !== "object" || view === null) return null;
  const inner = Object.values(view)[0] as { child_account?: unknown } | undefined;
  return typeof inner?.child_account === "string" ? inner.child_account : null;
}

function roles(
  me: string | null,
  jar: { giver: string; holder: string; guardians: string[]; handover: unknown },
): Role[] {
  if (me === null) return [];
  const all: Role[] = [];
  if (jar.giver === me) all.push("giver");
  if (jar.guardians.includes(me)) all.push("guardian");
  if (jar.holder === me) all.push("holder");
  if (claimant(jar.handover) === me && jar.holder !== me) all.push("child");
  return all;
}

type Raw = Record<string, string | string[] | null | number | undefined>;

function handover(view: unknown, me: string | null, now: number, unlockAt: number, demo: boolean): HandoverStatus {
  if (typeof view !== "object" || view === null) return { state: "none" };
  const [[state, raw] = ["none", {}]] = Object.entries(view as Record<string, Raw>);
  const confirmedBy = (raw.confirmed_by as string[] | undefined) ?? [];
  const confirmedByMe = me !== null && confirmedBy.includes(me);
  switch (state) {
    case "claimed": {
      const delay = demo ? DEMO_HANDOVER_DELAY : HANDOVER_DELAY;
      return {
        state,
        claimedAt: Number(raw.claimed_at),
        lapsesAt: Number(raw.lapses_at),
        confirmations: confirmedBy.length,
        confirmedByMe,
        pausesAllowancesEarly: now + delay < unlockAt,
      };
    }
    case "confirmed": {
      const delayEndsAt = Number(raw.delay_ends_at);
      return { state, claimedAt: Number(raw.claimed_at), delayEndsAt, confirmedByMe, pausesAllowancesEarly: delayEndsAt < unlockAt };
    }
    case "completing":
      return { state, coinsToMove: Number(raw.coins_to_move), coinsLeft: Number(raw.coins_left) };
    case "done":
      return { state, completedAt: Number(raw.completed_at) };
    default:
      return { state: "none" };
  }
}

function transfer(view: unknown, me: string | null): TransferStatus {
  if (typeof view !== "object" || view === null) return { state: "none" };
  const [[state, raw] = ["none", {}]] = Object.entries(view as Record<string, Raw>);
  const toMe = me !== null && raw.receiver === me;
  switch (state) {
    case "started":
      return { state: "offered", toMe };
    case "accepted":
      return { state: "moving", toMe, coinsToMove: Number(raw.coins_to_move), coinsLeft: Number(raw.coins_left) };
    default:
      return { state: "none" };
  }
}

function emergency(view: unknown, me: string | null): EmergencyStatus {
  if (typeof view !== "object" || view === null) return { state: "none" };
  const [[state, raw] = ["none", {}]] = Object.entries(view as Record<string, Raw>);
  const proposalId = Number(raw.proposal_id);
  switch (state) {
    case "open": {
      const approvedBy = (raw.approved_by as string[] | undefined) ?? [];
      return {
        state,
        proposalId,
        amount: Number(raw.amount),
        approvals: approvedBy.length,
        approvedByMe: me !== null && approvedBy.includes(me),
        proposedAt: Number(raw.proposed_at),
        delayEndsAt: raw.delay_ends_at == null ? null : Number(raw.delay_ends_at),
      };
    }
    case "cancelled":
    case "executed":
    case "lapsed":
      return { state, proposalId };
    default:
      return { state: "none" };
  }
}

function day(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
