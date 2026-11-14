// The contract's views, as the proof view shows them. Sats fit a JS number (21e14 < 2^53);
// times are unix seconds.
import { bitcoinAddressUrl, bitcoinTransactionUrl } from "./explorer.ts";

export interface JarView {
  jar_id: string;
  giver: string;
  owner_id: string;
  create_args: {
    child_address: string;
    cap: string;
    period: string;
    unlock_at: string;
    guardians: string[];
    family_account: string;
    nickname: string;
  };
  address: string;
  /** Oldest first. Builds before re-homing kept old addresses (the T06 dev contract) leave it out. */
  old_addresses?: string[];
  witness_script: string;
  public_key: string;
  locktime: number;
  demo_timing: boolean;
  clock: { started_at: string | null };
  handover: unknown;
  /** Builds before emergency payments and transfers (the T06 dev contract) leave these out. */
  emergency?: unknown;
  transfer?: unknown;
  proven_balance: string;
  available_allowance: string;
  fee_budget_left: string;
  next_allowance_at: string | null;
}

export interface CoinView {
  txid: string;
  vout: number;
  value: string;
  status: string;
  payment_id: string | null;
}

export interface PaymentView {
  payment_id: string;
  jar_id: string;
  kind: string;
  status: string;
  failure: string | null;
  txid: string;
  amount: string;
  fee: string;
  change: string;
}

export type HistoryView = { index: number; at: string; event: string } & Record<string, unknown>;

export interface TokenView {
  metadata: { title: string; description: string; media: string };
}

export interface Coin {
  txid: string;
  vout: number;
  value: number;
  /** "confirmed", "reserved" or "spent". */
  status: string;
  paymentId: string | null;
  explorerUrl: string;
}

export interface Payment {
  paymentId: string;
  kind: string;
  /** "signing", "signing_failed", "signed", "confirmed" or "cancelled". */
  status: string;
  failure: string | null;
  txid: string;
  amount: number;
  fee: number;
  change: number;
  explorerUrl: string;
}

/** One record of the jar's on-chain history; fields beyond `event` depend on the event. */
export interface HistoryEvent {
  index: number;
  at: number;
  event: string;
  txid?: string;
  vout?: number;
  value?: number;
  paymentId?: string;
  reason?: string;
  attempt?: number;
  childAccount?: string;
  /** Compressed public key, hex. */
  childBtcPubkey?: string;
  lapsesAt?: number;
  guardian?: string;
  /** Set by the second confirmation, which starts the delay; null before it. */
  delayEndsAt?: number | null;
  by?: string;
  lapsedAt?: number;
}

export interface JarProof {
  jarId: string;
  nickname: string;
  /** The account holding the jar NFT: the family account until handover. */
  holder: string;
  giver: string;
  familyAccount: string;
  guardians: string[];
  childAddress: string;
  cap: number;
  period: number;
  unlockAt: number;
  demoTiming: boolean;
  address: string;
  addressExplorerUrl: string;
  /** The addresses the jar moved away from at each re-homing, oldest first. */
  oldAddresses: string[];
  witnessScript: string;
  publicKey: string;
  locktime: number;
  provenBalance: number;
  availableAllowance: number;
  feeBudgetLeft: number;
  nextAllowanceAt: number | null;
  clockStartedAt: number | null;
  /** `"none"`, or the contract's handover record as it reads it. */
  handover: unknown;
  /** The open emergency proposal, or null, as the contract reads it. */
  emergency: unknown;
  /** The holder's transfer in progress, or null, as the contract reads it. */
  transfer: unknown;
  nft: { title: string; description: string; media: string };
  coins: Coin[];
  payments: Payment[];
  history: HistoryEvent[];
}

export function toJarProof(
  view: JarView,
  coins: CoinView[],
  payments: PaymentView[],
  history: HistoryView[],
  token: TokenView,
): JarProof {
  const args = view.create_args;
  return {
    jarId: view.jar_id,
    nickname: args.nickname,
    holder: view.owner_id,
    giver: view.giver,
    familyAccount: args.family_account,
    guardians: args.guardians,
    childAddress: args.child_address,
    cap: Number(args.cap),
    period: Number(args.period),
    unlockAt: Number(args.unlock_at),
    demoTiming: view.demo_timing,
    address: view.address,
    addressExplorerUrl: bitcoinAddressUrl(view.address),
    oldAddresses: view.old_addresses ?? [],
    witnessScript: view.witness_script,
    publicKey: view.public_key,
    locktime: view.locktime,
    provenBalance: Number(view.proven_balance),
    availableAllowance: Number(view.available_allowance),
    feeBudgetLeft: Number(view.fee_budget_left),
    nextAllowanceAt: view.next_allowance_at === null ? null : Number(view.next_allowance_at),
    clockStartedAt: view.clock.started_at === null ? null : Number(view.clock.started_at),
    handover: view.handover,
    emergency: view.emergency ?? null,
    transfer: view.transfer ?? null,
    nft: { title: token.metadata.title, description: token.metadata.description, media: token.metadata.media },
    coins: coins.map((c) => ({
      txid: c.txid,
      vout: c.vout,
      value: Number(c.value),
      status: c.status,
      paymentId: c.payment_id,
      explorerUrl: bitcoinTransactionUrl(c.txid),
    })),
    payments: payments.map((p) => ({
      paymentId: p.payment_id,
      kind: p.kind,
      status: p.status,
      failure: p.failure,
      txid: p.txid,
      amount: Number(p.amount),
      fee: Number(p.fee),
      change: Number(p.change),
      explorerUrl: bitcoinTransactionUrl(p.txid),
    })),
    history: history.map(toHistoryEvent),
  };
}

/** The payments the jar's history mentions, in first-mention order. */
export function paymentIds(history: HistoryView[]): string[] {
  return [...new Set(history.flatMap((h) => (typeof h.payment_id === "string" ? [h.payment_id] : [])))];
}

function toHistoryEvent(h: HistoryView): HistoryEvent {
  return {
    index: h.index,
    at: Number(h.at),
    event: h.event,
    ...(typeof h.txid === "string" ? { txid: h.txid } : {}),
    ...(typeof h.vout === "number" ? { vout: h.vout } : {}),
    ...(typeof h.value === "string" ? { value: Number(h.value) } : {}),
    ...(typeof h.payment_id === "string" ? { paymentId: h.payment_id } : {}),
    ...(typeof h.reason === "string" ? { reason: h.reason } : {}),
    ...(typeof h.attempt === "number" ? { attempt: h.attempt } : {}),
    ...(typeof h.child_account === "string" ? { childAccount: h.child_account } : {}),
    ...(typeof h.child_btc_pubkey === "string" ? { childBtcPubkey: h.child_btc_pubkey } : {}),
    ...(typeof h.lapses_at === "string" ? { lapsesAt: Number(h.lapses_at) } : {}),
    ...(typeof h.guardian === "string" ? { guardian: h.guardian } : {}),
    ...("delay_ends_at" in h ? { delayEndsAt: typeof h.delay_ends_at === "string" ? Number(h.delay_ends_at) : null } : {}),
    ...(typeof h.by === "string" ? { by: h.by } : {}),
    ...(typeof h.lapsed_at === "string" ? { lapsedAt: Number(h.lapsed_at) } : {}),
  };
}
