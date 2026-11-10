import { Account, JsonRpcProvider, KeyPairSigner, PublicKey, actions, type KeyPairString } from "near-api-js";
import { AccountAlreadyExistsActionError, AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { NEAR_RPC } from "./rpc.ts";

/** What the backend needs from NEAR. The live adapter is `nearChain`; tests use a fake. */
export interface Chain {
  /**
   * Creates `accountId` with `publicKey` as its only full-access key and a little NEAR from
   * the sponsor. An account that already exists is left alone ("exists").
   */
  createAccount(accountId: string, publicKey: string): Promise<"created" | "exists">;
  /** The guardians of jar `jarId` on the configured contract, or undefined if there is no such jar. */
  jarGuardians(jarId: string): Promise<string[] | undefined>;
}

/**
 * Each person's funding (0.25 NEAR). Every account is funded; no relaying (ADR 0009). A call
 * needs its prepaid gas up front at 0.001 NEAR per Tgas (measured on testnet, 10x the burn
 * price; the unused part comes back), so this covers one call of up to about 240 Tgas, enough
 * for a holder's spend of 10 inputs (10 x 15 + 50 Tgas). Burnt fees are small: the giver's
 * `create_jar` keeps 0.0089 NEAR for storage and burns about 0.0007 NEAR (T06).
 */
const FUNDING = 250_000_000_000_000_000_000_000n;

export function nearChain(settings: {
  sponsorAccountId: string;
  sponsorPrivateKey: string;
  contractAccountId: string;
}): Chain {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const sponsor = new Account(
    settings.sponsorAccountId,
    provider,
    KeyPairSigner.fromSecretKey(settings.sponsorPrivateKey as KeyPairString),
  );

  async function exists(accountId: string): Promise<boolean> {
    try {
      await provider.viewAccount({ accountId });
      return true;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return false;
      throw error;
    }
  }

  return {
    async createAccount(accountId, publicKey) {
      if (await exists(accountId)) return "exists";
      try {
        // Exactly one AddKey, the device's: the sponsor never keeps a key on the account.
        await sponsor.signAndSendTransaction({
          receiverId: accountId,
          actions: [
            actions.createAccount(),
            actions.transfer(FUNDING),
            actions.addFullAccessKey(PublicKey.fromString(publicKey)),
          ],
        });
        return "created";
      } catch (error) {
        // Another request for the same key won the race.
        if (error instanceof AccountAlreadyExistsActionError) return "exists";
        throw error;
      }
    },

    async jarGuardians(jarId) {
      // `get_jar` answers null for an unknown jar; optional chaining covers it.
      const jar = await provider.callFunction<{ create_args: { guardians: string[] } }>({
        contractId: settings.contractAccountId,
        method: "get_jar",
        args: { jar_id: jarId },
      });
      return jar?.create_args.guardians ?? undefined;
    },
  };
}
