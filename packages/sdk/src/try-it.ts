import { SatsJarRefusal, type TriedRefusal, type TryIt } from "./api.ts";
import { unavailable } from "./refusals.ts";
import { CALL_GAS, ONE_YOCTO, type Write } from "./writes.ts";

/** BIP-84's published test address: "any other address" a try-it spend names as its payee. */
const TRY_IT_PAYEE = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";

/**
 * Real refused transactions from the caller's own account (stories 36, 40a, 52). The arguments
 * can never move anything, from any device: a spend at fee rate 0 is refused even from the
 * holder's own account (spend.rs: TRANSFER_OPEN, INVALID_ADDRESS, AMOUNT_BELOW_DUST or
 * FEE_TOO_LOW), and proposal 0 is never a proposal's id (ids start at 1), so even a guardian's
 * approval of it counts toward nothing.
 */
export function tryIt(write: Write): TryIt {
  async function refused(method: string, args: Record<string, unknown>): Promise<TriedRefusal> {
    try {
      await write({ method, args, gas: CALL_GAS, deposit: ONE_YOCTO });
    } catch (error) {
      if (error instanceof SatsJarRefusal && error.explorerUrl !== null && error.code !== "TRANSACTION_FAILED") {
        return { code: error.code, message: error.message, explorerUrl: error.explorerUrl };
      }
      throw error;
    }
    throw unavailable(); // unreachable with these arguments: the rule always refuses them
  }

  const spend = (jarId: string) => refused("request_spend", { jar_id: jarId, to: TRY_IT_PAYEE, amount: "1000", fee_rate: "0" });

  return {
    earlySpend: spend,
    afterHandover: spend,
    outsiderApproval: (jarId) => refused("approve_emergency", { jar_id: jarId, proposal_id: 0 }),
  };
}
