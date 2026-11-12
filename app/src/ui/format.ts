import { FULL_PERIOD, type Role } from "@sats-jar/sdk";

/** "20,000 sats". */
export const sats = (amount: number): string => `${amount.toLocaleString("en-US")} sats`;

/** A moment as a person reads it: "12 Nov 2026, 14:05". */
export const when = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** A day: "1 May 2040". In UTC, because a chosen unlock date is midnight UTC of that day. */
export const day = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** A period's length: "30 days", "10 minutes". */
export function period(seconds: number): string {
  if (seconds === FULL_PERIOD) return "30 days";
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

const ROLE_LINES: Record<Role, string> = {
  giver: "You gave this jar",
  guardian: "You're a guardian",
  holder: "You hold this jar",
  child: "You've claimed this jar",
};

/** How this device's person relates to a jar, as one line. */
export const roleLine = (roles: Role[]): string => roles.map((role) => ROLE_LINES[role]).join(" · ");

/**
 * A re-homing's progress: "2 coins still to go". The status gives only the coins not yet moved
 * and confirmed (`coinsLeft`), not a total, so progress is counted down.
 */
export const coinsStillToGo = (coinsLeft: number): string => `${coinsLeft} ${coinsLeft === 1 ? "coin" : "coins"} still to go`;
