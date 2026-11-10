// The App SDK's typed interface: every flow the screens call, parts 1 (#21) and 2 (#22).
//
// The screens never see an account name, gas, a deposit or a signing prompt (ADR 0003); the
// SDK makes and keeps the keys on the device, pays from the person's own funded account and
// turns every refusal into a typed, readable `SatsJarRefusal`. Times are unix seconds and
// amounts are whole sats.

/** Unix seconds. */
export type UnixSeconds = number;
/** Whole satoshis. */
export type Sats = number;

/** A full period (ADR 0005), 30 days in seconds, as the contract counts it. Shorter periods are demo timing. */
export const FULL_PERIOD = 2_592_000;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/**
 * Where the device keeps its own records: the PIN-locked keys, its account, the giver's invite
 * links and the jars it knows. Nothing here ever leaves the device. `browserStorage()` wraps
 * `localStorage`; tests and scripts pass their own.
 *
 * @example
 * const memory = new Map<string, string>();
 * const storage: DeviceStorage = {
 *   get: async (key) => memory.get(key) ?? null,
 *   set: async (key, value) => void memory.set(key, value),
 *   delete: async (key) => void memory.delete(key),
 * };
 */
export interface DeviceStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Where the SDK finds the jar contract and the app's backend.
 *
 * @example
 * const app = createSatsJar({
 *   contract: "sats-jar-dev.testnet",
 *   backendUrl: "https://app.example/api",
 *   storage: browserStorage(),
 * });
 */
export interface SatsJarConfig {
  /** The jar contract (testnet). Switching to the locked contract is a configuration change. */
  contract: string;
  /** The app backend's base URL (sponsored accounts, guardian invites). */
  backendUrl: string;
  storage: DeviceStorage;
}

/** Makes the SDK. */
export type CreateSatsJar = (config: SatsJarConfig) => SatsJar;

/** Everything the screens call. */
export interface SatsJar extends SatsJarPartOne, SatsJarPartTwo {}

/** Part 1 (#21): the device, guardian invites, creating and following a jar. */
export interface SatsJarPartOne {
  device: Device;
  invites: Invites;
  jars: Jars;
}

/** Part 2 (#22): the child's account, handover, emergency payment, the holder, "try it". */
export interface SatsJarPartTwo {
  child: Child;
  handover: Handover;
  emergency: Emergency;
  holder: Holder;
  tryIt: TryIt;
}

// ---------------------------------------------------------------------------------------------
// Results and refusals
// ---------------------------------------------------------------------------------------------

/** A transaction the person's account sent and the chain accepted. */
export interface Sent {
  /** The transaction on a public explorer, for the proof view's "check it yourself". */
  explorerUrl: string;
}

/**
 * Why something was refused. Contract codes are the contract's own (`contract/src/error.rs`);
 * the message is the SDK's, written for someone who has never used crypto, and never names an
 * account, gas or NEAR.
 */
export type RefusalCode = ContractRefusalCode | BackendRefusalCode | DeviceRefusalCode;

