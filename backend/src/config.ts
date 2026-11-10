/** Settings for the hosted backend, read once at startup. Secrets live only here, never on disk. */
export type Config = {
  /** The app account: parent of every person's sub-account, and the sponsor that funds them. */
  sponsorAccountId: string;
  sponsorPrivateKey: string;
  /** The jar contract; switching to the locked contract is this setting alone. */
  contractAccountId: string;
  draftsFile: string;
  port: number;
};

const NAMES = [
  "SPONSOR_ACCOUNT_ID",
  "SPONSOR_PRIVATE_KEY",
  "CONTRACT_ACCOUNT_ID",
  "DRAFTS_FILE",
  "PORT",
] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing settings: ${missing.join(", ")}`);
  const value = (name: (typeof NAMES)[number]) => env[name] ?? "";
  return {
    sponsorAccountId: value("SPONSOR_ACCOUNT_ID"),
    sponsorPrivateKey: value("SPONSOR_PRIVATE_KEY"),
    contractAccountId: value("CONTRACT_ACCOUNT_ID"),
    draftsFile: value("DRAFTS_FILE"),
    port: Number(value("PORT")),
  };
}
