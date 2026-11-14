import type { JarStatus, Sent } from "@sats-jar/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useSdk } from "../../services.tsx";
import { Copy } from "../../ui/Copy.tsx";
import { Field } from "../../ui/Field.tsx";
import { coinsStillToGo, sats } from "../../ui/format.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";

/** The holder after handover: send the jar's Bitcoin, or give the jar to someone (stories 55–58). */
export function HolderSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const sdk = useSdk();
  const client = useQueryClient();
  const [sent, setSent] = useState<Sent | null>(null);
  const done = (result: Sent) => {
    setSent(result);
    // Every query: Your jars must show the change too, not only this page.
    return client.invalidateQueries();
  };
  const cancel = useMutation({ mutationFn: () => sdk.holder.cancelTransfer(jar.jarId), onSuccess: done });
  if (!jar.roles.includes("holder") || jar.handover.state !== "done") return null;
  const { transfer } = jar;
  const acceptLink = `${window.location.origin}/jar/${jar.jarId}/accept`;
  return (
    <section className="panel">
      {transfer.state === "none" && (
        <>
          <Spend jarId={jar.jarId} />
          <StartTransfer jarId={jar.jarId} onSent={done} />
        </>
      )}
      {transfer.state === "offered" && (
        <>
          <h2>Give the jar to someone</h2>
          <p>Send them this link. They open it on their phone and press Accept:</p>
          <p className="mono">{acceptLink}</p>
          <Copy text={acceptLink} label="Copy link" />
          <button type="button" className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel the transfer
          </button>
        </>
      )}
      {transfer.state === "moving" && (
        <p>The jar's Bitcoin is moving to the new holder's key: {coinsStillToGo(transfer.coinsLeft)}.</p>
      )}
      <Refusal error={cancel.error} />
      <CheckIt url={sent?.explorerUrl} />
    </section>
  );
}

/** Sending the jar's Bitcoin; its own "on its way" line carries its transaction link. */
function Spend(props: { jarId: string }) {
  const sdk = useSdk();
  const client = useQueryClient();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  // No fee rate: the SDK uses the explorer's half-hour recommendation.
  const spend = useMutation({
    mutationFn: (payment: { to: string; amount: number }) => sdk.holder.spend(props.jarId, payment),
    onSuccess: () => client.invalidateQueries(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    spend.mutate({ to: to.trim(), amount: Number(amount) });
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
      {spend.isSuccess && (
        <p className="done">
          On its way: {sats(spend.variables.amount)} to {spend.variables.to}. <CheckIt url={spend.data?.explorerUrl} />
        </p>
      )}
    </form>
  );
}

function StartTransfer(props: { jarId: string; onSent: (sent: Sent) => Promise<unknown> }) {
  const sdk = useSdk();
  // A receive link arrives as ?give=<code>; it only fills the box, the person still presses Start.
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => searchParams.get("give") ?? "");
  const start = useMutation({ mutationFn: () => sdk.holder.startTransfer(props.jarId, code.trim()), onSuccess: props.onSent });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate();
  };
  return (
    <form onSubmit={submit}>
      <h2>Give the jar to someone</h2>
      <Field label="Their receive code" hint="They find it on their own phone, under 'Someone is giving me a jar'. If they sent you a link, it's already filled in.">
        <input autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Refusal error={start.error} />
      <button type="submit" disabled={start.isPending || code.trim() === ""}>
        Start the transfer
      </button>
    </form>
  );
}