/** Refusals from the jar contract (`contract/src/error.rs`; BAD_MPC_ROOT_KEY is init-only and reads REFUSED). */
export type ContractRefusalCode =
  // create_jar
  | "INVALID_CHILD_ADDRESS"
  | "CHILD_ADDRESS_WRONG_NETWORK"
  | "CHILD_ADDRESS_NOT_P2WPKH"
  | "CAP_TOO_SMALL"
  | "UNLOCK_IN_PAST"
  | "TOO_FEW_GUARDIANS"
  | "TOO_MANY_GUARDIANS"
  | "DUPLICATE_GUARDIAN"
  | "PERIOD_TOO_SHORT"
  | "LOCKTIME_OUT_OF_RANGE"
  | "STORAGE_DEPOSIT_TOO_LOW"
  // top-ups (proven by the keeper; listed so a status can explain them)
  | "UNKNOWN_JAR"
  | "INVALID_TX"
  | "INVALID_PROOF"
  | "NOT_TO_JAR"
  | "NOT_IN_CHAIN"
  | "NOT_CONFIRMED"
  | "PROOF_TX_MISMATCH"
  | "COINBASE"
  | "BAD_TX_INDEX"
  | "BELOW_DUST"
  | "COIN_ALREADY_KNOWN"
  | "OWN_PAYMENT_TX"
  // payments
  | "NOT_ENOUGH_GAS"
  | "NOT_FUNDED"
  | "ALREADY_PAID"
  | "PAYMENT_PENDING"
  | "FEE_TOO_LOW"
  | "INSUFFICIENT_BALANCE"
  | "FEE_OVER_BUDGET"
  | "PAYMENT_TOO_SMALL"
  | "CHANGE_BELOW_DUST"
  | "UNKNOWN_PAYMENT"
  | "PAYMENT_ALREADY_CONFIRMED"
  | "PAYMENT_CANCELLED"
  | "PAYMENT_ALREADY_SIGNED"
  | "SIGNING_IN_PROGRESS"
  | "PAYMENT_NOT_SIGNED"
  // the NFT
  | "PLAIN_TRANSFER_REFUSED"
  | "APPROVAL_BEFORE_HANDOVER"
  | "NOT_THE_HOLDER"
  // handover
  | "NOT_THE_CHILD_ACCOUNT"
  | "INVALID_CHILD_KEY"
  | "CLAIM_OPEN"
  | "NOT_A_GUARDIAN"
  | "NO_OPEN_CLAIM"
  | "CLAIM_ALREADY_CONFIRMED"
  | "NOT_GUARDIAN_OR_CLAIMER"
  | "CLAIM_CHANGED"
  | "HANDOVER_IN_PROGRESS"
  // handover completion, re-homing and strays
  | "HANDOVER_NOT_CONFIRMED"
  | "HANDOVER_DELAY_RUNNING"
  | "BEFORE_UNLOCK"
  | "FEE_TOO_HIGH"
  | "OUTPUT_BELOW_DUST"
  | "HANDOVER_COMPLETING"
  | "HANDOVER_DONE"
  | "SPEND_BEFORE_HANDOVER"
  | "NO_STRAYS"
  | "REHOMING_IN_PROGRESS"
  // the holder: spend, approvals, transfer
  | "INVALID_ADDRESS"
  | "AMOUNT_BELOW_DUST"
  | "TOO_MANY_APPROVALS"
  | "TRANSFER_BEFORE_HANDOVER"
  | "TRANSFER_OPEN"
  | "NO_OPEN_TRANSFER"
  | "TRANSFER_ACCEPTED"
  | "NOT_THE_RECEIVER"
  | "INVALID_BTC_KEY"
  | "KEY_CHANGED"
  // emergency payment
  | "OVER_EMERGENCY_CAP"
  | "EMERGENCY_TOO_SMALL"
  | "PROPOSAL_OPEN"
  | "NO_OPEN_PROPOSAL"
  | "PROPOSAL_CHANGED"
  | "ALREADY_APPROVED"
  | "NOT_THE_GIVER"
  | "EMERGENCY_CANCELLED"
  | "DELAY_PASSED"
  | "EMERGENCY_NOT_APPROVED"
  | "DELAY_NOT_PASSED";

/** Refusals from the app's backend (its malformed-request and internal errors become UNAVAILABLE). */
export type BackendRefusalCode =
  | "INVITE_NOT_FOUND"
  | "INVITE_USED"
  | "ALREADY_GUARDIAN"
  | "BAD_INVITE_COUNT"
  | "INVALID_PUBLIC_KEY"
  | "DRAFT_NOT_FOUND"
  | "JAR_NOT_FOUND"
  | "GUARDIANS_DIFFER";

/** Refusals the SDK makes itself. */
export type DeviceRefusalCode =
  /** No keys on this device yet. */
  | "NO_DEVICE"
  /** Keys exist on this device already; setting up again would lose them. */
  | "ALREADY_SET_UP"
  /** The keys are locked; unlock with the PIN first. */
  | "LOCKED"
  | "WRONG_PIN"
  /** The network or a public service did not answer; try again. */
  | "UNAVAILABLE"
  /** The transaction failed before the jar's rule could answer. */
  | "TRANSACTION_FAILED"
  /** The jar's rule refused for a reason this SDK version has no message for. */
  | "REFUSED"
  /**
   * The claimed account is not one phone's own: it has another key, or its name is not the one the
   * app gives its key. Its code would prove nothing (handover check).
   */
  | "CLAIM_ACCOUNT_HAS_OTHER_KEYS"
  /** The call needs the child's recovery-phrase keys on this device. */
  | "NO_RECOVERY_PHRASE"
  /** The words typed back do not match the recovery phrase. */
  | "WRONG_RECOVERY_WORDS"
  /** These are not the 12 words of a recovery phrase. */
  | "INVALID_RECOVERY_PHRASE"
  /** The receive code was mistyped (its checksum does not match). */
  | "BAD_RECEIVE_CODE";

