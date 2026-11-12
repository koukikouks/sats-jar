// Runs against NEAR testnet with the sponsor's key; skipped unless LIVE_TESTNET=1.
//   LIVE_TESTNET=1 SPONSOR_ACCOUNT_ID=... SPONSOR_PRIVATE_KEY=... pnpm vitest run backend/src/chain.live.test.ts
import { setTimeout as sleep } from "node:timers/promises";
import { createDeviceKey } from "@sats-jar/device-keys";
import { describe, expect, it } from "vitest";
import { accountIdFor } from "./accounts.ts";
import { nearChain } from "./chain.ts";
import { NEAR_RPC } from "./rpc.ts";

const live = process.env.LIVE_TESTNET === "1";

/** A raw RPC query, independent of near-api-js, so the chain itself is the oracle. */
async function query(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (!body.result) throw new Error(`RPC query failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The account's keys once final; final views trail the transaction by a few blocks. */
async function finalKeys(accountId: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    // Before the account is final the RPC answers an empty list or an unknown-account error.
    const keys = await query({ request_type: "view_access_key_list", account_id: accountId })
      .then((r) => r.keys as unknown[])
      .catch(() => []);
    if (keys.length > 0) return keys;
    await sleep(2_000);
  }
  return [];
}

describe.skipIf(!live)("nearChain on testnet", () => {
  const chain = () =>
    nearChain({
      sponsorAccountId: process.env.SPONSOR_ACCOUNT_ID ?? "",
      sponsorPrivateKey: process.env.SPONSOR_PRIVATE_KEY ?? "",
      contractAccountId: "sats-jar-dev.testnet",
    });

  it("an account it makes has exactly one key, the device's, and 0.25 NEAR", { timeout: 90_000 }, async () => {
    const device = createDeviceKey();
    const accountId = accountIdFor(device.publicKey, process.env.SPONSOR_ACCOUNT_ID ?? "");

    expect(await chain().createAccount(accountId, device.publicKey)).toBe("created");

    expect(await finalKeys(accountId)).toEqual([
      { public_key: device.publicKey, access_key: expect.objectContaining({ permission: "FullAccess" }) },
    ]);
    const account = await query({ request_type: "view_account", account_id: accountId });
    expect(account.amount).toBe("250000000000000000000000");

    expect(await chain().createAccount(accountId, device.publicKey)).toBe("exists");
    const after = await query({ request_type: "view_account", account_id: accountId });
    expect(after.amount).toBe("250000000000000000000000");
  });

  it("two requests for the same new key at once: one creates, the other finds it", { timeout: 90_000 }, async () => {
    const device = createDeviceKey();
    const accountId = accountIdFor(device.publicKey, process.env.SPONSOR_ACCOUNT_ID ?? "");

    // One chain serves every request, as in the backend, so the two get different nonces.
    const shared = chain();
    const results = await Promise.all([1, 2].map(() => shared.createAccount(accountId, device.publicKey)));

    expect(results.sort()).toEqual(["created", "exists"]);
    expect(await finalKeys(accountId)).toHaveLength(1);
  });

  it("reads a jar's guardians from the contract", { timeout: 30_000 }, async () => {
    // Jar 1 on the dev contract, created in T06 (evidence/dev-money-moment.json).
    expect(await chain().jarGuardians("1")).toEqual([
      "guardian-a.sats-jar-dev.testnet",
      "guardian-b.sats-jar-dev.testnet",
    ]);
    expect(await chain().jarGuardians("999999")).toBeUndefined();
  });
});
