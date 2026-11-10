import { SatsJarRefusal, type CreateJarInput } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import type { deviceKeys } from "./device.ts";
import { ownDraft, type DraftRecord, type DraftStore, type PendingCreate } from "./invites.ts";
import { Rejected, result, type Near, type Outcome } from "./near.ts";
import { refusal } from "./refusals.ts";

// T15 measured create_jar: 30 Tgas covers it; 0.02 NEAR covers the jar's storage and the
// contract refunds the rest (findings-t15). Low prepaid gas keeps the funded balance working.
const CREATE_GAS = 30_000_000_000_000n;
const STORAGE_DEPOSIT = 20_000_000_000_000_000_000_000n;
const PAGE = 50; // NEP-181 enumeration pages (findings-t09)

interface JarView {
  address: string;
  create_args: Record<string, unknown>;
}

/**
 * Creates a jar from a draft, never minting twice. The signed create_jar is stored against the
 * draft before it is sent and the jar id the moment the outcome arrives; a retry resends those
 * same bytes (one nonce, so at most one can land) and only signs afresh once they can no longer
 * land and no jar of the giver's carries the same create args.
 */
export function creator(deps: {
  near: Near;
  backend: BackendClient;
  drafts: DraftStore;
  keys: ReturnType<typeof deviceKeys>;
  contract: string;
}) {
  const { near, backend, drafts, keys, contract } = deps;

  /** The jar id the outcome made, or the refusal; either way the pending create is settled. */
  async function settle(draft: DraftRecord, outcome: Outcome): Promise<string> {
    const answer = result(outcome, contract);
    if ("refusal" in answer) {
      await drafts.update(draft.draftId, { pendingCreate: null });
      throw answer.refusal;
    }
    const jarId = String(answer.value);
    await drafts.update(draft.draftId, { pendingCreate: null, jarId });
    return jarId;
  }

  /** Settles an earlier attempt: its jar id, or null when it made no jar and never will. */
  async function resume(draft: DraftRecord, pending: PendingCreate): Promise<string | null> {
    let outcome = await near.outcome(pending);
    if (!outcome) {
      try {
        outcome = await near.send(pending);
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        // Rejected: expired, or it landed meanwhile (the nonce is used); look once more.
        outcome = await near.outcome(pending);
      }
    }
    if (outcome) {
      try {
        return await settle(draft, outcome);
      } catch {
        return null; // the earlier attempt was refused: no jar, so this one starts afresh
      }
    }
    const jarId = await jarWithArgs(pending.signerId, pending.args);
    await drafts.update(draft.draftId, { pendingCreate: null, jarId });
    return jarId;
  }

  /** A jar the giver holds whose create args are exactly `args`, if any. */
  async function jarWithArgs(giver: string, args: Record<string, unknown>): Promise<string | null> {
    for (let from = 0; ; from += PAGE) {
      const tokens = await near.view<{ token_id: string }[]>("nft_tokens_for_owner", {
        account_id: giver,
        from_index: String(from),
        limit: PAGE,
      });
      for (const { token_id } of tokens) {
        const jar = await near.view<JarView | null>("get_jar", { jar_id: token_id });
        if (jar && canonical(jar.create_args) === canonical(args)) return token_id;
      }
      if (tokens.length < PAGE) return null;
    }
  }

  async function accountId(publicKey: string): Promise<string> {
    const known = await keys.accountId();
    if (known) return known;
    const made = await backend.createAccount(publicKey);
    await keys.rememberAccount(made);
    return made;
  }

  async function finish(draftId: string, jarId: string) {
    try {
      await backend.closeDraft(draftId, jarId);
    } catch (error) {
      // Closed by an earlier attempt whose answer was lost.
      if (!(error instanceof SatsJarRefusal && error.code === "DRAFT_NOT_FOUND")) throw error;
    }
    const jar = await near.view<JarView | null>("get_jar", { jar_id: jarId });
    if (!jar) throw refusal("UNAVAILABLE");
    return { jarId, address: jar.address, qrPayload: `bitcoin:${jar.address}` };
  }

  return async function create(input: CreateJarInput) {
    const { near: key } = await keys.keys();
    const draft = await ownDraft(drafts, input.draftId);
    if (draft.jarId) return finish(draft.draftId, draft.jarId);
    if (draft.pendingCreate) {
      const jarId = await resume(draft, draft.pendingCreate);
      if (jarId) return finish(draft.draftId, jarId);
    }

    const pendingDraft = await backend.draft(draft.draftId);
    const giver = await accountId(key.publicKey);
    // Family account = the giver's own for now (plan decision); the contract keeps both.
    const args = {
      child_address: input.childAddress,
      cap: String(input.cap),
      period: String(input.period),
      unlock_at: String(input.unlockAt),
      guardians: pendingDraft.invites.flatMap((i) => (i.accountId ? [i.accountId] : [])),
      family_account: giver,
      nickname: pendingDraft.nickname,
    };
    const signed = await near.sign(
      { accountId: giver, secretKey: key.secretKey },
      { method: "create_jar", args, gas: CREATE_GAS, deposit: STORAGE_DEPOSIT },
    );
    await drafts.update(draft.draftId, { pendingCreate: { args, ...signed } });
    let outcome: Outcome;
    try {
      outcome = await near.send(signed);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      // Refused before it ran, so these bytes can never land.
      await drafts.update(draft.draftId, { pendingCreate: null });
      throw refusal("TRANSACTION_FAILED");
    }
    return finish(draft.draftId, await settle(draft, outcome));
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
