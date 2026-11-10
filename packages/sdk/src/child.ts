import { createRecoveryPhrase, guardianCode } from "@sats-jar/device-keys";
import type { Child } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import type { deviceKeys } from "./device.ts";
import { refusal } from "./refusals.ts";
import { CALL_GAS, ONE_YOCTO, type Write } from "./writes.ts";

/** "Set up my jar" on the child's own phone: the recovery phrase, its account, the claim. */
export function child(deps: { keys: ReturnType<typeof deviceKeys>; backend: BackendClient; write: Write }): Child {
  const { keys, backend, write } = deps;
  // The phrase being set up lives only here, in memory, until it is checked and locked.
  let pending: { words: string[]; check: number[] } | null = null;

  /** The phone's unlocked phrase keys; an adult's device has none. */
  async function phraseKeys() {
    const unlocked = await keys.keys();
    if (!unlocked.bitcoin) throw refusal("NO_RECOVERY_PHRASE");
    return { near: unlocked.near, bitcoin: unlocked.bitcoin };
  }

  return {
    async startSetUp() {
      if ((await keys.device.state()) !== "new") throw refusal("ALREADY_SET_UP");
      const words = createRecoveryPhrase().split(" ");
      pending = { words, check: checkPositions(words.length) };
      return { words: [...words], check: [...pending.check] };
    },

    async finishSetUp({ words: typed, pin }) {
      if (!pending) throw refusal("NO_RECOVERY_PHRASE");
      const { words, check } = pending;
      const asked = [...check].sort((a, b) => a - b).join();
      const given = typed.map((t) => t.index).sort((a, b) => a - b).join();
      const right = typed.every((t) => t.word.trim().toLowerCase() === words[t.index]);
      if (asked !== given || !right) throw refusal("WRONG_RECOVERY_WORDS");
      await keys.adoptPhrase(words.join(" "), pin);
      pending = null;
      await keys.ensureAccount(backend);
    },

    async restore({ words, pin }) {
      await keys.adoptPhrase(words.join(" "), pin);
      await keys.ensureAccount(backend);
    },

    async guardianCode() {
      return guardianCode((await phraseKeys()).near.publicKey);
    },

    async claim(jarId) {
      const { bitcoin } = await phraseKeys();
      const childAccount = await keys.ensureAccount(backend);
      const { explorerUrl } = await write({
        method: "claim_handover",
        args: { jar_id: jarId, child_account: childAccount, child_btc_pubkey: hex(bitcoin.publicKey) },
        gas: CALL_GAS,
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },
  };
}

const CHECKED_WORDS = 3;

/** Distinct random positions (0-based) of the words the child types back. */
function checkPositions(count: number): number[] {
  const positions = new Set<number>();
  while (positions.size < CHECKED_WORDS) {
    positions.add(crypto.getRandomValues(new Uint32Array(1))[0]! % count);
  }
  return [...positions].sort((a, b) => a - b);
}

/** Lowercase hex, as the contract takes Bitcoin keys. */
export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
