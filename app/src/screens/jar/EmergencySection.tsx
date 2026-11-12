import type { JarStatus, Sent } from "@sats-jar/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSdk } from "../../services.tsx";
import { Field } from "../../ui/Field.tsx";
import { sats, when } from "../../ui/format.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";

const now = () => Math.floor(Date.now() / 1000);

/** True once a handover's waiting time has ended: from then no emergency payment runs (story 53a). */
function payoutsStopped(jar: JarStatus): boolean {
  const { handover } = jar;
  if (handover.state === "completing" || handover.state === "done") return true;
  return handover.state === "confirmed" && now() >= handover.delayEndsAt;
}

/** Guardians propose and approve; the giver may cancel during the public waiting time (stories 33–39). */
export function EmergencySection(props: { jar: JarStatus }) {
  const { jar } = props;
  const sdk = useSdk();
  const client = useQueryClient();
  const [sent, setSent] = useState<Sent | null>(null);
  const done = (result: Sent) => {
    setSent(result);
    return client.invalidateQueries({ queryKey: ["jar", jar.jarId] });
  };
  const approve = useMutation({ mutationFn: (id: number) => sdk.emergency.approve(jar.jarId, id), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => sdk.emergency.cancel(jar.jarId), onSuccess: done });
  if (payoutsStopped(jar)) return null;
  const guardian = jar.roles.includes("guardian");
  const giver = jar.roles.includes("giver");
  const { emergency } = jar;
  return (
    <section className="panel">
      <h2>Emergency payment</h2>
      {emergency.state === "none" && !guardian && <p>No emergency payment is proposed.</p>}
      {emergency.state === "open" && (
        <>
          <p>
            {sats(emergency.amount)} proposed. {emergency.approvals} of 2 guardians have approved.
          </p>
          {emergency.delayEndsAt !== null && <p>It goes out after {when(emergency.delayEndsAt)}, unless the giver cancels it.</p>}
          {guardian && !emergency.approvedByMe && emergency.approvals < 2 && (
            <button type="button" disabled={approve.isPending} onClick={() => approve.mutate(emergency.proposalId)}>
              Approve
            </button>
          )}
          {giver && (emergency.delayEndsAt === null || now() < emergency.delayEndsAt) && (
            <button type="button" className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel it
            </button>
          )}
        </>
      )}
      {emergency.state === "cancelled" && <p>The last emergency payment was cancelled.</p>}
      {emergency.state === "executed" && <p>The last emergency payment went out.</p>}
      {emergency.state === "lapsed" && <p>The last emergency proposal lapsed when the handover's waiting time ended.</p>}
      {guardian && emergency.state !== "open" && <Propose jar={jar} onSent={done} />}
      <Refusal error={approve.error ?? cancel.error} />
      <CheckIt url={sent?.explorerUrl} />
    </section>
  );
}

function Propose(props: { jar: JarStatus; onSent: (sent: Sent) => Promise<unknown> }) {
  const { jar } = props;
  const sdk = useSdk();
  const [amount, setAmount] = useState("");
  const propose = useMutation({ mutationFn: () => sdk.emergency.propose(jar.jarId, Number(amount)), onSuccess: props.onSent });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    propose.mutate();
  };
  // The contract's waiting times: 30 days, or 30 minutes under demo timing.
  const wait = jar.demoTiming ? "30 minutes" : "30 days";
  return (
    <form onSubmit={submit}>
      <Field
        label="Amount (sats)"
        hint={`At most ${sats(3 * jar.cap)}. Two guardians must approve, then there's a public waiting time of ${wait} when the giver can cancel it.`}
      >
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Refusal error={propose.error} />
      <button type="submit" disabled={propose.isPending || amount === ""}>
        Propose
      </button>
    </form>
  );
}
