import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStore } from "./file-store.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "sats-jar-store-")), "drafts.json");

describe("file store", () => {
  it("keeps what was written across a restart", async () => {
    const path = tempFile();
    expect(await fileStore(path).put("draft:a", { nickname: "Mia" }, undefined)).toBe(true);

    expect(await fileStore(path).get("draft:a")).toEqual({ value: { nickname: "Mia" }, version: 1 });
  });

  it("writes only over the version the writer read", async () => {
    const store = fileStore(tempFile());
    await store.put("k", "first", undefined);

    expect(await store.put("k", "again from nothing", undefined)).toBe(false);
    expect(await store.put("k", "second", 1)).toBe(true);
    expect(await store.put("k", "stale", 1)).toBe(false);
    expect(await store.get("k")).toEqual({ value: "second", version: 2 });
  });

  it("a deleted key refuses a write over its old version", async () => {
    const store = fileStore(tempFile());
    await store.put("k", "v", undefined);
    await store.delete("k");

    expect(await store.get("k")).toBeUndefined();
    expect(await store.put("k", "late", 1)).toBe(false);
  });

  it("concurrent writers over the same version: exactly one wins", async () => {
    const store = fileStore(tempFile());
    await store.put("k", 0, undefined);

    const results = await Promise.all([1, 2, 3].map((n) => store.put("k", n, 1)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
