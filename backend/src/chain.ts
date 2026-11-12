import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  PublicKey,
  actions,
  type KeyPairString,
  type SerializedReturnValue,
} from "near-api-js";
import { AccountAlreadyExistsActionError, AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { LIGHT_CLIENT, NEAR_RPC } from "./rpc.ts";

/** What the backend needs from NEAR. The live adapter is `nearChain`; tests use a fake. */
export interface Chain {
  /**
   * Creates `accountId` with `publicKey` as its only full-access key and a little NEAR from
   * the sponsor. An account that already exists is left alone ("exists").
   */
  createAccount(accountId: string, publicKey: string): Promise<"created" | "exists">;
  /** The guardians of jar `jarId` on the configured contract, or undefined if there is no such jar. */
  jarGuardians(jarId: string): Promise<string[] | undefined>;
}

/** `get_jar`'s answer, the fields the keeper reads (U64 as strings, counts as numbers). */
export type JarView = {
  jar_id: string;
  address: string;
  /** The addresses the jar moved away from; a top-up sent to one is a stray. */
  old_addresses: string[];
  create_args: { cap: string; period: string; unlock_at: string };
  clock: { started_at: string | null };
  handover:
    | "none"
    | { claimed: object }
    | { confirmed: { delay_ends_at: string } }
    | { completing: { delay_ends_at: string; coins_to_move: number; coins_left: number } }
    | { done: object };
  transfer:
    | "none"
    | { started: object }
    | { accepted: { btc_pubkey: string; coins_to_move: number; coins_left: number } };
  emergency:
    | "none"
    | { open: { proposal_id: number; amount: string; delay_ends_at: string | null } }
    | { cancelled: object }
    | { executed: object }
    | { lapsed: object };
  proven_balance: string;
  available_allowance: string;
  fee_budget_left: string;
  next_allowance_at: string | null;
};

/** One of `get_coins`' answers. */
export type CoinView = { txid: string; vout: number; value: string; status: string; payment_id: string | null };

/** `get_payment`'s answer. */
export type PaymentView = {
  payment_id: string;
  jar_id: string;
  kind: string;
  status: "signing" | "signing_failed" | "signed" | "confirmed" | "cancelled";
  txid: string;
  inputs: { txid: string; vout: number; value: string }[];
  signed_tx: string | null;
};

/** The contract methods the keeper calls; each is one anyone may call. */
export type KeeperMethod =
  | "prove_topup"
  | "request_allowance"
  | "retry_signing"
  | "confirm_payment"
  | "complete_handover"
  | "rehome_stray"
  | "execute_emergency"
  | "accept_transfer";

/** A call's final outcome. A refusal carries the contract's code (null if it gave none). */
export type CallOutcome =
  | { ok: true; hash: string; value: unknown }
  | { ok: false; hash: string; code: string | null; message: string };

/** What the keeper needs from NEAR: public views, and calls signed by the keeper account. */
export interface KeeperChain {
  jarCount(): Promise<number>;
  jar(jarId: string): Promise<JarView | undefined>;
  /** Every coin of the jar, whatever its status. */
  coins(jarId: string): Promise<CoinView[]>;
  payment(paymentId: string): Promise<PaymentView | undefined>;
  /** The light client's last Bitcoin block height. */
  lightClientTip(): Promise<number>;
  /** The last final NEAR block height. */
  blockHeight(): Promise<number>;
  /** Sends one call and waits for its final outcome, callbacks included. */
  call(method: KeeperMethod, args: Record<string, unknown>, tgas: number): Promise<CallOutcome>;
}

/**
 * Each person's funding (0.25 NEAR). Every account is funded; no relaying (ADR 0009). A call
 * needs its prepaid gas up front at 0.001 NEAR per Tgas (measured on testnet, 10x the burn
 * price; the unused part comes back), so this covers one call of up to about 240 Tgas, enough
 * for a holder's spend of 10 inputs (10 x 15 + 50 Tgas). Burnt fees are small: the giver's
 * `create_jar` keeps 0.0089 NEAR for storage and burns about 0.0007 NEAR (T06).
 */
const FUNDING = 250_000_000_000_000_000_000_000n;

export function nearChain(settings: {
  sponsorAccountId: string;
  sponsorPrivateKey: string;
  contractAccountId: string;
}): Chain {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const sponsor = new Account(
    settings.sponsorAccountId,
    provider,
    KeyPairSigner.fromSecretKey(settings.sponsorPrivateKey as KeyPairString),
  );

  async function exists(accountId: string): Promise<boolean> {
    try {
      await provider.viewAccount({ accountId });
      return true;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return false;
      throw error;
    }
  }

  return {
    async createAccount(accountId, publicKey) {
      if (await exists(accountId)) return "exists";
      try {
        // Exactly one AddKey, the device's: the sponsor never keeps a key on the account.
        await sponsor.signAndSendTransaction({
          receiverId: accountId,
          actions: [
            actions.createAccount(),
            actions.transfer(FUNDING),
            actions.addFullAccessKey(PublicKey.fromString(publicKey)),
          ],
        });
        return "created";
      } catch (error) {
        // Another request for the same key won the race.
        if (error instanceof AccountAlreadyExistsActionError) return "exists";
        throw error;
      }
    },

    async jarGuardians(jarId) {
      // `get_jar` answers null for an unknown jar; optional chaining covers it.
      const jar = await provider.callFunction<{ create_args: { guardians: string[] } }>({
        contractId: settings.contractAccountId,
        method: "get_jar",
        args: { jar_id: jarId },
      });
      return jar?.create_args.guardians ?? undefined;
    },
  };
}

/** The part of a final transaction outcome (`tx` RPC, `signAndSendTransaction`) the keeper reads. */
type FinalOutcome = { transaction: { hash: string }; status: unknown };

/** A call's outcome from its final transaction status; the contract refuses as `CODE: sentence`. */
export function outcomeOf(response: FinalOutcome): CallOutcome {
  const hash = response.transaction.hash;
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue !== undefined) {
    const text = Buffer.from(status.SuccessValue, "base64").toString();
    return { ok: true, hash, value: text === "" ? null : (JSON.parse(text) as unknown) };
  }
  const error = (status.Failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: string } } } })
    ?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  const text = error ?? JSON.stringify(status.Failure ?? status);
  const refusal = /^Smart contract panicked: ([A-Z][A-Z0-9_]*): (.*)$/s.exec(text);
  return refusal
    ? { ok: false, hash, code: refusal[1] ?? null, message: refusal[2] ?? "" }
    : { ok: false, hash, code: null, message: text };
}