/**
 * Every refusal the SDK throws. Screens show `message`; they branch on `code` when a refusal
 * needs its own screen.
 *
 * @example
 * try {
 *   await app.jars.create(input);
 * } catch (error) {
 *   if (error instanceof SatsJarRefusal && error.code === "CAP_TOO_SMALL") showCapHint(error.message);
 *   else throw error;
 * }
 */
export class SatsJarRefusal extends Error {
  readonly code: RefusalCode;
  /** The refused transaction on a public explorer, when one was sent. */
  readonly explorerUrl: string | null;
  // No parameter properties: Node's type stripping (the testnet script) cannot run them.
  constructor(code: RefusalCode, message: string, explorerUrl: string | null = null) {
    super(message);
    this.name = "SatsJarRefusal";
    this.code = code;
    this.explorerUrl = explorerUrl;
  }
}

// ---------------------------------------------------------------------------------------------
// Part 1: the device
// ---------------------------------------------------------------------------------------------

/** "new": no keys yet; "locked": keys stored, PIN needed; "unlocked": ready to act. */
export type DeviceState = "new" | "locked" | "unlocked";

/**
 * This device's keys, locked with a PIN (ADR 0009). An adult's device holds a key made here and
 * shows no phrase (`setUp`); the child's phone holds its recovery phrase instead (`child.startSetUp`,
 * `child.restore`). `state`, `unlock` and `lock` work the same for both.
 */
export interface Device {
  /**
   * @example
   * if ((await app.device.state()) === "locked") showPinScreen();
   */
  state(): Promise<DeviceState>;
  /**
   * Makes this device's key and locks it with the PIN. Refuses ALREADY_SET_UP.
   *
   * @example
   * await app.device.setUp({ pin: "482913" });
   */
  setUp(input: { pin: string }): Promise<void>;
  /**
   * Unlocks the keys for this session. Refuses NO_DEVICE, WRONG_PIN.
   *
   * @example
   * await app.device.unlock({ pin: "482913" });
   */
  unlock(input: { pin: string }): Promise<void>;
  /**
   * Forgets the unlocked keys; the stored, locked keys stay.
   *
   * @example
   * app.device.lock();
   */
  lock(): void;
}

// ---------------------------------------------------------------------------------------------
// Part 1: guardian invites
// ---------------------------------------------------------------------------------------------

/** A jar being set up on the giver's device: its invite links until the jar exists. */
export interface Draft {
  draftId: string;
  nickname: string;
  /** One per guardian. The links cannot be fetched again from the server, so the device keeps them. */
  inviteTokens: string[];
  /** Set once the jar is created from this draft. */
  jarId: string | null;
}

