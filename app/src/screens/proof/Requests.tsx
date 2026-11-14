import type { JarProof } from "@sats-jar/proof";
import { useQuery } from "@tanstack/react-query";
import { useProof } from "../../services.tsx";
import { when } from "../../ui/format.ts";
import { Reading } from "../../ui/messages.tsx";
import { Unreadable } from "./Unreadable.tsx";
import { action, senderRole, withoutAccounts } from "./words.ts";

/** Every NEAR request about the jar, refusals with their reasons, oldest first (stories 38, 70). */
export function Requests(props: { jar: JarProof }) {
  const proof = useProof();
  const { jar } = props;
  const requests = useQuery({ queryKey: ["proof", "requests", jar.jarId], queryFn: () => proof.nearTransactions(jar.jarId) });
  return (
    <section className="panel">
      <h2>Requests</h2>
      <p>Every request about this jar, oldest first, including the ones the rule refused.</p>
      {requests.error && <Unreadable error={requests.error} />}
      {requests.isPending && <Reading />}
      {requests.data?.length === 0 && <p>No requests yet.</p>}
      <ul className="proof-list">
        {(requests.data ?? []).map((request) => (
          <li key={request.hash}>
            <strong>
              {action(request.method)} by {senderRole(jar, request.signer)}
            </strong>
            {request.ok ? <span className="done">Done</span> : <span className="refusal">Refused: {withoutAccounts(jar, request.refusal?.reason ?? "")}</span>}
            <span className="proof-meta">{when(request.time)}</span>
            <a className="proof-line proof-meta" href={request.explorerUrl} target="_blank" rel="noreferrer">
              {request.hash} ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