/**
 * The keeper's NEAR adapter. Calls are signed with the keeper's key, a function-call key on
 * the contract only: it cannot attach a deposit, so it can make no holder or guardian call.
 */
export function nearKeeperChain(settings: {
  keeperAccountId: string;
  keeperPrivateKey: string;
  contractAccountId: string;
}): KeeperChain {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const keeper = new Account(
    settings.keeperAccountId,
    provider,
    KeyPairSigner.fromSecretKey(settings.keeperPrivateKey as KeyPairString),
  );
  const view = <T>(method: string, args: Record<string, unknown>, contractId = settings.contractAccountId) =>
    provider.callFunction<T & SerializedReturnValue>({ contractId, method, args }) as Promise<T | undefined>;

  return {
    async jarCount() {
      return Number(await view<string>("nft_total_supply", {}));
    },
    async jar(jarId) {
      return (await view<JarView | null>("get_jar", { jar_id: jarId })) ?? undefined;
    },
    async coins(jarId) {
      const coins: CoinView[] = [];
      for (;;) {
        const page = (await view<CoinView[]>("get_coins", { jar_id: jarId, from_index: coins.length, limit: PAGE })) ?? [];
        coins.push(...page);
        if (page.length < PAGE) return coins;
      }
    },
    async payment(paymentId) {
      return (await view<PaymentView | null>("get_payment", { payment_id: paymentId })) ?? undefined;
    },
    async lightClientTip() {
      return Number(await view<number>("get_last_block_height", {}, LIGHT_CLIENT));
    },
    async blockHeight() {
      return (await provider.viewBlock({ finality: "final" })).header.height;
    },
    async call(method, args, tgas) {
      // FINAL waits for every receipt, so a signing's callback has run before the next step.
      const response = await keeper.signAndSendTransaction({
        receiverId: settings.contractAccountId,
        actions: [actions.functionCall(method, args, BigInt(tgas) * 10n ** 12n, 0n)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      });
      return outcomeOf(response);
    },
  };
}

/** `get_coins` answers at most 100 a page. */
const PAGE = 100;
