import type { JarProof } from "./jar.ts";

/**
 * Whether the signed-in account may open the jar's family-only page: the holder or a guardian.
 *
 * Privacy, not security. Everything that page reads is public chain data anyone can query; the
 * gate only keeps the family's view off the public proof view.
 */
export function isFamily(jar: JarProof, accountId: string | null): boolean {
  return accountId !== null && (accountId === jar.holder || jar.guardians.includes(accountId));
}
