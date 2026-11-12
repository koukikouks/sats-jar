import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Entry, Json, Store } from "./store.ts";

/**
 * The store as one JSON file, for a host with a persistent disk. Operations run one at a
 * time in this process, and each write lands whole (temp file, then rename).
 */
export function fileStore(path: string): Store {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => T): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = (): Record<string, Entry> =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>) : {};
  const write = (entries: Record<string, Entry>): void => {
    writeFileSync(`${path}.tmp`, JSON.stringify(entries));
    renameSync(`${path}.tmp`, path);
  };

  return {
    get: (key) => serial(() => read()[key]),
    put: (key, value: Json, expected) =>
      serial(() => {
        const entries = read();
        if (entries[key]?.version !== expected) return false;
        entries[key] = { value, version: (expected ?? 0) + 1 };
        write(entries);
        return true;
      }),
    delete: (key) =>
      serial(() => {
        const entries = read();
        delete entries[key];
        write(entries);
      }),
  };
}
