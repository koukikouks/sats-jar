import { KeyPair } from "near-api-js";
import { describe, expect, test } from "vitest";
import { SatsJarRefusal } from "./api.ts";
import { near } from "./near.ts";

// FastNEAR answers a view_access_key query for a key it can't see yet with a success envelope
// that carries an `error` string (recorded live 2026-11-12), not a JSON-RPC error.
const notYet = (publicKey: string) => ({
  jsonrpc: "2.0",
  id: "sdk",
  result: { block_hash: "x", block_height: 1, error: `access key ${publicKey} does not exist while viewing`, logs: [] },
});

/** A node where the device's brand-new key shows at final only after `hiddenFor` queries. */
function node(hiddenFor: number) {
  let keyQueries = 0;
  const http: typeof fetch = async (_, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    if (params.request_type === "view_access_key") {
      keyQueries += 1;
      const body = keyQueries <= hiddenFor ? notYet(params.public_key ?? "") : { result: { nonce: 277394647000000, permission: "FullAccess" } };
      return Response.json(body);
    }
    if (method === "block") return Response.json({ result: { header: { hash: "11111111111111111111111111111111" } } });
    throw new Error(`unexpected ${method}`);
  };
  return { http, keyQueries: () => keyQueries };
}

const call = { method: "create_jar", args: {}, gas: 30_000_000_000_000n, deposit: 0n };

describe("signing from a brand-new device account", () => {
  test("waits for the key to show at final, then signs once", async () => {
    const net = node(2);
    const signer = { accountId: "fresh.sats-jar-app.testnet", secretKey: KeyPair.fromRandom("ed25519").toString() };
    const signed = await near(net.http, "sats-jar-dev.testnet").sign(signer, call);
    expect(signed.signerId).toBe(signer.accountId);
    expect(net.keyQueries()).toBe(3);
  });

  test("a key that never shows ends as UNAVAILABLE, never a raw error", async () => {
    const net = node(Infinity);
    const signer = { accountId: "fresh.sats-jar-app.testnet", secretKey: KeyPair.fromRandom("ed25519").toString() };
    const outcome = await near(net.http, "sats-jar-dev.testnet").sign(signer, call).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SatsJarRefusal);
    expect((outcome as SatsJarRefusal).code).toBe("UNAVAILABLE");
  }, 20_000);
});

test("a view the node fails inside a success envelope ends as UNAVAILABLE", async () => {
  const http: typeof fetch = async () =>
    Response.json({ jsonrpc: "2.0", id: "sdk", result: { block_hash: "x", block_height: 1, error: "wasm execution failed with error: MethodNotFound", logs: [] } });
  const outcome = await near(http, "sats-jar-dev.testnet").view("get_jar", { jar_id: "1" }).catch((e: unknown) => e);
  expect(outcome).toBeInstanceOf(SatsJarRefusal);
  expect((outcome as SatsJarRefusal).code).toBe("UNAVAILABLE");
});
