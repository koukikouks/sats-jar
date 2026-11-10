import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const FULL = {
  SPONSOR_ACCOUNT_ID: "sats-jar-app.testnet",
  SPONSOR_PRIVATE_KEY: "ed25519:not-a-real-secret-value",
  CONTRACT_ACCOUNT_ID: "sats-jar-dev.testnet",
  DRAFTS_FILE: "/var/data/drafts.json",
  PORT: "8787",
  KEEPER_ACCOUNT_ID: "keeper.sats-jar-app.testnet",
  KEEPER_PRIVATE_KEY: "ed25519:not-a-real-keeper-secret",
};

describe("config", () => {
  it("reads every setting from the environment", () => {
    expect(loadConfig(FULL)).toEqual({
      sponsorAccountId: "sats-jar-app.testnet",
      sponsorPrivateKey: "ed25519:not-a-real-secret-value",
      contractAccountId: "sats-jar-dev.testnet",
      draftsFile: "/var/data/drafts.json",
      port: 8787,
      keeperAccountId: "keeper.sats-jar-app.testnet",
      keeperPrivateKey: "ed25519:not-a-real-keeper-secret",
    });
  });

  it("names every missing setting and never repeats a value", () => {
    const { CONTRACT_ACCOUNT_ID: _c, PORT: _p, KEEPER_PRIVATE_KEY: _k, ...partial } = FULL;

    let message = "";
    try {
      loadConfig(partial);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("CONTRACT_ACCOUNT_ID");
    expect(message).toContain("PORT");
    expect(message).toContain("KEEPER_PRIVATE_KEY");
    expect(message).not.toContain("SPONSOR_PRIVATE_KEY");
    expect(message).not.toContain("not-a-real-secret-value");
    expect(message).not.toContain("KEEPER_ACCOUNT_ID");
  });
});
