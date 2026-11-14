import type { HandoverCheck, JarStatus, Sent } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSdk } from "../../services.tsx";
import { Copy } from "../../ui/Copy.tsx";
import { coinsStillToGo, when } from "../../ui/format.ts";
import { moment } from "./moments.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";

/** The holder's plain statement after handover (story 54, #25). */
const NOBODY_CAN_RECOVER_HELD =
  "Nobody, Sats Jar included, can recover this jar without your phone or your recovery phrase. Keep your recovery phrase safe.";

/** The handover as it stands, and what this device's person can do about it (stories 41–54). */
export function HandoverSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const sdk = useSdk();
  const client = useQueryClient();
  const [sent, setSent] = useState<Sent | null>(null);
  const done = (result: Sent) => {
    setSent(result);
    return client.invalidateQueries({ queryKey: ["jar", jar.jarId] });
  };
  const cancel = useMutation({ mutationFn: () => sdk.handover.cancel(jar.jarId), onSuccess: done });
  const guardian = jar.roles.includes("guardian");
  const child = jar.roles.includes("child");
  const { handover } = jar;
  return (
    <section className="panel">
      <h2>Handover</h2>
      {handover.state === "none" && <NotYet jar={jar} />}
      {handover.state === "claimed" && (
        <>
          <p>
            The child's phone has claimed the jar. {handover.confirmations} of 2 guardians have confirmed. Unless 2 guardians
            confirm by {when(handover.lapsesAt)}, the claim lapses.
          </p>
          {guardian && !handover.confirmedByMe && (
            <GuardianCheck jarId={jar.jarId} pausesAllowancesEarly={handover.pausesAllowancesEarly} onSent={done} />
          )}
          {child && <ChildCode onCancel={() => cancel.mutate()} cancelling={cancel.isPending} />}
        </>
      )}
      {handover.state === "confirmed" && (
        <>
          <p>
            Two guardians have confirmed. There's a public waiting time until {when(handover.delayEndsAt)}, and the handover happens
            once that has passed and the jar has unlocked. Until the Bitcoin starts moving, any guardian or the child can cancel.
          </p>
          {guardian && (
            <button type="button" className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel the handover
            </button>
          )}
          {child && <ChildCode onCancel={() => cancel.mutate()} cancelling={cancel.isPending} />}
        </>
      )}
      {handover.state === "completing" && (
        <p>The jar's Bitcoin is moving to the child's own key: {coinsStillToGo(handover.coinsLeft)}.</p>
      )}
      {handover.state === "done" && (
        <>
          <p>Handed over on {moment(jar, handover.completedAt)}. The jar is the child's alone, and every adult's access has ended.</p>
          {jar.roles.includes("holder") && <p>{NOBODY_CAN_RECOVER_HELD}</p>}
        </>
      )}
      <Refusal error={cancel.error} />
      <CheckIt url={sent?.explorerUrl} />
    </section>
  );
}

function NotYet(props: { jar: JarStatus }) {
  const { jar } = props;
  const familyAdult = jar.roles.includes("giver") || jar.roles.includes("guardian");
  const link = `${window.location.origin}/jar/${jar.jarId}/set-up`;
  return (
    <>
      <p>The jar unlocks on {moment(jar, jar.unlockAt)}. From then on, the child can take it over.</p>
      {familyAdult && (
        <>
          <p>When it's time, send the child this link to open on their own phone:</p>
          <p className="mono">{link}</p>
          <Copy text={link} label="Copy link" />
        </>
      )}
    </>
  );
}

/** A guardian compares the code read from the chain with the child's phone, then confirms or cancels (stories 46–48). */
function GuardianCheck(props: { jarId: string; pausesAllowancesEarly: boolean; onSent: (sent: Sent) => Promise<unknown> }) {
  const sdk = useSdk();
  const [checked, setChecked] = useState<HandoverCheck | null>(null);
  const check = useMutation({ mutationFn: () => sdk.handover.check(props.jarId), onSuccess: setChecked });
  const confirm = useMutation({
    mutationFn: (claim: HandoverCheck) => sdk.handover.confirm(props.jarId, claim),
    onSuccess: props.onSent,
  });
  const cancel = useMutation({ mutationFn: () => sdk.handover.cancel(props.jarId), onSuccess: props.onSent });
  if (checked === null) {
    return (
      <>
        <Refusal error={check.error} />
        <button type="button" disabled={check.isPending} onClick={() => check.mutate()}>
          Check the child's code
        </button>
      </>
    );
  }
  return (
    <>
      <p>Ask the child to show you the code on their phone. Confirm only if every digit matches.</p>
      <p className="code">{checked.code}</p>
      {props.pausesAllowancesEarly && (
        <p>
          Confirming now ends allowances early: the waiting time ends before the unlock date, and no allowance goes out from then
          until handover.
        </p>
      )}
      <Refusal error={confirm.error ?? cancel.error} />
      <button type="button" disabled={confirm.isPending || cancel.isPending} onClick={() => confirm.mutate(checked)}>
        It matches: confirm
      </button>
      <button type="button" className="secondary" disabled={confirm.isPending || cancel.isPending} onClick={() => cancel.mutate()}>
        Cancel the claim
      </button>
    </>
  );
}

/** The child's phone shows its code to each guardian, and may cancel its own claim (stories 46, 48). */
function ChildCode(props: { onCancel: () => void; cancelling: boolean }) {
  const sdk = useSdk();
  const code = useQuery({ queryKey: ["guardianCode"], queryFn: () => sdk.child.guardianCode() });
  return (
    <>
      <p>Show this code to each guardian, in person:</p>
      {code.data && <p className="code">{code.data}</p>}
      <Refusal error={code.error} />
      <button type="button" className="secondary" disabled={props.cancelling} onClick={props.onCancel}>
        Cancel my claim
      </button>
    </>
  );
}
