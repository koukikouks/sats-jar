import {
  InvalidRecoveryPhraseError,
  WrongPinError,
  createDeviceKey,
  keysFromRecoveryPhrase,
  lock,
  unlock,
  type DeviceKeys,
  type LockedKeys,
} from "@sats-jar/device-keys";
import type { Device, DeviceState, DeviceStorage } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import { refusal, unavailable } from "./refusals.ts";

const DEVICE = "sats-jar:device";

/** What the device keeps about itself. The keys stay PIN-locked; the account id is not secret. */
interface DeviceRecord {
  locked: LockedKeys;
  publicKey: string;
  /** Set once the backend made (or found) the account for this key. */
  accountId: string | null;
  /** The child's phone: the locked secret is a recovery phrase, which also holds a Bitcoin key. */
  phrase?: true;
}

/** The device's keys and account: one per app instance, unlocked only in memory. */
export function deviceKeys(storage: DeviceStorage) {
  let unlocked: DeviceKeys | null = null;

  async function load(): Promise<DeviceRecord | null> {
    const text = await storage.get(DEVICE);
    return text === null ? null : (JSON.parse(text) as DeviceRecord);
  }

  const device: Device = {
    async state(): Promise<DeviceState> {
      if (unlocked) return "unlocked";
      return (await load()) ? "locked" : "new";
    },

    async setUp({ pin }) {
      if (await load()) throw refusal("ALREADY_SET_UP");
      const near = createDeviceKey();
      const record: DeviceRecord = {
        locked: await lock({ kind: "device-key", near }, { kind: "pin", pin }),
        publicKey: near.publicKey,
        accountId: null,
      };
      await storage.set(DEVICE, JSON.stringify(record));
      unlocked = { near };
    },

    async unlock({ pin }) {
      const record = await load();
      if (!record) throw refusal("NO_DEVICE");
      try {
        unlocked = await unlock(record.locked, { kind: "pin", pin });
      } catch (error) {
        if (error instanceof WrongPinError) throw refusal("WRONG_PIN");
        throw unavailable(); // damaged stored keys: never the raw error
      }
    },

    lock() {
      unlocked = null;
    },
  };

  return {
    device,

    /** The unlocked keys, or the refusal that says why not. */
    async keys(): Promise<DeviceKeys> {
      if (unlocked) return unlocked;
      throw refusal((await load()) ? "LOCKED" : "NO_DEVICE");
    },

    /**
     * Keeps a recovery phrase as this device's keys, locked under the PIN (the child's phone).
     * Refuses INVALID_RECOVERY_PHRASE, ALREADY_SET_UP.
     */
    async adoptPhrase(phrase: string, pin: string): Promise<void> {
      if (await load()) throw refusal("ALREADY_SET_UP");
      let keys: DeviceKeys;
      try {
        keys = keysFromRecoveryPhrase(phrase);
      } catch (error) {
        if (error instanceof InvalidRecoveryPhraseError) throw refusal("INVALID_RECOVERY_PHRASE");
        throw error;
      }
      const record: DeviceRecord = {
        locked: await lock({ kind: "recovery-phrase", phrase }, { kind: "pin", pin }),
        publicKey: keys.near.publicKey,
        accountId: null,
        phrase: true,
      };
      await storage.set(DEVICE, JSON.stringify(record));
      unlocked = keys;
    },

    /** This device's account, made by the backend for its key the first time it is needed. */
    async ensureAccount(backend: BackendClient): Promise<string> {
      const record = await load();
      if (!record) throw refusal("NO_DEVICE");
      if (record.accountId) return record.accountId;
      const made = await backend.createAccount(record.publicKey);
      await storage.set(DEVICE, JSON.stringify({ ...record, accountId: made }));
      return made;
    },

    /** This device's account id, if the backend has made it. */
    async accountId(): Promise<string | null> {
      return (await load())?.accountId ?? null;
    },

    async rememberAccount(accountId: string): Promise<void> {
      const record = await load();
      if (!record) throw refusal("NO_DEVICE");
      await storage.set(DEVICE, JSON.stringify({ ...record, accountId }));
    },
  };
}
