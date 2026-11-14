import { ProofUnavailableError, type ProofSource } from "./errors.ts";

/** GET (no body) or POST JSON; any network error, non-2xx or non-JSON answer is a typed error. */
export async function getJson(http: typeof fetch, source: ProofSource, url: string, body?: unknown): Promise<unknown> {
  let response = await answer(http, source, url, body);
  // FastNEAR answers 429 when one network reads too fast; ask once more after a second.
  if (response.status === 429 && source !== "bitcoin") {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    response = await answer(http, source, url, body);
  }
  if (!response.ok) throw new ProofUnavailableError(source);
  try {
    return await response.json();
  } catch {
    throw new ProofUnavailableError(source);
  }
}

async function answer(http: typeof fetch, source: ProofSource, url: string, body?: unknown): Promise<Response> {
  try {
    return await http(
      url,
      body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ProofUnavailableError(source);
  }
}
