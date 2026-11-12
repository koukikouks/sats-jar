import { guardianCode } from "@sats-jar/device-keys";
import { baseDecode } from "near-api-js";
import type { Handover, HandoverCheck } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import type { deviceKeys } from "./device.ts";
import type { Near } from "./near.ts";
import { refusal } from "./refusals.ts";
import { CALL_GAS, ONE_YOCTO, type Write } from "./writes.ts";

/** What a check was made from; kept here, never in the object the screen holds. */
interface Checked {
  jarId: string;
  childAccount: string;
  publicKey: string;
}

/**
 * Guardians check the child's code in person, then confirm or cancel the claim (stories 46-49).
 * The code comes from the claimed account's key as read on chain, and only from an account that
 * is one phone's own: its only key is full access, and its name is the one the app's backend
 * gives that key (T15). Otherwise an adult could claim from their own account and swap in the
 * child's public key later, and the code would match.
 */
export function handover(deps: { near: Near; keys: ReturnType<typeof deviceKeys>; backend: BackendClient; write: Write }): Handover {
  const { near, keys, backend, write } = deps;
  const checks = new WeakMap<object, Checked>();

  /** The account's one key, if the account is one phone's own; else the refusal. */
  async function phoneKey(account: string): Promise<string> {
    // The app account is the parent of every account the backend makes, this guardian's included.
    const mine = await keys.ensureAccount(backend);
    const app = mine.slice(mine.indexOf(".") + 1);
    const found = await near.accessKeys(account);
    const [only] = found;
    if (found.length !== 1 || !only || only.access_key.permission !== "FullAccess") throw refusal("CLAIM_ACCOUNT_HAS_OTHER_KEYS");
    if ((await accountIdFor(only.public_key, app)) !== account) throw refusal("CLAIM_ACCOUNT_HAS_OTHER_KEYS");
    return only.public_key;
  }

  return {
    async check(jarId) {
      const jar = await near.view<{ handover: unknown } | null>("get_jar", { jar_id: jarId });
      if (!jar) throw refusal("UNKNOWN_JAR");
      const claim = openClaim(jar.handover);
      if (!claim) throw refusal("NO_OPEN_CLAIM");
      const publicKey = await phoneKey(claim.child_account);
      const check = { code: guardianCode(publicKey), claimedAt: Number(claim.claimed_at) } as HandoverCheck;
      checks.set(check, { jarId, childAccount: claim.child_account, publicKey });
      return check;
    },

    async confirm(jarId, check) {
      const checked = checks.get(check);
      if (!checked || checked.jarId !== jarId) throw refusal("CLAIM_CHANGED");
      if ((await phoneKey(checked.childAccount)) !== checked.publicKey) throw refusal("CLAIM_ACCOUNT_HAS_OTHER_KEYS");
      const { explorerUrl } = await write({
        method: "confirm_handover",
        args: { jar_id: jarId, child_account: checked.childAccount },
        gas: CALL_GAS,
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },

    async cancel(jarId) {
      const { explorerUrl } = await write({ method: "cancel_handover", args: { jar_id: jarId }, gas: CALL_GAS, deposit: ONE_YOCTO });
      return { explorerUrl };
    },
  };
}

/** The open claim in a claimed or confirmed handover (a guardian may still cancel during the delay). */
function openClaim(view: unknown): { child_account: string; claimed_at: string } | null {
  if (typeof view !== "object" || view === null) return null;
  const claim = (view as Record<string, { child_account?: unknown; claimed_at?: unknown } | undefined>).claimed ??
    (view as Record<string, { child_account?: unknown; claimed_at?: unknown } | undefined>).confirmed;
  if (typeof claim?.child_account !== "string" || typeof claim.claimed_at !== "string") return null;
  return { child_account: claim.child_account, claimed_at: claim.claimed_at };
}

/** T15's account rule: the first 20 hex characters of SHA-256 over the key's 32 bytes, under the app account. */
export async function accountIdFor(publicKey: string, app: string): Promise<string | null> {
  if (!publicKey.startsWith("ed25519:")) return null;
  const raw = baseDecode(publicKey.slice("ed25519:".length));
  if (raw.length !== 32) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(raw)));
  const hex = Array.from(digest.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}.${app}`;
}
