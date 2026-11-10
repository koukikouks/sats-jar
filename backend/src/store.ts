export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Entry = { value: Json; version: number };

/**
 * Where pending drafts live. Every write is conditional on the version the writer read, so
 * the backend stays correct on a host with many instances; an adapter over any key-value
 * store with compare-and-set can replace the file one.
 */
export interface Store {
  get(key: string): Promise<Entry | undefined>;
  /** Writes only if the key is still at `expected` (`undefined`: absent); false if it moved. */
  put(key: string, value: Json, expected: number | undefined): Promise<boolean>;
  /** Draft keys are random and never reused, so a version restarting after a delete is safe. */
  delete(key: string): Promise<void>;
}
