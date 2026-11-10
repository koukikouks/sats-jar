// Test-only: replays live responses recorded with curl (src/fixtures), so the default suite never
// touches the network. An unrecorded request throws.
import { readFileSync } from "node:fs";

export interface Exchange {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}

export interface Fixture {
  recorded_at: string;
  note: string;
  exchanges: Exchange[];
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

/** T06's record of the live money moment: the oracle for hashes, outcomes and amounts. */
export function evidence(): Evidence {
  return JSON.parse(
    readFileSync(new URL("../../../evidence/dev-money-moment.json", import.meta.url), "utf8"),
  ) as Evidence;
}

export interface Evidence {
  contract: string;
  steps: {
    step: string;
    near_tx?: string;
    btc_tx?: string;
    explorer?: string;
    ok?: boolean;
    error?: string | null;
    block_height?: number;
    fee?: number;
  }[];
  deploy: { account_transactions: { near_tx: string }[] };
  ledger: Record<string, number>;
  topup?: { txid: string };
  jar: { view: Record<string, unknown> };
}

export function replayFetch(...fixtures: Fixture[]): typeof fetch {
  const exchanges = fixtures.flatMap((f) => f.exchanges);
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const key = canonical({ method, url, body: normalise(body) });
    const hit = exchanges.find(
      (e) => canonical({ method: e.request.method, url: e.request.url, body: normalise(e.request.body) }) === key,
    );
    if (!hit) throw new Error(`unrecorded request: ${method} ${url} ${JSON.stringify(body)}`);
    const text = typeof hit.response.body === "string" ? hit.response.body : JSON.stringify(hit.response.body);
    return new Response(text, { status: hit.response.status });
  };
}

// View-call args are compared decoded, so key order inside args_base64 does not matter.
function normalise(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  const params = (body as { params?: { args_base64?: string } }).params;
  if (params?.args_base64 === undefined) return body;
  return { ...body, params: { ...params, args_base64: JSON.parse(atob(params.args_base64)) } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
