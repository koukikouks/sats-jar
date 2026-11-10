import type { BackendRefusalCode } from "./api.ts";
import { refusal, unavailable } from "./refusals.ts";

// The backend's refusals a person can meet; its BAD_REQUEST, NOT_FOUND and INTERNAL are ours or
// its own faults and read as UNAVAILABLE (backend/README.md lists them all).
const BACKEND_CODES: readonly BackendRefusalCode[] = [
  "INVITE_NOT_FOUND",
  "INVITE_USED",
  "ALREADY_GUARDIAN",
  "BAD_INVITE_COUNT",
  "INVALID_PUBLIC_KEY",
  "DRAFT_NOT_FOUND",
  "JAR_NOT_FOUND",
  "GUARDIANS_DIFFER",
];

/** The app backend (T15): sponsored accounts and guardian invites. */
export function backendClient(http: typeof fetch, baseUrl: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    let answer: unknown;
    try {
      response = await http(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      answer = await response.json();
    } catch {
      throw unavailable();
    }
    if (response.ok) return answer as T;
    const code = (answer as { code?: unknown } | null)?.code;
    if (BACKEND_CODES.includes(code as BackendRefusalCode)) throw refusal(code as BackendRefusalCode);
    throw unavailable();
  }

  return {
    createAccount: (publicKey: string) =>
      call<{ accountId: string }>("POST", "/accounts", { publicKey }).then((a) => a.accountId),
    createDraft: (nickname: string, invites: number) =>
      call<{ draftId: string; inviteTokens: string[] }>("POST", "/drafts", { nickname, invites }),
    draft: (draftId: string) =>
      call<{ nickname: string; invites: { joined: boolean; accountId: string | null }[] }>(
        "GET",
        `/drafts/${encodeURIComponent(draftId)}`,
      ),
    invite: (token: string) =>
      call<{ nickname: string; joined: boolean }>("GET", `/invites/${encodeURIComponent(token)}`),
    join: (token: string, publicKey: string) =>
      call<{ accountId: string }>("POST", `/invites/${encodeURIComponent(token)}/join`, { publicKey }).then(
        (a) => a.accountId,
      ),
    closeDraft: (draftId: string, jarId: string) =>
      call<unknown>("POST", `/drafts/${encodeURIComponent(draftId)}/jar`, { jarId }),
  };
}

export type BackendClient = ReturnType<typeof backendClient>;
