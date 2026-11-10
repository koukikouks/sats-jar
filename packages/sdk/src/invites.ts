import type { Draft, DeviceStorage, Invites } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import type { deviceKeys } from "./device.ts";
import { refusal } from "./refusals.ts";

const DRAFTS = "sats-jar:drafts";

/** A create_jar signed but not yet known to have landed; kept so a retry never mints twice. */
export interface PendingCreate {
  args: Record<string, unknown>;
  /** The signed transaction, base64, and its hash: a retry resends these same bytes. */
  signedTx: string;
  hash: string;
  signerId: string;
}

export interface DraftRecord extends Draft {
  pendingCreate: PendingCreate | null;
}

/** The giver's drafts, newest first. Invite links cannot be fetched again, so they live here. */
export function draftStore(storage: DeviceStorage) {
  async function all(): Promise<DraftRecord[]> {
    const text = await storage.get(DRAFTS);
    return text === null ? [] : (JSON.parse(text) as DraftRecord[]);
  }
  return {
    all,
    async get(draftId: string): Promise<DraftRecord | undefined> {
      return (await all()).find((d) => d.draftId === draftId);
    },
    async put(draft: DraftRecord): Promise<void> {
      const rest = (await all()).filter((d) => d.draftId !== draft.draftId);
      await storage.set(DRAFTS, JSON.stringify([draft, ...rest]));
    },
    /** Updates a draft in place, keeping its position. */
    async update(draftId: string, change: Partial<DraftRecord>): Promise<void> {
      const drafts = (await all()).map((d) => (d.draftId === draftId ? { ...d, ...change } : d));
      await storage.set(DRAFTS, JSON.stringify(drafts));
    },
  };
}

export type DraftStore = ReturnType<typeof draftStore>;

export function invites(backend: BackendClient, drafts: DraftStore, keys: ReturnType<typeof deviceKeys>): Invites {
  return {
    async start({ nickname, guardians }) {
      const { draftId, inviteTokens } = await backend.createDraft(nickname, guardians);
      const draft: DraftRecord = { draftId, nickname, inviteTokens, jarId: null, pendingCreate: null };
      await drafts.put(draft);
      return publicDraft(draft);
    },

    async mine() {
      return (await drafts.all()).map(publicDraft);
    },

    async progress(draftId) {
      const draft = await backend.draft(draftId);
      return { nickname: draft.nickname, joined: draft.invites.map((i) => i.joined) };
    },

    preview: (token) => backend.invite(token),

    async join(token) {
      const { near } = await keys.keys();
      await keys.rememberAccount(await backend.join(token, near.publicKey));
    },
  };
}

function publicDraft({ draftId, nickname, inviteTokens, jarId }: DraftRecord): Draft {
  return { draftId, nickname, inviteTokens, jarId };
}

/** Guard for drafts this device did not start. */
export async function ownDraft(drafts: DraftStore, draftId: string): Promise<DraftRecord> {
  const draft = await drafts.get(draftId);
  if (!draft) throw refusal("DRAFT_NOT_FOUND");
  return draft;
}
