// The one network table. Testnet only for now; switching to the locked contract is
// VITE_SATS_JAR_CONTRACT=sats-jar.testnet at build time.
export const config = {
  /** The jar contract the SDK and the public record read. */
  contract: import.meta.env.VITE_SATS_JAR_CONTRACT ?? "sats-jar-dev-2.testnet",
  /** The app backend, on the app's own origin (vite.config.ts proxies it). */
  backendUrl: "/api",
} as const;
