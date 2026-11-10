import {
  WrongPinError,
  createDeviceKey,
  lock,
  unlock,
  type DeviceKeys,
  type LockedKeys,
} from "@sats-jar/device-keys";
import type { Device, DeviceState, DeviceStorage } from "./api.ts";
import { refusal } from "./refusals.ts";

const DEVICE = "sats-jar:device";

/** What the device keeps about itself. The keys stay PIN-locked; the account id is not secret. */
interface DeviceRecord {
  locked: LockedKeys;
  publicKey: string;
  /** Set once the backend made (or found) the account for this key. */
  accountId: string | null;
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
        throw error;
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
