// A stand-in for the App SDK and the proof reader: every method is a recording mock that fails
// loudly until a test gives it an answer, so a screen calling something unexpected shows up.
import type { ProofReader } from "@sats-jar/proof";
import type { SatsJar } from "@sats-jar/sdk";
import { vi, type Mock } from "vitest";

type Mocked<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : Mocked<T[K]> };

export type StandInSdk = Mocked<SatsJar>;
export type StandInProof = Mocked<ProofReader>;

function unstubbed(name: string) {
  return vi.fn((..._args: unknown[]) => {
    throw new Error(`the screen called ${name}, which this test did not expect`);
  });
}

function group<T extends string>(area: string, names: readonly T[]) {
  return Object.fromEntries(names.map((name) => [name, unstubbed(`${area}.${name}`)])) as unknown as Record<T, Mock>;
}

/** A device that is set up and unlocked, with no jars and no drafts, unless a test says otherwise. */
export function standInSdk(): StandInSdk {
  const sdk = {
    device: group("device", ["state", "setUp", "unlock", "lock"] as const),
    invites: group("invites", ["start", "mine", "progress", "preview", "join"] as const),
    jars: group("jars", ["create", "mine", "status", "topUps", "allowances"] as const),
    child: group("child", ["startSetUp", "finishSetUp", "restore", "guardianCode", "claim"] as const),
    handover: group("handover", ["check", "confirm", "cancel"] as const),
    emergency: group("emergency", ["propose", "approve", "cancel"] as const),
    holder: group("holder", ["spend", "receiveCode", "startTransfer", "cancelTransfer", "acceptTransfer"] as const),
    tryIt: group("tryIt", ["earlySpend", "afterHandover", "outsiderApproval"] as const),
  } as unknown as StandInSdk;
  sdk.device.state.mockResolvedValue("unlocked");
  sdk.device.lock.mockImplementation(() => sdk.device.state.mockResolvedValue("locked"));
  sdk.jars.mine.mockResolvedValue([]);
  sdk.invites.mine.mockResolvedValue([]);
  return sdk;
}

export function standInProof(): StandInProof {
  return group("proof", ["jar", "nearTransactions", "bitcoinTransactions"] as const) as unknown as StandInProof;
}
