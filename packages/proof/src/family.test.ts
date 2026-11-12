import { expect, test } from "vitest";
import { createProofReader, isFamily } from "./index.ts";
import { evidence, fixture, replayFetch } from "./test-fetch.ts";

test("opens the family-only page to the holder and the guardians, and to nobody else", async () => {
  const record = evidence();
  const jar = await createProofReader({ contract: record.contract, fetch: replayFetch(fixture("near-views")) }).jar("1");
  // Jar 1 as T06 created it: held by the dev account, with two guardians.
  const created = record.steps.find((s) => s.step === "create_jar") as unknown as {
    sent: { args: { family_account: string; guardians: string[] } };
  };

  expect(isFamily(jar, created.sent.args.family_account)).toBe(true);
  for (const guardian of created.sent.args.guardians) expect(isFamily(jar, guardian)).toBe(true);
  expect(isFamily(jar, "stranger.testnet")).toBe(false);
  expect(isFamily(jar, null)).toBe(false);
});
