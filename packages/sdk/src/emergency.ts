import type { Emergency } from "./api.ts";
import { unavailable } from "./refusals.ts";
import { CALL_GAS, ONE_YOCTO, type Write } from "./writes.ts";

/** Guardians propose and approve an emergency payment; the giver may cancel it (stories 33-39). */
export function emergency(write: Write): Emergency {
  return {
    async propose(jarId, amount) {
      const { value, explorerUrl } = await write({
        method: "propose_emergency",
        args: { jar_id: jarId, amount: String(amount) },
        gas: CALL_GAS,
        deposit: ONE_YOCTO,
      });
      if (typeof value !== "number") throw unavailable(); // the contract returns the u32 id
      return { proposalId: value, explorerUrl };
    },

    async approve(jarId, proposalId) {
      const { explorerUrl } = await write({
        method: "approve_emergency",
        args: { jar_id: jarId, proposal_id: proposalId },
        gas: CALL_GAS,
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },

    async cancel(jarId) {
      const { explorerUrl } = await write({ method: "cancel_emergency", args: { jar_id: jarId }, gas: CALL_GAS, deposit: ONE_YOCTO });
      return { explorerUrl };
    },
  };
}
