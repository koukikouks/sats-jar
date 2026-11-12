import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "near-api-js";
import { fileStore } from "./file-store.ts";
import { createBackend } from "./http.ts";
import type { Chain } from "./chain.ts";

const APP = "sats-jar-app.testnet";
// T07's NEAR vector ("abandon x11 about" on m/44'/397'/0').
const DEVICE_KEY = "ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25";
// SHA-256 of that key's 32 raw bytes, computed with Python's hashlib (first 20 hex chars).
const DEVICE_ACCOUNT = `572dd46d19e80993d9c4.${APP}`;
// A second ed25519 device key (32 bytes, checked with Python).
const OTHER_KEY = "ed25519:H9k5eiU4xEhWsAvh2vJvNGyM3nGBBJmUNsL4wQnW6Lim";
// NEAR's account-id rule (nomicon, Account ID), checked independently of our derivation.
const ACCOUNT_ID_RULE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A chain that remembers the accounts it made, as the sponsor's transactions would. */
function fakeChain(): Chain & { accounts: Map<string, string>; jars: Map<string, string[]> } {
  const accounts = new Map<string, string>();
  const jars = new Map<string, string[]>();
  return {
    accounts,
    jars,
    async jarGuardians(jarId) {
      return jars.get(jarId);
    },
    async createAccount(accountId, publicKey) {
      if (accounts.has(accountId)) return "exists";
      accounts.set(accountId, publicKey);
      return "created";
    },
  };
}

