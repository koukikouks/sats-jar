import type { JarStatus, Sent } from "@sats-jar/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSdk } from "../../services.tsx";
import { Copy } from "../../ui/Copy.tsx";
import { Field } from "../../ui/Field.tsx";
import { CheckIt, Refusal } from "../../ui/messages.tsx";

/** The holder after handover: send the jar's Bitcoin, or give the jar to someone (stories 55–58). */
export function HolderSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const sdk = useSdk();
  const client = useQueryClient();
  const [sent, setSent] = useState<Sent | null>(null);
  const done = (result: Sent) => {
    setSent(result);
    return client.invalidateQueries({ queryKey: ["jar", jar.jarId] });
  };
  const cancel = useMutation({ mutationFn: () => sdk.holder.cancelTransfer(jar.jarId), onSuccess: done });
  if (!jar.roles.includes("holder") || jar.handover.state !== "done") return null;
  const { transfer } = jar;
  const acceptLink = `${window.location.origin}/jar/${jar.jarId}/accept`;
  return (
    <section className="panel">
      {transfer.state === "none" && (
        <>
          <Spend jarId={jar.jarId} onSent={done} />
          <StartTransfer jarId={jar.jarId} onSent={done} />
        </>
      )}
      {transfer.state === "offered" && (
        <>
          <h2>Give the jar to someone</h2>
          <p>Send them this link so they can accept:</p>
          <p className="mono">{acceptLink}</p>
          <Copy text={acceptLink} label="Copy link" />
          <button type="button" className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel the transfer
          </button>
        </>
      )}
      {transfer.state === "moving" && (
        <p>
          The jar's Bitcoin is moving to the new holder's key: {transfer.coinsToMove - transfer.coinsLeft} of {transfer.coinsToMove}{" "}
          coins moved.
        </p>
      )}
      <Refusal error={cancel.error} />
      <CheckIt url={sent?.explorerUrl} />
    </section>
  );
}

function Spend(props: { jarId: string; onSent: (sent: Sent) => Promise<unknown> }) {
  const sdk = useSdk();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  // No fee rate: the SDK uses the explorer's half-hour recommendation.
  const spend = useMutation({ mutationFn: () => sdk.holder.spend(props.jarId, { to: to.trim(), amount: Number(amount) }), onSuccess: props.onSent });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    spend.mutate();
  };
  return (
    <form onSubmit={submit}>
      <h2>Send Bitcoin</h2>
      <Field label="To (Bitcoin address)">
        <input placeholder="tb1q…" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Field label="Amount (sats)" hint="The Bitcoin fee comes out of the jar.">
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Refusal error={spend.error} />
      <button type="submit" disabled={spend.isPending || to.trim() === "" || amount === ""}>
        Send
      </button>
    </form>
  );
}

function StartTransfer(props: { jarId: string; onSent: (sent: Sent) => Promise<unknown> }) {
  const sdk = useSdk();
  const [code, setCode] = useState("");
  const start = useMutation({ mutationFn: () => sdk.holder.startTransfer(props.jarId, code.trim()), onSuccess: props.onSent });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate();
  };
  return (
    <form onSubmit={submit}>
      <h2>Give the jar to someone</h2>
      <Field label="Their receive code" hint="They get it on their own phone, under 'Someone is giving me a jar'.">
        <input autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Refusal error={start.error} />
      <button type="submit" disabled={start.isPending || code.trim() === ""}>
        Start the transfer
      </button>
    </form>
  );
}
