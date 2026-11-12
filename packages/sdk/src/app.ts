import type { Jars, SatsJar, SatsJarConfig } from "./api.ts";
import { backendClient } from "./backend-client.ts";
import { child } from "./child.ts";
import { creator } from "./create.ts";
import { deviceKeys } from "./device.ts";
import { emergency } from "./emergency.ts";
import { handover } from "./handover.ts";
import { holder } from "./holder.ts";
import { draftStore, invites } from "./invites.ts";
import { jarReader } from "./jar-status.ts";
import { near } from "./near.ts";
import { tryIt } from "./try-it.ts";
import { serial, writer } from "./writes.ts";

/** The SDK over a given `fetch`; `createSatsJar` passes the browser's. */
export function createApp(config: SatsJarConfig, http: typeof fetch): SatsJar {
  const keys = deviceKeys(config.storage);
  const backend = backendClient(http, config.backendUrl);
  const drafts = draftStore(config.storage);
  const chain = near(http, config.contract);
  // Every write this device makes, part 1's included, runs one at a time (no nonce races).
  const run = serial();
  const write = writer({ near: chain, keys, backend, storage: config.storage, contract: config.contract, run });
  const reader = jarReader({ http, near: chain, contract: config.contract, me: keys.accountId });
  const create = creator({ near: chain, backend, drafts, keys, contract: config.contract });
  const jars: Jars = { create: (input) => run(() => create(input)), ...reader };
  const guardianInvites = invites(backend, drafts, keys);
  return {
    device: keys.device,
    invites: { ...guardianInvites, join: (token) => run(() => guardianInvites.join(token)) },
    jars,
    child: child({ keys, backend, write }),
    handover: handover({ near: chain, keys, backend, write }),
    emergency: emergency(write),
    holder: holder({ near: chain, write, http, keys, backend }),
    tryIt: tryIt(write),
  };
}

/** The SDK the screens call. */
export function createSatsJar(config: SatsJarConfig): SatsJar {
  return createApp(config, globalThis.fetch.bind(globalThis));
}
