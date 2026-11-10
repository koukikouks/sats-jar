import { ProofUnavailableError, type ProofSource } from "./errors.ts";

/** GET (no body) or POST JSON; any network error, non-2xx or non-JSON answer is a typed error. */
export async function getJson(http: typeof fetch, source: ProofSource, url: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await http(
      url,
      body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ProofUnavailableError(source);
  }
  if (!response.ok) throw new ProofUnavailableError(source);
  try {
    return await response.json();
  } catch {
    throw new ProofUnavailableError(source);
  }
}
