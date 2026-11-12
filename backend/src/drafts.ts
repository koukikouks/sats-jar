import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { Refusal } from "./refusal.ts";
import type { Json, Store } from "./store.ts";

/** A jar being set up: its nickname and one slot per invite link, until the jar exists. */
type Draft = { nickname: string; invites: { token: string; accountId: string | null }[] };

export type DraftView = {
  nickname: string;
  invites: { joined: boolean; accountId: string | null }[];
};

/**
 * Pending guardian invites. The draft id is the giver's capability and each invite token one
 * invitee's; the store keeps only their SHA-256, so a leaked store cannot join an invite.
 */
export function drafts(store: Store) {
  const draftKey = (draftId: string) => `draft:${digest(draftId)}`;

  async function load(key: string) {
    const entry = await store.get(key);
    return entry && { draft: entry.value as Draft, version: entry.version };
  }

  /** The draft an invite token belongs to, and that invite's slot. */
  async function invite(inviteToken: string) {
    const index = await store.get(`invite:${digest(inviteToken)}`);
    const key = (index?.value as { draft: string } | undefined)?.draft;
    const found = key === undefined ? undefined : await load(key);
    const slot = found?.draft.invites.findIndex((i) => i.token === digest(inviteToken)) ?? -1;
    if (!found || key === undefined || slot < 0) {
      throw new Refusal(404, "INVITE_NOT_FOUND", "this invite link is not for a pending jar");
    }
    return { key, slot, ...found };
  }

  return {
    async create(nickname: string, invites: number) {
      if (!Number.isInteger(invites) || invites < 2 || invites > 3) {
        throw new Refusal(400, "BAD_INVITE_COUNT", "a jar has 2 or 3 guardians, one invite link each");
      }
      const draftId = token();
      const inviteTokens = Array.from({ length: invites }, token);
      const draft: Draft = {
        nickname,
        invites: inviteTokens.map((t) => ({ token: digest(t), accountId: null })),
      };
      await store.put(draftKey(draftId), draft as Json, undefined);
      for (const t of inviteTokens) {
        await store.put(`invite:${digest(t)}`, { draft: draftKey(draftId) }, undefined);
      }
      return { draftId, inviteTokens };
    },

    async view(draftId: string): Promise<DraftView> {
      const found = await load(draftKey(draftId));
      if (!found) throw new Refusal(404, "DRAFT_NOT_FOUND", "no pending jar has this link");
      return {
        nickname: found.draft.nickname,
        invites: found.draft.invites.map((i) => ({ joined: i.accountId !== null, accountId: i.accountId })),
      };
    },

    /**
     * Fills an invite's slot with the invitee's account. The checks run again inside the
     * conditional write, so two joins at once can neither share a slot nor put one account
     * on two slots (the contract would refuse that jar's guardians as duplicates).
     */
    async join(inviteToken: string, accountId: string, ensureAccount: () => Promise<unknown>) {
      check(await invite(inviteToken), accountId);
      await ensureAccount();
      for (;;) {
        const found = await invite(inviteToken);
        check(found, accountId);
        const draft: Draft = {
          ...found.draft,
          invites: found.draft.invites.map((i, n) => (n === found.slot ? { ...i, accountId } : i)),
        };
        if (await store.put(found.key, draft as Json, found.version)) return;
      }
    },

    /**
     * Forgets a draft once its jar exists: every guardian of the jar must have joined through
     * this draft. A link left unjoined (or joined too late) does not keep the draft.
     */
    async close(draftId: string, jarGuardians: string[] | undefined) {
      const key = draftKey(draftId);
      const found = await load(key);
      if (!found) throw new Refusal(404, "DRAFT_NOT_FOUND", "no pending jar has this link");
      if (jarGuardians === undefined) {
        throw new Refusal(404, "JAR_NOT_FOUND", "no jar has this id");
      }
      const joined = new Set(found.draft.invites.map((i) => i.accountId));
      if (!jarGuardians.every((g) => joined.has(g))) {
        throw new Refusal(409, "GUARDIANS_DIFFER", "that jar's guardians did not join through these links");
      }
      await store.delete(key);
      for (const i of found.draft.invites) await store.delete(`invite:${i.token}`);
    },

    async viewInvite(inviteToken: string) {
      const { draft, slot } = await invite(inviteToken);
      return { nickname: draft.nickname, joined: draft.invites[slot]?.accountId != null };
    },
  };
}

function check(found: { draft: Draft; slot: number }, accountId: string): void {
  if (found.draft.invites[found.slot]?.accountId != null) {
    throw new Refusal(409, "INVITE_USED", "someone has already joined with this invite link");
  }
  if (found.draft.invites.some((i) => i.accountId === accountId)) {
    throw new Refusal(409, "ALREADY_GUARDIAN", "this person is already a guardian of this jar");
  }
}

/** 128 random bits, URL-safe. */
function token(): string {
  return base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(16)));
}

function digest(secret: string): string {
  return bytesToHex(sha256(utf8ToBytes(secret)));
}
