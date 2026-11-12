import type { Holder } from "./api.ts";
import type { BackendClient } from "./backend-client.ts";
import { hex } from "./child.ts";
import type { deviceKeys } from "./device.ts";
import type { Near } from "./near.ts";
import { base58check } from "./receive-code.ts";
import { refusal, unavailable } from "./refusals.ts";
import { CALL_GAS, ONE_YOCTO, type Write } from "./writes.ts";

const TGAS = 1_000_000_000_000n;
const MAX_INPUTS = 10; // the contract's payment::MAX_INPUTS
const COINS_PAGE = 100; // get_coins' largest page

interface CoinView {
  value: string;
  status: "confirmed" | "reserved" | "spent";
}

/**
 * What a call that signs `inputs` Bitcoin inputs must attach (signer.rs `required_gas`): 15 Tgas
 * per sign request, 30 for the callback, 20 for the call's own work.
 */
function signingGas(inputs: number): bigint {
  return BigInt(15 * inputs + 50) * TGAS;
}

/** Gas for a payment the contract builds from these free coins: at most 10 inputs. */
const paymentGas = (free: number[]): bigint => signingGas(Math.min(MAX_INPUTS, Math.max(1, free.length)));

/** The holder spends or transfers the jar after handover (stories 55-58a). */
export function holder(deps: {
  near: Near;
  write: Write;
  http: typeof fetch;
  keys: ReturnType<typeof deviceKeys>;
  backend: BackendClient;
}): Holder {
  const { near, write, http, keys, backend } = deps;

  /** The unlocked recovery-phrase keys and their account; an adult's device has none. */
  async function phraseAccount() {
    const unlocked = await keys.keys();
    if (!unlocked.bitcoin) throw refusal("NO_RECOVERY_PHRASE");
    return { bitcoin: unlocked.bitcoin, accountId: await keys.ensureAccount(backend) };
  }

  /** The jar's free coins (proven, in no pending payment), every page. */
  async function freeCoins(jarId: string): Promise<number[]> {
    const free: number[] = [];
    for (let from = 0; ; from += COINS_PAGE) {
      const page = await near.view<CoinView[]>("get_coins", { jar_id: jarId, from_index: from, limit: COINS_PAGE });
      for (const coin of page) if (coin.status === "confirmed") free.push(Number(coin.value));
      if (page.length < COINS_PAGE) return free;
    }
  }


  return {
    async spend(jarId, { to, amount, feeRate }) {
      const rate = feeRate ?? (await recommendedFeeRate(http));
      const { explorerUrl } = await write({
        method: "request_spend",
        args: { jar_id: jarId, to, amount: String(amount), fee_rate: String(rate) },
        gas: paymentGas(await freeCoins(jarId)),
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },

    async receiveCode() {
      const { accountId } = await phraseAccount();
      return base58check.encode(new TextEncoder().encode(accountId));
    },

    async startTransfer(jarId, receiveCode) {
      const payload = await base58check.decode(receiveCode);
      let receiver: string;
      try {
        if (!payload) throw new Error("checksum");
        receiver = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      } catch {
        throw refusal("BAD_RECEIVE_CODE");
      }
      const { explorerUrl } = await write({
        method: "start_transfer",
        args: { jar_id: jarId, receiver },
        gas: CALL_GAS,
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },

    async cancelTransfer(jarId) {
      const { explorerUrl } = await write({ method: "cancel_transfer", args: { jar_id: jarId }, gas: CALL_GAS, deposit: ONE_YOCTO });
      return { explorerUrl };
    },

    async acceptTransfer(jarId, input) {
      const { bitcoin } = await phraseAccount();
      const free = await freeCoins(jarId);
      let rate = input?.feeRate;
      if (rate === undefined) {
        const jar = await near.view<{ witness_script: string } | null>("get_jar", { jar_id: jarId });
        if (!jar) throw refusal("UNKNOWN_JAR");
        rate = Math.min(await recommendedFeeRate(http), highestRehomingRate(free, jar.witness_script.length / 2));
      }
      const { explorerUrl } = await write({
        method: "accept_transfer",
        args: { jar_id: jarId, btc_pubkey: hex(bitcoin.publicKey), fee_rate: String(rate) },
        gas: paymentGas(free),
        deposit: ONE_YOCTO,
      });
      return { explorerUrl };
    },
  };
}

/**
 * A public explorer's half-hour fee rate on testnet3 (stack notes §8): mempool.space, then
 * Blockstream's 3-block estimate; whole sat/vB, rounded up, at least 1.
 */
export async function recommendedFeeRate(http: typeof fetch): Promise<number> {
  const sources: [string, (answer: unknown) => unknown][] = [
    ["https://mempool.space/testnet/api/v1/fees/recommended", (a) => (a as { halfHourFee?: unknown }).halfHourFee],
    ["https://blockstream.info/testnet/api/fee-estimates", (a) => (a as Record<string, unknown>)["3"]],
  ];
  for (const [url, pick] of sources) {
    try {
      const response = await http(url);
      if (!response.ok) continue;
      const rate = pick(await response.json());
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) return Math.max(1, Math.ceil(rate));
    } catch {
      // try the next explorer
    }
  }
  throw unavailable();
}

/**
 * The highest fee rate the contract accepts for the first re-homing batch of these free coins
 * (payment.rs `plan_rehoming`): the fee may be 5% of the value moved, or the cost at 1 sat/vB if
 * that is higher. The batch is the 10 largest coins in one P2WSH output, sized as `payment::vsize`
 * sizes it; the witness script is counted one byte longer than the jar's current one (an older
 * address's locktime push may be longer), so the size is never under the contract's and the rate
 * never over its bound. At 1 sat/vB the bound always holds.
 */
function highestRehomingRate(free: number[], witnessScriptLength: number): number {
  const batch = [...free].sort((a, b) => b - a).slice(0, MAX_INPUTS);
  if (batch.length === 0) return 1;
  const moved = batch.reduce((sum, value) => sum + value, 0);
  const size = rehomingVsize(batch.length, witnessScriptLength + 1);
  const bound = Math.max(Math.floor((moved * 5) / 100), size);
  return Math.max(1, Math.floor(bound / size));
}

/** payment.rs `vsize` for `inputs` jar inputs and one P2WSH output (34-byte script), 72-byte signatures. */
function rehomingVsize(inputs: number, witnessScript: number): number {
  const base = 8 + compactSize(inputs) + compactSize(1) + 41 * inputs + (8 + compactSize(34) + 34);
  const perInput = 1 + (1 + 72) + (1 + 1) + compactSize(witnessScript) + witnessScript;
  const witness = 2 + perInput * inputs;
  return Math.ceil((4 * base + witness) / 4);
}

const compactSize = (n: number): number => (n <= 0xfc ? 1 : n <= 0xffff ? 3 : 5);
