import type { Jars, SatsJarConfig, SatsJarPartOne } from "./api.ts";
import { backendClient } from "./backend-client.ts";
import { creator } from "./create.ts";
import { deviceKeys } from "./device.ts";
import { draftStore, invites } from "./invites.ts";
import { jarReader } from "./jar-status.ts";
import { near } from "./near.ts";

/** The SDK over a given `fetch`; `createSatsJar` passes the browser's. */
export function createApp(config: SatsJarConfig, http: typeof fetch): SatsJarPartOne {
  const keys = deviceKeys(config.storage);
  const backend = backendClient(http, config.backendUrl);
  const drafts = draftStore(config.storage);
  const chain = near(http, config.contract);
  const reader = jarReader({ http, near: chain, contract: config.contract, me: keys.accountId });
  const jars: Jars = {
    create: creator({ near: chain, backend, drafts, keys, contract: config.contract }),
    ...reader,
  };
  return { device: keys.device, invites: invites(backend, drafts, keys), jars };
}

/** The SDK the screens call. Part 1 (#21); part 2 (#22) widens it to `SatsJar`. */
export function createSatsJar(config: SatsJarConfig): SatsJarPartOne {
  return createApp(config, globalThis.fetch.bind(globalThis));
}
