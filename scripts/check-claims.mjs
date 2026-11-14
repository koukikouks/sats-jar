// Checks the README's headline claims against public NEAR testnet RPC. No keys, no coins, no install.
//   node scripts/check-claims.mjs
const RPC = "https://rpc.testnet.fastnear.com";
const CONTRACT = "sats-jar.testnet";

// Public RPC sometimes drops a request, so each call is tried up to 3 times.
const rpc = async (method, params, attempt = 1) => {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();
    if (body.result === undefined) throw new Error(`NEAR RPC said: ${JSON.stringify(body.error)}`);
    return body.result;
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return rpc(method, params, attempt + 1);
  }
};
const account = (request_type) => rpc("query", { request_type, finality: "final", account_id: CONTRACT });
const view = async (account_id, method_name, args) => {
  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64");
  const { result } = await rpc("query", { request_type: "call_function", finality: "final", account_id, method_name, args_base64 });
  return JSON.parse(Buffer.from(result).toString());
};

console.log("1. access keys on sats-jar.testnet:", (await account("view_access_key_list")).keys.length);
console.log("2. code hash:", (await account("view_account")).code_hash);

const jar = await view(CONTRACT, "get_jar", { jar_id: "1" });
const mpc = await view("v1.signer-prod.testnet", "derived_public_key", { path: "1", predecessor: CONTRACT, domain_id: 0 });
console.log("3. jar 1's Bitcoin key is the MPC network's key for it:", jar.public_key === mpc);

// Testnet proof, row 5: an outsider asked jar 1 to pay another address before handover.
const tx = await rpc("EXPERIMENTAL_tx_status", {
  tx_hash: "A7n7bLAHwctfwy3HrZo9tNiVS2U48ZY9RR2nxg8ViaLo",
  sender_account_id: "2fe04a619d71531c7248.sats-jar-app.testnet",
  wait_until: "FINAL",
});
console.log("4. early spend refused:", JSON.stringify(tx.status.Failure).match(/SPEND_BEFORE_HANDOVER[^"\\]*/)[0]);
