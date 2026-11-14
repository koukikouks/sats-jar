import type { JarStatus } from "@sats-jar/sdk";
import { day, when } from "../../ui/format.ts";

/** Now, read at each render; the jar page re-reads the chain every 10 seconds. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * No allowance or emergency payment goes out: the handover's waiting time has ended, or the jar's
 * Bitcoin is moving to the child or has moved (story 53a, the contract's payouts_stopped).
 */
export function payoutsStopped(jar: JarStatus): boolean {
  const { handover } = jar;
  if (handover.state === "completing" || handover.state === "done") return true;
  return handover.state === "confirmed" && nowSeconds() >= handover.delayEndsAt;
}

/** A jar's date as its family reads it: local date and time on a demo-timing jar, whose waits are minutes; the day otherwise. */
export const moment = (jar: JarStatus, unixSeconds: number): string => (jar.demoTiming ? when(unixSeconds) : day(unixSeconds));
