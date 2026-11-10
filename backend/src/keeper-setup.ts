// Makes the keeper's account once: `KEEPER_ACCOUNT_ID`, a sub-account of the sponsor, funded by
// the sponsor, whose only key is a function-call key on `CONTRACT_ACCOUNT_ID`. With no
// full-access key and no deposit possible, the keeper can only make calls anyone may make.
//
//   node --env-file=<backend env> backend/src/keeper-setup.ts
//
// The env supplies SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY, KEEPER_ACCOUNT_ID,
// KEEPER_PRIVATE_KEY and CONTRACT_ACCOUNT_ID. No key is printed or written.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { loadConfig } from "./config.ts";
import { NEAR_RPC } from "./rpc.ts";

/** Gas money: a 200 Tgas request_allowance holds 0.2 NEAR up front and burns about 0.002. */
const FUNDING = 1_000_000_000_000_000_000_000_000n; // 1 NEAR

const config = loadConfig({ ...process.env, DRAFTS_FILE: "unused", PORT: "0" });
if (!config.keeperAccountId.endsWith(`.${config.sponsorAccountId}`)) {
  throw new Error("KEEPER_ACCOUNT_ID must be a sub-account of SPONSOR_ACCOUNT_ID");
}
const provider = new JsonRpcProvider({ url: NEAR_RPC });
const sponsor = new Account(
  config.sponsorAccountId,
  provider,
  KeyPairSigner.fromSecretKey(config.sponsorPrivateKey as KeyPairString),
);
const keeperKey = KeyPair.fromString(config.keeperPrivateKey as KeyPairString).getPublicKey();

const response = await sponsor.signAndSendTransaction({
  receiverId: config.keeperAccountId,
  actions: [
    actions.createAccount(),
    actions.transfer(FUNDING),
    // Any method of the contract, no allowance cap (gas is refunded to the account, not the key).
    actions.addFunctionCallAccessKey(keeperKey, config.contractAccountId, []),
  ],
  waitUntil: "FINAL",
});
console.log(`created ${config.keeperAccountId} in ${response.transaction.hash}`);