/** Giver: invite 2-3 guardians by link. Guardian: join from a link (stories 10, 11, 32). */
export interface Invites {
  /**
   * Opens a draft with one invite link per guardian. The nickname is public (story 12).
   *
   * @example
   * const draft = await app.invites.start({ nickname: "Sunny's jar", guardians: 3 });
   * share(draft.inviteTokens.map((token) => `https://app.example/join/${token}`));
   */
  start(input: { nickname: string; guardians: 2 | 3 }): Promise<Draft>;
  /**
   * The drafts this device started, newest first.
   *
   * @example
   * const drafts = await app.invites.mine();
   */
  mine(): Promise<Draft[]>;
  /**
   * Who has joined so far, one entry per link. Refuses DRAFT_NOT_FOUND.
   *
   * @example
   * const { joined } = await app.invites.progress(draft.draftId);
   * const ready = joined.filter(Boolean).length >= 2;
   */
  progress(draftId: string): Promise<{ nickname: string; joined: boolean[] }>;
  /**
   * What an invite link is for, before joining. Refuses INVITE_NOT_FOUND.
   *
   * @example
   * const { nickname, joined } = await app.invites.preview(token);
   */
  preview(inviteToken: string): Promise<{ nickname: string; joined: boolean }>;
  /**
   * Joins as a guardian with this device (unlocked). A giver may join one of their own links
   * (story 11). Refuses INVITE_NOT_FOUND, INVITE_USED, ALREADY_GUARDIAN, LOCKED.
   *
   * @example
   * await app.invites.join(token);
   */
  join(inviteToken: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Part 1: jars
// ---------------------------------------------------------------------------------------------

/** What the giver chooses (stories 4-9). Guardians and the nickname come from the draft. */
export interface CreateJarInput {
  draftId: string;
  /** Native segwit (tb1q on testnet) from a wallet a parent controls, not an exchange (story 6). */
  childAddress: string;
  /** Most the child receives per period. */
  cap: Sats;
  /** Seconds per period: `FULL_PERIOD`, or shorter for a demo-timing jar. */
  period: number;
  /** Earliest handover, suggested as the 18th birthday. */
  unlockAt: UnixSeconds;
}

/** How this device's person relates to a jar. "child": this device's account made the open claim. */
export type Role = "giver" | "guardian" | "holder" | "child";

/** A jar in a list; `JarStatus` adds the rest. */
export interface JarSummary {
  jarId: string;
  nickname: string;
  roles: Role[];
  /** Proven sats in the jar. */
  balance: Sats;
  /** The jar's on-chain picture, a `data:image/svg+xml;base64,` URI. */
  picture: string;
  /** Shortened timing; show the "Demo timing" badge wherever this jar shows (spec). */
  demoTiming: boolean;
}

/** One jar, as its screen shows it. */
export interface JarStatus extends JarSummary {
  /** The jar's Bitcoin address, for topping up. */
  address: string;
  /** BIP-21 URI for the top-up QR code (`bitcoin:<address>`). */
  qrPayload: string;
  childAddress: string;
  cap: Sats;
  /** Seconds per period. */
  period: number;
  unlockAt: UnixSeconds;
  /** What an allowance requested now could pay, carry-over included. */
  availableAllowance: Sats;
  /** When the next allowance may go out; null before the first top-up. */
  nextAllowanceAt: UnixSeconds | null;
  /** The Bitcoin-only exit (story 53). */
  exit: {
    /** The current address's exit date: moved on by every re-homing (handover, transfer). */
    opensAt: UnixSeconds;
    /** Where it pays if no handover happens: the child's address, which a parent controls. */
    childAddress: string;
    /**
     * The sentence the app shows about it. After handover it says the exit answers only to the
     * holder's recovery-phrase key (story 62).
     */
    note: string;
  };
  handover: HandoverStatus;
  emergency: EmergencyStatus;
  transfer: TransferStatus;
}

/**
 * A top-up seen at the jar's address. "on_the_way": in no block yet; "confirming": in a block,
 * not yet counted (it counts from 3 confirmations on testnet, story 20); "counted": proven to the
 * jar; "too_small": under the 1,000-sat dust floor, so it never counts (story 18).
 */
export interface TopUp {
  txid: string;
  value: Sats;
  status: "on_the_way" | "confirming" | "counted" | "too_small";
  /** Bitcoin confirmations so far while "confirming"; null otherwise. */
  confirmations: number | null;
  /** When it was counted; null until then. */
  countedAt: UnixSeconds | null;
  explorerUrl: string;
}

/** An allowance payment and how far it has got. Emergency payments are not listed here; they show in `JarStatus.emergency`. */
export interface Allowance {
  amount: Sats;
  /** Paid from the jar, never from the child's amount (story 26). */
  fee: Sats;
  /**
   * "signing": being signed; "signing_failed": will be retried with the same transaction;
   * "signed": sent to Bitcoin, waiting to be proven; "confirmed": proven paid;
   * "cancelled": development contracts only.
   */
  status: "signing" | "signing_failed" | "signed" | "confirmed" | "cancelled";
  requestedAt: UnixSeconds;
  explorerUrl: string;
}

/** Creating and following jars. */
export interface Jars {
  /**
   * Creates the jar from a draft whose guardians have joined; the family account is the giver's
   * own account for now. Safe to retry: a retry finishes the first attempt and never makes a
   * second jar. Refuses every create_jar refusal (INVALID_CHILD_ADDRESS, CAP_TOO_SMALL, ...),
   * DRAFT_NOT_FOUND, LOCKED.
   *
   * @example
   * const { jarId, qrPayload } = await app.jars.create({
   *   draftId: draft.draftId,
   *   childAddress: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl",
   *   cap: 20_000,
   *   period: FULL_PERIOD,
   *   unlockAt: Date.UTC(2040, 4, 1) / 1000,
   * });
   * showQr(qrPayload);
   */
  create(input: CreateJarInput): Promise<{ jarId: string; address: string; qrPayload: string }>;
  /**
   * The jars this device's person gave, holds, guards or (as the child) has claimed.
   *
   * @example
   * for (const jar of await app.jars.mine()) addCard(jar.nickname, jar.picture);
   */
  mine(): Promise<JarSummary[]>;
  /**
   * One jar's status. Refuses UNKNOWN_JAR.
   *
   * @example
   * const jar = await app.jars.status("7");
   * if (jar.demoTiming) showBadge("Demo timing");
   */
  status(jarId: string): Promise<JarStatus>;
  /**
   * Top-ups at the jar's address, newest first.
   *
   * @example
   * const waiting = (await app.jars.topUps("7")).filter((t) => t.status !== "counted");
   */
  topUps(jarId: string): Promise<TopUp[]>;
  /**
   * The jar's allowances, oldest first.
   *
   * @example
   * const last = (await app.jars.allowances("7")).at(-1);
   */
  allowances(jarId: string): Promise<Allowance[]>;
}

// ---------------------------------------------------------------------------------------------
// Part 2: the child's account and handover
// ---------------------------------------------------------------------------------------------

/**
 * The handover as it stands. "claimed": the child's account claimed it, waiting for 2 guardians
 * (lapses if nobody confirms); "confirmed": the public delay runs; "completing": the jar's
 * Bitcoin is moving to the child's key; "done": the jar is the child's.
 */
export type HandoverStatus =
  | { state: "none" }
  | {
      state: "claimed";
      claimedAt: UnixSeconds;
      lapsesAt: UnixSeconds;
      /** Guardians who confirmed so far (0 or 1). */
      confirmations: number;
      confirmedByMe: boolean;
      /** Confirming now would end the delay long before the unlock date and pause allowances until then. */
      pausesAllowancesEarly: boolean;
    }
  | {
      state: "confirmed";
      claimedAt: UnixSeconds;
      delayEndsAt: UnixSeconds;
      confirmedByMe: boolean;
      /** The delay ends before the unlock date: no allowances from then until handover. */
      pausesAllowancesEarly: boolean;
    }
  | { state: "completing"; coinsToMove: number; coinsLeft: number }
  | { state: "done"; completedAt: UnixSeconds };

/** "Set up my jar" on the child's own phone (stories 41-46). */
export interface Child {
  /**
   * Makes the 12-word recovery phrase (kept in memory only) and says which 3 words to type back.
   * Refuses ALREADY_SET_UP.
   *
   * @example
   * const { words, check } = await app.child.startSetUp();
   * showWords(words); // then ask for words at positions `check` (0-based)
   */
  startSetUp(): Promise<{ words: string[]; check: number[] }>;
  /**
   * Checks the typed-back words, locks the phrase under the PIN and creates the child's account
   * with the phone's key as its only key. Exactly the asked positions count; case and spaces do
   * not. Refuses WRONG_RECOVERY_WORDS, NO_RECOVERY_PHRASE (no `startSetUp` in this session).
   *
   * @example
   * await app.child.finishSetUp({
   *   words: [{ index: 2, word: "hollow" }, { index: 6, word: "ribbon" }, { index: 9, word: "maple" }],
   *   pin: "771204",
   * });
   */
  finishSetUp(input: { words: { index: number; word: string }[]; pin: string }): Promise<void>;
  /**
   * Restores the child's keys on a new phone from the recovery phrase (story 43); the same
   * account comes back. Refuses INVALID_RECOVERY_PHRASE,
   * ALREADY_SET_UP.
   *
   * @example
   * await app.child.restore({ words: typedWords, pin: "771204" });
   */
  restore(input: { words: string[]; pin: string }): Promise<void>;
  /**
   * The short code each guardian checks in person (story 46). Refuses NO_RECOVERY_PHRASE, LOCKED.
   *
   * @example
   * showCode(await app.child.guardianCode()); // "4821 0937 5512 8846 1203"
   */
  guardianCode(): Promise<string>;
  /**
   * Claims the jar for this phone's account with the phrase's Bitcoin key. The jar id comes from
   * the family's "Set up my jar" link (the app puts it there); the SDK does not look it up.
   * Refuses CLAIM_OPEN, HANDOVER_COMPLETING, HANDOVER_DONE, NO_RECOVERY_PHRASE, LOCKED.
   *
   * @example
   * await app.child.claim("7");
   */
  claim(jarId: string): Promise<Sent>;
}

declare const checkedClaim: unique symbol;

/** A guardian's check of the open claim: the code to compare, bound to the claim it came from. */
export interface HandoverCheck {
  /** Derived from the claimed account's only key as read on chain, never from the claimer. */
  code: string;
  claimedAt: UnixSeconds;
  readonly [checkedClaim]: true;
}

/** Guardians confirm or cancel the child's claim (stories 47-49). */
export interface Handover {
  /**
   * Reads the open claim (unconfirmed, or confirmed with its delay running) and derives the code
   * to compare, only for an account that is one phone's own: its only key is full access and its
   * name is the one the app gives that key. Refuses NO_OPEN_CLAIM, CLAIM_ACCOUNT_HAS_OTHER_KEYS,
   * UNKNOWN_JAR.
   *
   * @example
   * const check = await app.handover.check("7");
   * showCode(check.code); // compare with the child's phone in person
   */
  check(jarId: string): Promise<HandoverCheck>;
  /**
   * Confirms the claim that was checked, after reading its account's key again. Refuses
   * CLAIM_CHANGED (check again), CLAIM_ACCOUNT_HAS_OTHER_KEYS, NOT_A_GUARDIAN,
   * CLAIM_ALREADY_CONFIRMED, NO_OPEN_CLAIM, HANDOVER_COMPLETING, HANDOVER_DONE.
   *
   * @example
   * await app.handover.confirm("7", check);
   */
  confirm(jarId: string, check: HandoverCheck): Promise<Sent>;
  /**
   * Cancels the open claim (a guardian or the claimer). Refuses NO_OPEN_CLAIM,
   * NOT_GUARDIAN_OR_CLAIMER, HANDOVER_COMPLETING, HANDOVER_DONE.
   *
   * @example
   * await app.handover.cancel("7");
   */
  cancel(jarId: string): Promise<Sent>;
}

// ---------------------------------------------------------------------------------------------
// Part 2: emergency payment
// ---------------------------------------------------------------------------------------------

/** The jar's emergency proposal. Only one is open at a time. */
export type EmergencyStatus =
  | { state: "none" }
  | {
      state: "open";
      proposalId: number;
      amount: Sats;
      /** Guardians who approved so far; the proposer is the first. */
      approvals: number;
      approvedByMe: boolean;
      proposedAt: UnixSeconds;
      /** Set by the 2nd approval, which starts the 30-day public delay; null before. */
      delayEndsAt: UnixSeconds | null;
    }
  | { state: "cancelled"; proposalId: number }
  | { state: "executed"; proposalId: number }
  | { state: "lapsed"; proposalId: number };

/** Guardians propose and approve; the giver may cancel during the delay (stories 33-39). */
export interface Emergency {
  /**
   * Proposes paying the child `amount` (at most 3 x cap). Refuses NOT_A_GUARDIAN,
   * OVER_EMERGENCY_CAP, EMERGENCY_TOO_SMALL, PROPOSAL_OPEN, HANDOVER_IN_PROGRESS.
   *
   * @example
   * const { proposalId } = await app.emergency.propose("7", 40_000);
   */
  propose(jarId: string, amount: Sats): Promise<Sent & { proposalId: number }>;
  /**
   * Approves that exact proposal (its id from `JarStatus.emergency`). Refuses NOT_A_GUARDIAN,
   * ALREADY_APPROVED, PROPOSAL_CHANGED (read it again), EMERGENCY_CANCELLED, NO_OPEN_PROPOSAL,
   * HANDOVER_IN_PROGRESS.
   *
   * @example
   * await app.emergency.approve("7", 1);
   */
  approve(jarId: string, proposalId: number): Promise<Sent>;
  /**
   * The giver cancels the open proposal before its delay ends. Refuses NOT_THE_GIVER,
   * DELAY_PASSED, NO_OPEN_PROPOSAL, EMERGENCY_CANCELLED, HANDOVER_IN_PROGRESS.
   *
   * @example
   * await app.emergency.cancel("7");
   */
  cancel(jarId: string): Promise<Sent>;
}

// ---------------------------------------------------------------------------------------------
// Part 2: the holder after handover
// ---------------------------------------------------------------------------------------------

/**
 * An open transfer of the jar. "offered": started, not yet accepted; "moving":
 * accepted, the Bitcoin re-homes to the receiver's key.
 */
export type TransferStatus =
  | { state: "none" }
  | { state: "offered"; toMe: boolean }
  | { state: "moving"; toMe: boolean; coinsToMove: number; coinsLeft: number };

/** The holder spends or transfers the jar (stories 55-58a). */
export interface Holder {
  /**
   * Sends exactly `amount` of the jar's Bitcoin to a native segwit address; the fee comes from the
   * jar and change goes back to it. The fee rate (sat/vB) defaults to a public explorer's
   * half-hour recommendation. Refuses SPEND_BEFORE_HANDOVER, NOT_THE_HOLDER, TRANSFER_OPEN,
   * INVALID_ADDRESS, AMOUNT_BELOW_DUST, FEE_TOO_LOW, INSUFFICIENT_BALANCE, CHANGE_BELOW_DUST.
   *
   * @example
   * await app.holder.spend("7", { to: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", amount: 50_000 });
   */
  spend(jarId: string, input: { to: string; amount: Sats; feeRate?: number }): Promise<Sent>;
  /**
   * This device's receive code, to give to a holder who transfers a jar to you. It carries the
   * account only, with a Base58Check checksum; the Bitcoin key goes in at `acceptTransfer`.
   * Refuses NO_RECOVERY_PHRASE.
   *
   * @example
   * showCode(await app.holder.receiveCode());
   */
  receiveCode(): Promise<string>;
  /**
   * Starts a transfer to the person behind a receive code. Refuses BAD_RECEIVE_CODE,
   * TRANSFER_BEFORE_HANDOVER, NOT_THE_HOLDER, TRANSFER_OPEN, PAYMENT_PENDING.
   *
   * @example
   * await app.holder.startTransfer("7", typedReceiveCode);
   */
  startTransfer(jarId: string, receiveCode: string): Promise<Sent>;
  /**
   * Cancels a transfer not yet accepted. Refuses NOT_THE_HOLDER, NO_OPEN_TRANSFER,
   * TRANSFER_ACCEPTED.
   *
   * @example
   * await app.holder.cancelTransfer("7");
   */
  cancelTransfer(jarId: string): Promise<Sent>;
  /**
   * The receiver accepts with their own recovery-phrase key; the Bitcoin re-homes to it before
   * the jar moves. The jar id comes from the holder, in the link the app makes for the transfer.
   * The fee rate defaults to the explorer's half-hour recommendation, capped at the highest rate
   * the contract's re-homing fee bound accepts for the first batch. Refuses NO_RECOVERY_PHRASE,
   * NO_OPEN_TRANSFER, NOT_THE_RECEIVER, KEY_CHANGED, PAYMENT_PENDING, FEE_TOO_HIGH,
   * OUTPUT_BELOW_DUST.
   *
   * @example
   * await app.holder.acceptTransfer("7");
   */
  acceptTransfer(jarId: string, input?: { feeRate?: number }): Promise<Sent>;
}

// ---------------------------------------------------------------------------------------------
// Part 2: "try it" refusals
// ---------------------------------------------------------------------------------------------

/** A real refused transaction sent from the caller's own account, with its explorer link. */
export interface TriedRefusal {
  code: RefusalCode;
  message: string;
  explorerUrl: string;
}

/**
 * Lets a visitor see the rule say no on chain (stories 40a, 52, 36). Each call's arguments can
 * move nothing from any device: a spend at fee rate 0, an approval of proposal 0 (ids start at 1).
 * Refuses (throws) only TRANSACTION_FAILED, UNAVAILABLE, NO_DEVICE, LOCKED.
 */
export interface TryIt {
  /**
   * A family member's or guardian's spend before handover. Expect SPEND_BEFORE_HANDOVER.
   *
   * @example
   * const tried = await app.tryIt.earlySpend("7");
   * showRefusal(tried.message, tried.explorerUrl);
   */
  earlySpend(jarId: string): Promise<TriedRefusal>;
  /**
   * The family account's spend after handover. Expect NOT_THE_HOLDER.
   *
   * @example
   * const tried = await app.tryIt.afterHandover("7");
   */
  afterHandover(jarId: string): Promise<TriedRefusal>;
  /**
   * An outsider approving the jar's emergency payment. Expect NOT_A_GUARDIAN.
   *
   * @example
   * const tried = await app.tryIt.outsiderApproval("7");
   */
  outsiderApproval(jarId: string): Promise<TriedRefusal>;
}