function setup() {
  const chain = fakeChain();
  const file = join(mkdtempSync(join(tmpdir(), "sats-jar-backend-")), "drafts.json");
  const store = fileStore(file);
  // The keeper has its own tests (keeper.test.ts); here it does nothing.
  const keeper = { run: async () => ({ startedAt: 0, steps: [] }) };
  const handle = createBackend({ chain, store, appAccount: APP, keeper });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
      new Request(`http://backend.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { chain, call, file };
}

describe("accounts", () => {
  it("a new device key gets its own sub-account of the app account with that key", async () => {
    const { chain, call } = setup();

    const res = await call("POST", "/accounts", { publicKey: DEVICE_KEY });

    expect(res).toEqual({ status: 200, body: { accountId: DEVICE_ACCOUNT } });
    expect(DEVICE_ACCOUNT).toMatch(ACCOUNT_ID_RULE);
    expect(DEVICE_ACCOUNT.length).toBeLessThanOrEqual(64);
    expect([...chain.accounts]).toEqual([[DEVICE_ACCOUNT, DEVICE_KEY]]);
  });

  it.each([
    ["no key after the curve", "ed25519:"],
    ["not base58", "ed25519:0OIl6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25"],
    ["31 bytes", "ed25519:thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE"],
  ])("a malformed key (%s) is refused and creates nothing", async (_case, publicKey) => {
    const { chain, call } = setup();
    // Independent check: near-api-js refuses the same string.
    expect(() => PublicKey.fromString(publicKey)).toThrow();

    const res = await call("POST", "/accounts", { publicKey });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PUBLIC_KEY");
    expect(chain.accounts.size).toBe(0);
  });

  it("a secp256k1 key is refused: device keys are ed25519", async () => {
    const { chain, call } = setup();
    const secp = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
    expect(() => PublicKey.fromString(secp)).not.toThrow();

    const res = await call("POST", "/accounts", { publicKey: secp });

    expect(res.body.code).toBe("INVALID_PUBLIC_KEY");
    expect(chain.accounts.size).toBe(0);
  });
});

describe("drafts", () => {
  it.each([2, 3])("a giver makes %i invite links", async (invites) => {
    const { call } = setup();

    const res = await call("POST", "/drafts", { nickname: "Mia's jar", invites });

    expect(res.status).toBe(201);
    const tokens = res.body.inviteTokens as string[];
    expect(tokens).toHaveLength(invites);
    expect(new Set(tokens).size).toBe(invites);
    expect(typeof res.body.draftId).toBe("string");
    const draft = await call("GET", `/drafts/${res.body.draftId as string}`);
    expect(draft).toEqual({
      status: 200,
      body: {
        nickname: "Mia's jar",
        invites: Array.from({ length: invites }, () => ({ joined: false, accountId: null })),
      },
    });
  });

  it.each([1, 4, 2.5, "2"])("%j invites are refused: a jar has 2 or 3 guardians", async (invites) => {
    const { call } = setup();

    const res = await call("POST", "/drafts", { nickname: "Mia's jar", invites });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_INVITE_COUNT");
  });

  it("an unknown draft is not found", async () => {
    const { call } = setup();

    const res = await call("GET", "/drafts/nope");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DRAFT_NOT_FOUND");
  });
});

async function draftWith(call: ReturnType<typeof setup>["call"], invites = 2) {
  const res = await call("POST", "/drafts", { nickname: "Mia's jar", invites });
  return { draftId: res.body.draftId as string, tokens: res.body.inviteTokens as string[] };
}

describe("invites", () => {
  it("an invite link shows which jar it is for, not yet joined", async () => {
    const { call } = setup();
    const { tokens } = await draftWith(call);

    const res = await call("GET", `/invites/${tokens[0]}`);

    expect(res).toEqual({ status: 200, body: { nickname: "Mia's jar", joined: false } });
  });

  it("an unknown invite link is not found", async () => {
    const { call } = setup();

    const res = await call("GET", "/invites/nope");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("INVITE_NOT_FOUND");
  });

  it("joining with a device key makes the invitee's account and fills the slot", async () => {
    const { chain, call } = setup();
    const { draftId, tokens } = await draftWith(call);

    const res = await call("POST", `/invites/${tokens[1]}/join`, { publicKey: DEVICE_KEY });

    expect(res).toEqual({ status: 200, body: { accountId: DEVICE_ACCOUNT } });
    expect(chain.accounts.get(DEVICE_ACCOUNT)).toBe(DEVICE_KEY);
    expect((await call("GET", `/drafts/${draftId}`)).body.invites).toEqual([
      { joined: false, accountId: null },
      { joined: true, accountId: DEVICE_ACCOUNT },
    ]);
    expect((await call("GET", `/invites/${tokens[1]}`)).body.joined).toBe(true);
  });

  it("a giver who already has an account can join their own link as a guardian", async () => {
    const { chain, call } = setup();
    await call("POST", "/accounts", { publicKey: DEVICE_KEY });
    const { tokens } = await draftWith(call);

    const res = await call("POST", `/invites/${tokens[0]}/join`, { publicKey: DEVICE_KEY });

    expect(res.body).toEqual({ accountId: DEVICE_ACCOUNT });
    expect(chain.accounts.size).toBe(1);
  });

  it("a used invite link is refused", async () => {
    const { call } = setup();
    const { tokens } = await draftWith(call);
    await call("POST", `/invites/${tokens[0]}/join`, { publicKey: DEVICE_KEY });

    const res = await call("POST", `/invites/${tokens[0]}/join`, { publicKey: OTHER_KEY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVITE_USED");
  });

  it("the same device key on a second link of the jar is refused", async () => {
    const { call } = setup();
    const { draftId, tokens } = await draftWith(call);
    await call("POST", `/invites/${tokens[0]}/join`, { publicKey: DEVICE_KEY });

    const res = await call("POST", `/invites/${tokens[1]}/join`, { publicKey: DEVICE_KEY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_GUARDIAN");
    expect((await call("GET", `/drafts/${draftId}`)).body.invites).toEqual([
      { joined: true, accountId: DEVICE_ACCOUNT },
      { joined: false, accountId: null },
    ]);
  });

  it("two people joining one link at once: one joins, the other is refused", async () => {
    const { call } = setup();
    const { tokens } = await draftWith(call);

    const results = await Promise.all(
      [DEVICE_KEY, OTHER_KEY].map((publicKey) => call("POST", `/invites/${tokens[0]}/join`, { publicKey })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("INVITE_USED");
  });

  it("one key joining two links at once: one joins, the other is refused", async () => {
    const { call } = setup();
    const { draftId, tokens } = await draftWith(call);

    const results = await Promise.all(
      tokens.map((t) => call("POST", `/invites/${t}/join`, { publicKey: DEVICE_KEY })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("ALREADY_GUARDIAN");
    const joined = ((await call("GET", `/drafts/${draftId}`)).body.invites as { joined: boolean }[]).filter(
      (i) => i.joined,
    );
    expect(joined).toHaveLength(1);
  });

  it("joining with a malformed key is refused and leaves the link open", async () => {
    const { call } = setup();
    const { tokens } = await draftWith(call);

    const res = await call("POST", `/invites/${tokens[0]}/join`, { publicKey: "ed25519:" });

    expect(res.body.code).toBe("INVALID_PUBLIC_KEY");
    expect((await call("GET", `/invites/${tokens[0]}`)).body.joined).toBe(false);
  });
});

describe("closing a draft once its jar exists", () => {
  async function joinedDraft(call: ReturnType<typeof setup>["call"], invites = 2) {
    const { draftId, tokens } = await draftWith(call, invites);
    const keys = [DEVICE_KEY, OTHER_KEY];
    const accounts: string[] = [];
    for (const [n, key] of keys.entries()) {
      const res = await call("POST", `/invites/${tokens[n]}/join`, { publicKey: key });
      accounts.push(res.body.accountId as string);
    }
    return { draftId, tokens, accounts };
  }

  it("a jar with the joined guardians clears the draft and its links", async () => {
    const { chain, call } = setup();
    const { draftId, tokens, accounts } = await joinedDraft(call);
    chain.jars.set("7", [...accounts].reverse());

    const res = await call("POST", `/drafts/${draftId}/jar`, { jarId: "7" });

    expect(res.status).toBe(200);
    expect((await call("GET", `/drafts/${draftId}`)).body.code).toBe("DRAFT_NOT_FOUND");
    for (const t of tokens) {
      expect((await call("GET", `/invites/${t}`)).body.code).toBe("INVITE_NOT_FOUND");
    }
  });

  it("a link left unjoined does not keep the draft once the jar exists", async () => {
    const { chain, call } = setup();
    const { draftId, accounts } = await joinedDraft(call, 3);
    chain.jars.set("7", accounts);

    expect((await call("POST", `/drafts/${draftId}/jar`, { jarId: "7" })).status).toBe(200);
  });

  it("a jar with a guardian who never joined this draft is refused and the draft kept", async () => {
    const { chain, call } = setup();
    const { draftId, accounts } = await joinedDraft(call);
    chain.jars.set("7", [accounts[0] ?? "", "stranger.testnet"]);

    const res = await call("POST", `/drafts/${draftId}/jar`, { jarId: "7" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GUARDIANS_DIFFER");
    expect((await call("GET", `/drafts/${draftId}`)).status).toBe(200);
  });

  it("a jar that does not exist is refused and the draft kept", async () => {
    const { call } = setup();
    const { draftId } = await joinedDraft(call);

    const res = await call("POST", `/drafts/${draftId}/jar`, { jarId: "99" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("JAR_NOT_FOUND");
    expect((await call("GET", `/drafts/${draftId}`)).status).toBe(200);
  });
});

describe("what the backend keeps", () => {
  it("the stored drafts hold no draft id or invite token, only their hashes", async () => {
    const { call, file } = setup();
    const { draftId, tokens } = await draftWith(call, 3);
    await call("POST", `/invites/${tokens[0]}/join`, { publicKey: DEVICE_KEY });

    const stored = readFileSync(file, "utf8");

    for (const secret of [draftId, ...tokens]) expect(stored).not.toContain(secret);
    expect(stored).toContain(DEVICE_ACCOUNT);
    expect(stored).not.toContain(DEVICE_KEY.slice("ed25519:".length));
  });
});

describe("requests", () => {
  it("a body that is not a JSON object is refused", async () => {
    const { call } = setup();

    const res = await call("POST", "/drafts", "not an object");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("an unknown endpoint is not found", async () => {
    const { call } = setup();

    expect((await call("GET", "/accounts")).body.code).toBe("NOT_FOUND");
  });

  it("a chain failure comes back as a plain error without its details", async () => {
    const { chain, call } = setup();
    chain.createAccount = async () => {
      throw new Error("RPC said: sponsor ed25519:secret-looking detail");
    };

    const res = await call("POST", "/accounts", { publicKey: DEVICE_KEY });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
    expect(JSON.stringify(res.body)).not.toContain("RPC said");
  });
});
