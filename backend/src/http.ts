import { accountIdFor } from "./accounts.ts";
import type { Chain } from "./chain.ts";
import { drafts } from "./drafts.ts";
import type { Keeper } from "./keeper.ts";
import { Refusal } from "./refusal.ts";
import type { Store } from "./store.ts";

export type Backend = (request: Request) => Promise<Response>;

type Route = {
  method: string;
  path: RegExp;
  run: (params: string[], body: () => Promise<Record<string, unknown>>) => Promise<Response>;
};

/** The backend as one fetch-standard handler: no server, file system or timers inside. */
export function createBackend(deps: {
  chain: Chain;
  store: Store;
  appAccount: string;
  keeper: Keeper;
}): Backend {
  const pending = drafts(deps.store);

  const routes: Route[] = [
    {
      // "Run now": one keeper pass; its report says what it did.
      method: "POST",
      path: /^\/keeper\/run$/,
      run: async () => Response.json(await deps.keeper.run()),
    },
    {
      method: "POST",
      path: /^\/accounts$/,
      run: async (_, body) => {
        const publicKey = text(await body(), "publicKey");
        const accountId = accountIdFor(publicKey, deps.appAccount);
        await deps.chain.createAccount(accountId, publicKey);
        return Response.json({ accountId });
      },
    },
    {
      method: "POST",
      path: /^\/drafts$/,
      run: async (_, body) => {
        const fields = await body();
        const invites = typeof fields.invites === "number" ? fields.invites : Number.NaN;
        const created = await pending.create(text(fields, "nickname"), invites);
        return Response.json(created, { status: 201 });
      },
    },
    {
      method: "GET",
      path: /^\/drafts\/([^/]+)$/,
      run: async ([draftId]) => Response.json(await pending.view(draftId ?? "")),
    },
    {
      method: "POST",
      path: /^\/drafts\/([^/]+)\/jar$/,
      run: async ([draftId], body) => {
        const jarId = text(await body(), "jarId");
        await pending.close(draftId ?? "", await deps.chain.jarGuardians(jarId));
        return Response.json({});
      },
    },
    {
      method: "POST",
      path: /^\/invites\/([^/]+)\/join$/,
      run: async ([inviteToken], body) => {
        const publicKey = text(await body(), "publicKey");
        const accountId = accountIdFor(publicKey, deps.appAccount);
        await pending.join(inviteToken ?? "", accountId, () =>
          deps.chain.createAccount(accountId, publicKey),
        );
        return Response.json({ accountId });
      },
    },
    {
      method: "GET",
      path: /^\/invites\/([^/]+)$/,
      run: async ([inviteToken]) => Response.json(await pending.viewInvite(inviteToken ?? "")),
    },
  ];

  return async (request) => {
    const { pathname } = new URL(request.url);
    try {
      for (const route of routes) {
        const match = route.path.exec(pathname);
        if (match && route.method === request.method) {
          return await route.run(match.slice(1), () => jsonBody(request));
        }
      }
      throw new Refusal(404, "NOT_FOUND", "no such endpoint");
    } catch (error) {
      if (error instanceof Refusal) {
        return Response.json({ code: error.code, message: error.message }, { status: error.status });
      }
      // Chain and store failures stay in the host's log; the caller gets a plain retryable error.
      console.error(error);
      return Response.json(
        { code: "INTERNAL", message: "something went wrong; try again" },
        { status: 500 },
      );
    }
  };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => undefined);
  if (typeof body !== "object" || body === null) throw badRequest("the body must be a JSON object");
  return body as Record<string, unknown>;
}

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string") throw badRequest(`${name} must be a string`);
  return value;
}

const badRequest = (message: string) => new Refusal(400, "BAD_REQUEST", message);
