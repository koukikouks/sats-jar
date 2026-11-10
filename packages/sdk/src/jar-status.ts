// A jar as its screens show it: built from the proof view's reader (T20) over public APIs, plus
// who this device's person is to the jar.
import {
  JarNotFoundError,
  ProofUnavailableError,
  createProofReader,
  type JarProof,
} from "@sats-jar/proof";
import type {
  Allowance,
  EmergencyStatus,
  HandoverStatus,
  JarStatus,
  JarSummary,
  Role,
  TopUp,
} from "./api.ts";
import type { Near } from "./near.ts";
import { refusal, unavailable } from "./refusals.ts";

const DUST_FLOOR = 1_000; // the contract's top-up floor (story 18)
const PAGE = 50; // NEP-181 enumeration pages (findings-t09)
// The handover's public delay (contract handover.rs): 3 days, or 3 minutes under demo timing.
const HANDOVER_DELAY = 3 * 86_400;
const DEMO_HANDOVER_DELAY = 3 * 60;
const EXPLORERS = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];

interface ViewJar {
  giver: string;
  owner_id: string;
  create_args: { guardians: string[]; nickname: string; unlock_at: string };
  proven_balance: string;
  demo_timing: boolean;
  handover: unknown;
  emergency?: unknown;
}

export function jarReader(deps: { http: typeof fetch; near: Near; contract: string; me: () => Promise<string | null> }) {
  const proof = createProofReader({ contract: deps.contract, fetch: deps.http });

  async function read(jarId: string): Promise<JarProof> {
    try {
      return await proof.jar(jarId);
    } catch (error) {
      throw translate(error);
    }
  }

  async function status(jarId: string): Promise<JarStatus> {
    // The proof reader keeps no emergency field, so the jar's own view is read alongside it.
    const [jar, view, me] = await Promise.all([read(jarId), deps.near.view<ViewJar | null>("get_jar", { jar_id: jarId }), deps.me()]);
    const now = Math.floor(Date.now() / 1000);
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
        note: `If no handover happens, the Bitcoin-only exit opens on ${day(jar.locktime)} and pays the child's address, which a parent controls.`,
      },
      handover: handover(jar.handover, me, now, jar.unlockAt, jar.demoTiming),
      emergency: emergency(view?.emergency, me),
      transfer: { state: "none" },
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
        status: p.status as Allowance["status"],
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

  return { status, topUps, allowances, mine };
}

function translate(error: unknown): Error {
  if (error instanceof JarNotFoundError) return refusal("UNKNOWN_JAR");
  if (error instanceof ProofUnavailableError) return unavailable();
  return error instanceof Error ? error : unavailable();
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
    // PROVISIONAL (T10's plan).
    case "completing":
      return { state, coinsToMove: Number(raw.coins_to_move), coinsLeft: Number(raw.coins_left) };
    case "done":
      return { state, completedAt: Number(raw.completed_at) };
    default:
      return { state: "none" };
  }
}

/** PROVISIONAL (T13's view): absent until T13 merges. */
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
