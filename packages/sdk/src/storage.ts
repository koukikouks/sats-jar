import type { DeviceStorage } from "./api.ts";

/** The browser's `localStorage`: the device's records never leave this browser. */
export function browserStorage(): DeviceStorage {
  return {
    get: async (key) => localStorage.getItem(key),
    set: async (key, value) => localStorage.setItem(key, value),
    delete: async (key) => localStorage.removeItem(key),
  };
}
